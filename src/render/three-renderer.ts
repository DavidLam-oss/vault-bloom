// three.js renderer: GPU-instanced glowing nodes + line-segment edges,
// orbit camera, hover-highlight of neighbours, click-to-open.
//
// Phase 1 keeps visuals deliberately simple (instanced spheres + fog). The
// orb / jellyfish / tendril shaders arrive in Phase 2 behind the same
// GraphRenderer interface.

import {
	BufferAttribute,
	BufferGeometry,
	Color,
	DynamicDrawUsage,
	Fog,
	InstancedMesh,
	LineBasicMaterial,
	LineSegments,
	Matrix4,
	MOUSE,
	MeshBasicMaterial,
	PerspectiveCamera,
	Raycaster,
	Scene,
	SphereGeometry,
	Vector2,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GraphNode, NeuralGraph } from "../data/types";
import { ForceLayout } from "./layout";
import type { GraphRenderer, RendererCallbacks, RendererOptions } from "./renderer";

const BACKGROUND = 0x0b0f17;
const LINK_COLOR = new Color(0x39435c);
const GHOST_EDGE_COLOR = new Color(0x514583);
const HIGHLIGHT_COLOR = new Color(0xffffff);
const NEIGHBOR_COLOR = new Color(0xd8e6ff);
const GHOST_COLOR = new Color(0x8f83e0);

/** instance scale = base + sqrt(degree) * k, clamped */
function nodeScale(degree: number): number {
	return Math.min(9, 0.9 + Math.sqrt(degree) * 1.1);
}

interface Slot {
	mesh: "note" | "ghost";
	local: number;
	node: GraphNode;
}

export class ThreeRenderer implements GraphRenderer {
	private cb: RendererCallbacks;
	private layout = new ForceLayout();

	private host: HTMLElement | null = null;
	private three: WebGLRenderer | null = null;
	private scene: Scene | null = null;
	private camera: PerspectiveCamera | null = null;
	private controls: OrbitControls | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private raf = 0;

	private noteMesh: InstancedMesh | null = null;
	private ghostMesh: InstancedMesh | null = null;
	private edgeLines: LineSegments | null = null;
	private noteBase = new Float32Array(0);
	private ghostBase = new Float32Array(0);
	private dummy = new Matrix4();
	private raycaster = new Raycaster();

	/** layout index -> render slot */
	private slots: Array<Slot | null> = [];
	/** rendered node id -> slot (O(1) hover lookups) */
	private slotById = new Map<string, Slot>();
	/** layout index pairs per edge, for per-frame position sync */
	private edgePairs = new Int32Array(0);
	private neighbors = new Map<string, string[]>();

	private hover: Slot | null = null;
	private hoverNeighbors: Slot[] = [];
	private hoverAnnounced = false;
	private pointerDownAt: Vector2 | null = null;
	private paused = false;
	private inViewport = true;
	private positionsDirty = false;
	private colorModule = new Map<string, Color>();

	constructor(cb: RendererCallbacks) {
		this.cb = cb;
	}

	mount(container: HTMLElement): void {
		const host = document.createElement("div");
		host.className = "nv-canvas-host";
		container.appendChild(host);
		this.host = host;

		const three = new WebGLRenderer({ antialias: true, alpha: false });
		three.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		three.setClearColor(BACKGROUND);
		host.appendChild(three.domElement);
		this.three = three;

		const scene = new Scene();
		scene.fog = new Fog(BACKGROUND, 500, 2600);
		this.scene = scene;

		this.camera = new PerspectiveCamera(55, 1, 0.1, 8000);
		this.camera.position.set(260, 180, 260);

		this.controls = new OrbitControls(this.camera, three.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		// Ecosystem convention (obsidian-3d-graph / 3d-force-graph):
		// left-drag rotates, Cmd/Ctrl+left-drag and right-drag pan.
		// The modifier swap happens per-event in onMouseButtonMode.
		this.controls.mouseButtons = {
			LEFT: MOUSE.ROTATE,
			MIDDLE: MOUSE.DOLLY,
			RIGHT: MOUSE.PAN,
		};

		this.bindPointerEvents();

		this.resizeObserver = new ResizeObserver(() => this.applySize());
		this.resizeObserver.observe(host);

		// Stop rendering while the view sits in a background tab or folded pane.
		this.intersectionObserver = new IntersectionObserver((entries) => {
			this.inViewport = entries[0]?.isIntersecting ?? true;
		});
		this.intersectionObserver.observe(host);

		this.applySize();
		this.startLoop();
	}

	setData(graph: NeuralGraph, options: RendererOptions): void {
		if (!this.scene) return;

		// Visible subgraph per settings.
		const visibleIds = new Set<string>();
		for (const node of graph.nodes) {
			if (node.kind === "note") {
				if (node.degree > 0 || options.showOrphans) visibleIds.add(node.id);
			} else if (node.kind === "ghost" && options.showGhosts) {
				visibleIds.add(node.id);
			}
		}

		this.colorModule.clear();
		for (const def of graph.modules) {
			this.colorModule.set(def.id, new Color(def.color));
		}

		const coldStart = this.layout.nodes.length === 0;
		this.layout.update(graph, visibleIds);
		this.layout.pruneCache(visibleIds);

		this.rebuildSceneObjects(graph);
		this.clearHover();
		this.positionsDirty = true;

		if (coldStart) this.fitView(true);
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	/**
	 * Frame the graph. With useEstimate (animated cold start) the camera is
	 * placed for the expected final extent, since the graph grows into place
	 * over the first seconds of the simulation.
	 */
	fitView(useEstimate = false): void {
		if (!this.camera || !this.controls) return;
		let radius = 100;
		if (useEstimate) {
			radius = Math.max(100, this.layout.estimateRadius());
		} else {
			for (const n of this.layout.nodes) {
				const d = Math.hypot(n.x, n.y, n.z);
				if (d > radius) radius = d;
			}
		}
		const dist = radius * 2.1;
		this.camera.position.set(dist * 0.62, dist * 0.46, dist * 0.62);
		this.camera.lookAt(0, 0, 0);
		this.controls.target.set(0, 0, 0);
		const fog = this.scene?.fog;
		if (fog instanceof Fog) {
			fog.near = dist * 0.9;
			fog.far = dist * 5;
		}
		this.controls.update();
	}

	dispose(): void {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.resizeObserver?.disconnect();
		this.intersectionObserver?.disconnect();
		this.controls?.dispose();
		this.disposeSceneObjects();
		this.three?.dispose();
		this.host?.remove();
		this.host = null;
		this.three = null;
		this.scene = null;
		this.camera = null;
		this.controls = null;
	}

	// --- scene construction -------------------------------------------------

	private rebuildSceneObjects(graph: NeuralGraph): void {
		if (!this.scene) return;
		this.disposeSceneObjects();

		const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
		const moduleColor = (id: string): Color =>
			this.colorModule.get(id) ?? new Color(0x888780);

		// Layout order -> mesh slots.
		const noteNodes: GraphNode[] = [];
		const ghostNodes: GraphNode[] = [];
		this.slots = [];
		this.noteSlots = [];
		this.ghostSlots = [];
		this.slotById = new Map();
		for (const sim of this.layout.nodes) {
			const node = nodeById.get(sim.id);
			if (!node) {
				this.slots.push(null);
				continue;
			}
			const slot: Slot = node.kind === "ghost"
				? { mesh: "ghost", local: ghostNodes.length, node }
				: { mesh: "note", local: noteNodes.length, node };
			this.slots.push(slot);
			this.slotById.set(node.id, slot);
			(node.kind === "ghost" ? this.ghostSlots : this.noteSlots).push(slot);
			if (node.kind === "ghost") ghostNodes.push(node);
			else noteNodes.push(node);
		}

		// Note mesh: module color, size by degree, orphans dimmed.
		if (noteNodes.length > 0) {
			const geometry = new SphereGeometry(1, 10, 8);
			const material = new MeshBasicMaterial({ toneMapped: false });
			const mesh = new InstancedMesh(geometry, material, noteNodes.length);
			mesh.instanceMatrix.setUsage(DynamicDrawUsage);
			this.noteBase = new Float32Array(noteNodes.length * 3);
			for (let i = 0; i < noteNodes.length; i++) {
				const node = noteNodes[i];
				const color = moduleColor(node.moduleId).clone();
				if (node.degree === 0) color.multiplyScalar(0.4);
				this.noteBase.set([color.r, color.g, color.b], i * 3);
				mesh.setColorAt(i, color);
			}
			mesh.instanceColor?.setUsage(DynamicDrawUsage);
			this.scene.add(mesh);
			this.noteMesh = mesh;
		}

		// Ghost mesh: small, translucent, knowledge gaps.
		if (ghostNodes.length > 0) {
			const geometry = new SphereGeometry(1, 8, 6);
			const material = new MeshBasicMaterial({
				transparent: true,
				opacity: 0.38,
				depthWrite: false,
				toneMapped: false,
			});
			const mesh = new InstancedMesh(geometry, material, ghostNodes.length);
			mesh.instanceMatrix.setUsage(DynamicDrawUsage);
			this.ghostBase = new Float32Array(ghostNodes.length * 3);
			for (let i = 0; i < ghostNodes.length; i++) {
				this.ghostBase.set([GHOST_COLOR.r, GHOST_COLOR.g, GHOST_COLOR.b], i * 3);
				mesh.setColorAt(i, GHOST_COLOR);
			}
			this.scene.add(mesh);
			this.ghostMesh = mesh;
		}

		// Edges: one LineSegments with per-vertex colors (ghost edges dimmer).
		const edgeCount = this.layout.edges.length;
		if (edgeCount > 0) {
			this.edgePairs = new Int32Array(edgeCount * 2);
			const positions = new Float32Array(edgeCount * 2 * 3);
			const colors = new Float32Array(edgeCount * 2 * 3);
			this.layout.edges.forEach((edge, i) => {
				this.edgePairs[i * 2] = edge.source;
				this.edgePairs[i * 2 + 1] = edge.target;
				const c = edge.kind === "ghost" ? GHOST_EDGE_COLOR : LINK_COLOR;
				for (const slot of [0, 1]) {
					colors.set([c.r, c.g, c.b], (i * 2 + slot) * 3);
				}
			});
			const geometry = new BufferGeometry();
			geometry.setAttribute(
				"position",
				new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage)
			);
			geometry.setAttribute("color", new BufferAttribute(colors, 3));
			const material = new LineBasicMaterial({
				vertexColors: true,
				transparent: true,
				opacity: 0.5,
				depthWrite: false,
			});
			this.edgeLines = new LineSegments(geometry, material);
			this.scene.add(this.edgeLines);
		}

		// Neighbor map for hover highlighting (rendered nodes only).
		this.neighbors.clear();
		for (const edge of graph.edges) {
			if (!this.slotById.has(edge.source) || !this.slotById.has(edge.target)) {
				continue;
			}
			pushNeighbor(this.neighbors, edge.source, edge.target);
			pushNeighbor(this.neighbors, edge.target, edge.source);
		}
	}

	private disposeSceneObjects(): void {
		for (const obj of [this.noteMesh, this.ghostMesh, this.edgeLines]) {
			if (!obj) continue;
			this.scene?.remove(obj);
			obj.geometry.dispose();
			(obj.material as MeshBasicMaterial | LineBasicMaterial).dispose();
		}
		this.noteMesh = null;
		this.ghostMesh = null;
		this.edgeLines = null;
	}

	// --- per-frame sync -----------------------------------------------------

	private syncPositions(): void {
		const { noteMesh, ghostMesh, edgeLines, dummy } = this;
		if (!noteMesh && !ghostMesh) return;

		for (let i = 0; i < this.layout.nodes.length; i++) {
			const sim = this.layout.nodes[i];
			const slot = this.slots[i];
			if (!slot) continue;
			const scale = slot.mesh === "ghost" ? 0.9 : nodeScale(slot.node.degree);
			dummy.makeScale(scale, scale, scale);
			dummy.setPosition(sim.x, sim.y, sim.z);
			const mesh = slot.mesh === "note" ? noteMesh : ghostMesh;
			mesh?.setMatrixAt(slot.local, dummy);
		}
		if (noteMesh) noteMesh.instanceMatrix.needsUpdate = true;
		if (ghostMesh) ghostMesh.instanceMatrix.needsUpdate = true;

		if (edgeLines) {
			const attr = edgeLines.geometry.getAttribute("position") as BufferAttribute;
			const arr = attr.array as Float32Array;
			for (let e = 0; e < this.layout.edges.length; e++) {
				const a = this.layout.nodes[this.edgePairs[e * 2]];
				const b = this.layout.nodes[this.edgePairs[e * 2 + 1]];
				const o = e * 6;
				arr[o] = a.x; arr[o + 1] = a.y; arr[o + 2] = a.z;
				arr[o + 3] = b.x; arr[o + 4] = b.y; arr[o + 5] = b.z;
			}
			attr.needsUpdate = true;
			edgeLines.geometry.computeBoundingSphere();
		}
	}

	// --- interaction ---------------------------------------------------------

	private bindPointerEvents(): void {
		const el = this.three?.domElement;
		if (!el) return;
		// The modifier swap MUST run before OrbitControls' own pointerdown
		// reads mouseButtons. Note that capture listeners on the TARGET
		// element fire in registration order (i.e. after OrbitControls',
		// which registered first), so we bind to the host ANCESTOR where
		// the capture phase genuinely precedes the target.
		const swapHost = this.host ?? el;
		swapHost.addEventListener("pointerdown", this.onMouseButtonMode, true);
		el.addEventListener("pointermove", this.onPointerMove);
		el.addEventListener("pointerdown", this.onPointerDown);
		el.addEventListener("pointerup", this.onPointerUp);
		el.addEventListener("pointerleave", this.onPointerLeave);
	}

	/** Cmd/Ctrl+left-drag pans (obsidian-3d-graph convention); plain left-drag rotates. */
	private onMouseButtonMode = (e: PointerEvent): void => {
		if (!this.controls || e.button !== 0) return;
		this.controls.mouseButtons.LEFT = e.metaKey || e.ctrlKey ? MOUSE.PAN : MOUSE.ROTATE;
	};

	private onPointerDown = (e: PointerEvent): void => {
		this.pointerDownAt = new Vector2(e.clientX, e.clientY);
	};

	private onPointerUp = (e: PointerEvent): void => {
		const down = this.pointerDownAt;
		this.pointerDownAt = null;
		if (!down || !this.hover) return;
		if (down.distanceTo(new Vector2(e.clientX, e.clientY)) > 6) return;
		this.cb.onNodeClick?.(this.hover.node);
	};

	private onPointerLeave = (): void => {
		this.pointerDownAt = null;
		this.clearHover();
	};

	private onPointerMove = (e: PointerEvent): void => {
		const el = this.three?.domElement;
		if (!el || !this.camera) return;
		const rect = el.getBoundingClientRect();
		this.raycaster.setFromCamera(
			new Vector2(
				((e.clientX - rect.left) / rect.width) * 2 - 1,
				-((e.clientY - rect.top) / rect.height) * 2 + 1
			),
			this.camera
		);

		let best: { slot: Slot; dist: number } | null = null;
		// O(1) instanceId -> slot lookup via the per-mesh reverse index.
		for (const [mesh, kind] of [
			[this.noteMesh, "note"],
			[this.ghostMesh, "ghost"],
		] as const) {
			if (!mesh) continue;
			for (const hit of this.raycaster.intersectObject(mesh)) {
				if (hit.instanceId === undefined) continue;
				const slot = this.slotByLocal(kind, hit.instanceId);
				if (!slot) continue;
				if (!best || hit.distance < best.dist) {
					best = { slot, dist: hit.distance };
				}
			}
		}

		if (best?.slot.node.id === this.hover?.node.id) return;
		this.clearHover();
		if (best) this.applyHover(best.slot);
	};

	private slotByLocal(kind: "note" | "ghost", local: number): Slot | null {
		// Reverse index: scan-free lookup via slotById is by id, not local
		// index, so keep a small per-kind array alongside.
		const list = kind === "note" ? this.noteSlots : this.ghostSlots;
		return list[local] ?? null;
	}

	private noteSlots: Slot[] = [];
	private ghostSlots: Slot[] = [];

	private applyHover(pick: Slot): void {
		this.hover = pick;
		this.hoverAnnounced = true;
		this.cb.onNodeHover?.(pick.node);
		this.hoverNeighbors = [];
		for (const id of this.neighbors.get(pick.node.id) ?? []) {
			const slot = this.slotById.get(id);
			if (slot) this.hoverNeighbors.push(slot);
		}
		this.paint([pick], HIGHLIGHT_COLOR);
		this.paint(this.hoverNeighbors, NEIGHBOR_COLOR);
	}

	private clearHover(): void {
		const had = this.hover !== null;
		if (had) {
			this.restore([this.hover as Slot, ...this.hoverNeighbors]);
		}
		this.hover = null;
		this.hoverNeighbors = [];
		if (this.hoverAnnounced) {
			this.hoverAnnounced = false;
			this.cb.onNodeHover?.(null);
		}
	}

	private paint(refs: Slot[], color: Color): void {
		for (const ref of refs) {
			const mesh = ref.mesh === "note" ? this.noteMesh : this.ghostMesh;
			mesh?.setColorAt(ref.local, color);
		}
		if (this.noteMesh?.instanceColor) this.noteMesh.instanceColor.needsUpdate = true;
		if (this.ghostMesh?.instanceColor) this.ghostMesh.instanceColor.needsUpdate = true;
	}

	private restore(refs: Slot[]): void {
		for (const ref of refs) {
			const base = ref.mesh === "note" ? this.noteBase : this.ghostBase;
			if (base.length === 0) continue;
			this.paint([ref], new Color(
				base[ref.local * 3],
				base[ref.local * 3 + 1],
				base[ref.local * 3 + 2]
			));
		}
	}

	// --- loop & resize --------------------------------------------------------

	private applySize(): void {
		if (!this.host || !this.three || !this.camera) return;
		const w = this.host.clientWidth;
		const h = this.host.clientHeight;
		if (w === 0 || h === 0) return;
		this.three.setSize(w, h);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	private startLoop(): void {
		const loop = (): void => {
			this.raf = requestAnimationFrame(loop);
			if (this.paused || !this.inViewport || !this.three) return;
			const hot = !this.layout.isCold() && this.layout.tick();
			if (hot || this.positionsDirty) {
				this.syncPositions();
				this.positionsDirty = false;
			}
			this.controls?.update();
			this.three.render(this.scene!, this.camera!);
		};
		this.raf = requestAnimationFrame(loop);
	}
}

// --- small helpers ----------------------------------------------------------

function pushNeighbor(map: Map<string, string[]>, a: string, b: string): void {
	const list = map.get(a);
	if (list) list.push(b);
	else map.set(a, [b]);
}
