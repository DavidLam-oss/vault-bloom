// three.js renderer: GPU-instanced glowing nodes + line-segment edges,
// orbit camera (zoom-to-cursor), hover-highlight, click-to-fly, dblclick
// to open, module drill-down. Shaders (orb/jellyfish) arrive in Phase 2.

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
	Mesh,
	MOUSE,
	MeshBasicMaterial,
	PerspectiveCamera,
	Raycaster,
	Scene,
	SphereGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GraphNode, NeuralGraph } from "../data/types";
import { CameraFly } from "./camera-tween";
import { boundsOf, expandedVisible, focusMembers, paintFocusDim } from "./focus-paint";
import { FlowLayer, buildFlowSegments } from "./flow-particles";
import { paintSlots, restoreSlots } from "./paint";
import { ForceLayout } from "./layout";
import { nodeScale, type Slot } from "./slot";
import type {
	GraphRenderer,
	HubHoverInfo,
	RendererCallbacks,
	RendererOptions,
} from "./renderer";

const BACKGROUND = 0x0b0f17;
const LINK_COLOR = new Color(0x39435c);
const GHOST_EDGE_COLOR = new Color(0x514583);
const HIGHLIGHT_COLOR = new Color(0xffd47f);
const NEIGHBOR_COLOR = new Color(0xd8e6ff);
const GHOST_COLOR = new Color(0x8f83e0);
const LINK_FLOW_COLOR = new Color(0x9db4e6);
const GHOST_FLOW_COLOR = new Color(0x8677c2);

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
	private hubHover: { moduleId: string; count: number } | null = null;
	private hubAnnounced = false;
	private pointerDownAt: Vector2 | null = null;
	private paused = false;
	private inViewport = true;
	private positionsDirty = false;
	private colorModule = new Map<string, Color>();

	// --- module focus (drill-down) state ------------------------------------
	private graph: NeuralGraph | null = null;
	private options: RendererOptions = { showOrphans: false, showGhosts: false };
	/** visible node ids in the un-focused overview state */
	private overviewVisible = new Set<string>();
	private focusedModule: string | null = null;
	/** clickable cluster-center markers, one per module */
	private hubMeshes: Array<{ mesh: Mesh; moduleId: string; count: number }> = [];
	/** per-vertex edge colors before focus dimming (parallel to edgeLines) */
	private edgeBaseColors: Float32Array | null = null;
	private fly: CameraFly | null = null;
	private flow: FlowLayer | null = null;
	private lastFrame = 0;
	private lastPointer = { x: -1, y: -1 };

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
		this.flow = new FlowLayer(scene);

		this.camera = new PerspectiveCamera(55, 1, 0.1, 8000);
		this.camera.position.set(260, 180, 260);

		this.controls = new OrbitControls(this.camera, three.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		// Zoom toward the POINTER, not screen center: dolly toward a fixed
		// target stops when the camera reaches it (3d-force-graph parity).
		this.controls.zoomToCursor = true;
		this.controls.minDistance = 0.5;
		this.controls.maxDistance = 6000;
		// Ecosystem convention (obsidian-3d-graph / 3d-force-graph):
		// left-drag rotates, Cmd/Ctrl+left-drag and right-drag pan.
		// The modifier swap happens per-event in onMouseButtonMode.
		this.controls.mouseButtons = {
			LEFT: MOUSE.ROTATE,
			MIDDLE: MOUSE.DOLLY,
			RIGHT: MOUSE.PAN,
		};
		this.fly = new CameraFly(this.camera, this.controls);

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

		this.graph = graph;
		this.options = options;
		// A data rebuild always lands back in the overview (predictable).
		if (this.focusedModule) {
			this.focusedModule = null;
			this.cb.onModuleFocus?.(null);
		}

		// Visible subgraph per settings.
		this.overviewVisible = new Set<string>();
		for (const node of graph.nodes) {
			if (node.kind === "note") {
				if (node.degree > 0 || options.showOrphans) {
					this.overviewVisible.add(node.id);
				}
			} else if (node.kind === "ghost" && options.showGhosts) {
				this.overviewVisible.add(node.id);
			}
		}

		this.colorModule.clear();
		for (const def of graph.modules) {
			this.colorModule.set(def.id, new Color(def.color));
		}

		const coldStart = this.layout.nodes.length === 0;
		this.layout.update(graph, this.overviewVisible);
		this.layout.pruneCache(this.overviewVisible);

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
		// "Fit view" during a module focus means: back to the overview.
		if (this.focusedModule) {
			this.clearFocus();
			return;
		}
		let radius = 100;
		if (useEstimate) {
			radius = Math.max(100, this.layout.estimateRadius());
		} else {
			for (const n of this.layout.nodes) {
				const d = Math.hypot(n.x, n.y, n.z);
				if (d > radius) radius = d;
			}
		}
		const dist = radius * 1.85;
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

	// --- module focus (drill-down) -------------------------------------------

	focusModule(moduleId: string): void {
		if (!this.graph || !this.scene || !this.fly) return;
		this.clearHover();
		this.focusedModule = moduleId;

		// Lazy-expand: overview set + every member note (orphans included)
		// + the ghosts hanging off members. Existing nodes stay pinned via
		// the position cache; only the freshly expanded ones simulate in.
		const members = focusMembers(this.graph, this.options, moduleId);
		this.layout.update(this.graph, expandedVisible(this.overviewVisible, members));
		// Deliberately no pruneCache: leaving focus keeps expanded positions
		// warm so re-entering the same module doesn't reshuffle it.
		this.rebuildSceneObjects(this.graph);
		paintFocusDim(
			members, this.slots, this.noteBase, this.ghostBase,
			this.noteMesh, this.ghostMesh, this.layout,
			this.edgeLines, this.edgeBaseColors
		);
		this.applyHubFocusVisuals(moduleId);
		this.flow?.setFocusDim(members);
		this.positionsDirty = true;

		const bounds = boundsOf(this.layout.nodes, members)
			?? boundsOf(this.layout.nodes, null);
		if (bounds) this.flyTo(bounds, 1.7);
		this.cb.onModuleFocus?.(moduleId);
	}

	clearFocus(): void {
		if (!this.focusedModule || !this.graph) return;
		this.focusedModule = null;
		this.clearHover();
		this.layout.update(this.graph, this.overviewVisible);
		// rebuildSceneObjects restores full-strength base colors and edges.
		this.rebuildSceneObjects(this.graph);
		this.applyHubFocusVisuals(null);
		this.positionsDirty = true;
		this.flyTo(boundsOf(this.layout.nodes, null), 2.1);
		this.cb.onModuleFocus?.(null);
	}

	getFocusedModule(): string | null {
		return this.focusedModule;
	}

	/**
	 * Visual state of the hub spheres: the focused module's hub turns solid
	 * and prominent, the others fade to near-invisible. null = overview,
	 * every hub back at its base opacity. This is the main "something
	 * happened" cue when clicking a hub.
	 */
	private applyHubFocusVisuals(moduleId: string | null): void {
		for (const hub of this.hubMeshes) {
			const mat = hub.mesh.material as MeshBasicMaterial;
			mat.opacity =
				moduleId === null
					? 0.45
					: hub.moduleId === moduleId
						? 0.9
						: 0.07;
		}
	}

	/** Keep the current view direction, back off to frame the bounds. */
	private flyTo(bounds: { center: Vector3; radius: number } | null, fitFactor: number): void {
		if (!bounds || !this.camera || !this.controls || !this.fly) return;
		const dir = this.camera.position.clone().sub(this.controls.target);
		if (dir.lengthSq() < 1e-6) dir.set(0.62, 0.46, 0.62);
		dir.normalize();
		const pos = bounds.center.clone().add(dir.multiplyScalar(bounds.radius * fitFactor));
		this.fly.flyTo(bounds.center, pos, 700);
		const fog = this.scene?.fog;
		if (fog instanceof Fog) {
			const dist = bounds.radius * fitFactor;
			fog.near = dist * 0.9;
			fog.far = dist * 5;
		}
	}

	dispose(): void {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.resizeObserver?.disconnect();
		this.intersectionObserver?.disconnect();
		window.removeEventListener("keydown", this.onKeyDown, true);
		this.controls?.dispose();
		this.fly = null;
		this.flow?.dispose();
		this.flow = null;
		this.lastFrame = 0;
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

		// Module hubs: clickable cluster anchors (Phase 2 swaps in jellyfish).
		this.hubMeshes = [];
		const noteCountByModule = new Map<string, number>();
		for (const n of graph.nodes) {
			if (n.kind !== "note") continue;
			noteCountByModule.set(n.moduleId, (noteCountByModule.get(n.moduleId) ?? 0) + 1);
		}
		for (const [moduleId, hub] of this.layout.getHubs()) {
			const count = noteCountByModule.get(moduleId) ?? 0;
			const def = graph.modules.find((m) => m.id === moduleId);
			const scale = 7 + 2.0 * Math.sqrt(Math.max(1, count));
			const mesh = new Mesh(
				new SphereGeometry(1, 20, 14),
				new MeshBasicMaterial({
					color: new Color(def?.color ?? "#888780"),
					transparent: true,
					opacity: 0.45,
					depthWrite: false,
					toneMapped: false,
				})
			);
			mesh.position.set(hub.x, hub.y, hub.z);
			mesh.scale.setScalar(scale);
			this.scene.add(mesh);
			this.hubMeshes.push({ mesh, moduleId, count });
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
			this.edgeBaseColors = colors.slice();
			this.edgeLines = new LineSegments(geometry, material);
			this.scene.add(this.edgeLines);
		}

		// Flow layer: particles on every edge + one tendril per hub member.
		if (this.flow) {
			this.flow.rebuild(
				buildFlowSegments(
					this.layout.nodes,
					this.layout.edges,
					nodeById,
					this.layout.getHubs(),
					moduleColor,
					LINK_FLOW_COLOR,
					GHOST_FLOW_COLOR
				),
				this.layout.nodes
			);
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
		for (const hub of this.hubMeshes) {
			this.scene?.remove(hub.mesh);
			hub.mesh.geometry.dispose();
			(hub.mesh.material as MeshBasicMaterial).dispose();
		}
		this.hubMeshes = [];
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
		// Wheel reclaims the camera from flight/orbit before OrbitControls sees it.
		swapHost.addEventListener("wheel", this.onWheelCapture, true);
		el.addEventListener("pointermove", this.onPointerMove);
		el.addEventListener("pointerdown", this.onPointerDown);
		el.addEventListener("pointerup", this.onPointerUp);
		el.addEventListener("pointerleave", this.onPointerLeave);
		el.addEventListener("dblclick", this.onDoubleClick);
		// Esc leaves module focus. Key events target the focused element
		// (usually body), so the host can never be an ancestor — the only
		// working spot is window capture, gated on "pointer over canvas".
		window.addEventListener("keydown", this.onKeyDown, true);
	}

	/** Esc = back to overview, but ONLY while the pointer is over the canvas. */
	private onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== "Escape" || !this.focusedModule) return;
		if (!this.pointerOverCanvas()) return;
		e.preventDefault();
		e.stopPropagation();
		this.clearFocus();
	};

	/** True when the pointer currently sits anywhere over our canvas host. */
	private pointerOverCanvas(): boolean {
		if (!this.host) return false;
		if (this.host.matches(":hover")) return true;
		if (this.lastPointer.x < 0) return false;
		const el = document.elementFromPoint(this.lastPointer.x, this.lastPointer.y);
		return el instanceof Node && this.host.contains(el);
	}

	/** Cmd/Ctrl+left-drag pans (obsidian-3d-graph convention); plain left-drag rotates. */
	private onMouseButtonMode = (e: PointerEvent): void => {
		if (!this.controls || e.button !== 0) return;
		this.controls.mouseButtons.LEFT = e.metaKey || e.ctrlKey ? MOUSE.PAN : MOUSE.ROTATE;
	};

	private onPointerDown = (e: PointerEvent): void => {
		this.pointerDownAt = new Vector2(e.clientX, e.clientY);
		this.fly?.cancel(); // grabbing the canvas hands camera control back
	};

	private onPointerUp = (e: PointerEvent): void => {
		const down = this.pointerDownAt;
		this.pointerDownAt = null;
		if (!down) return;
		if (down.distanceTo(new Vector2(e.clientX, e.clientY)) > 6) return;
		if (this.hubHover) {
			// Click a hub to focus; click it again to leave; another hub swaps.
			if (this.focusedModule === this.hubHover.moduleId) this.clearFocus();
			else this.focusModule(this.hubHover.moduleId);
			return;
		}
		// Single click = fly to the node (galaxy-view model); double-click opens.
		if (this.hover) this.flyToNode(this.hover);
	};

	private onWheelCapture = (): void => {
		if (this.fly?.busy) this.fly.cancel();
	};

	private onDoubleClick = (e: MouseEvent): void => {
		const { node, hub } = this.pickAt(e);
		if (node && (!hub || node.dist <= hub.dist)) this.cb.onNodeOpen?.(node.slot.node);
	};

	/** Fly to frame one node; the arrival orbit sweeps toward its neighbors. */
	private flyToNode(slot: Slot): void {
		if (!this.fly) return;
		const sim = this.layout.nodes[this.slots.indexOf(slot)];
		if (!sim) return;
		const pos = new Vector3(sim.x, sim.y, sim.z);
		const r = slot.mesh === "ghost" ? 0.9 : nodeScale(slot.node.degree);
		this.fly.flyToNode(pos, r, this.densityBias(slot.node.id, pos));
	}

	/** Mean direction from the node to its rendered neighbors. */
	private densityBias(nodeId: string, from: Vector3): Vector3 | null {
		const ids = this.neighbors.get(nodeId);
		if (!ids || ids.length === 0) return null;
		const acc = new Vector3();
		let n = 0;
		this.slots.forEach((slot, i) => {
			if (!slot || !ids.includes(slot.node.id)) return;
			const p = this.layout.nodes[i];
			if (p) { acc.x += p.x; acc.y += p.y; acc.z += p.z; n++; }
		});
		return n === 0 ? null : acc.divideScalar(n).sub(from);
	}

	private onPointerLeave = (): void => {
		this.pointerDownAt = null;
		this.clearHover();
	};

	/** Raycast notes/ghosts/hubs under a client position. */
	private pickAt(at: { clientX: number; clientY: number }): {
		node: { slot: Slot; dist: number } | null;
		hub: { moduleId: string; count: number; dist: number } | null;
	} {
		const el = this.three?.domElement;
		if (!el || !this.camera) return { node: null, hub: null };
		const rect = el.getBoundingClientRect();
		this.raycaster.setFromCamera(
			new Vector2(
				((at.clientX - rect.left) / rect.width) * 2 - 1,
				-((at.clientY - rect.top) / rect.height) * 2 + 1
			),
			this.camera
		);
		let node: { slot: Slot; dist: number } | null = null;
		for (const [mesh, kind] of [[this.noteMesh, "note"], [this.ghostMesh, "ghost"]] as const) {
			if (!mesh) continue;
			for (const hit of this.raycaster.intersectObject(mesh)) {
				const slot = hit.instanceId === undefined ? null : this.slotByLocal(kind, hit.instanceId);
				if (slot && (!node || hit.distance < node.dist)) node = { slot, dist: hit.distance };
			}
		}
		let hub: { moduleId: string; count: number; dist: number } | null = null;
		for (const h of this.hubMeshes) {
			for (const hit of this.raycaster.intersectObject(h.mesh)) {
				if (!hub || hit.distance < hub.dist) {
					hub = { moduleId: h.moduleId, count: h.count, dist: hit.distance };
				}
			}
		}
		return { node, hub };
	}

	private onPointerMove = (e: PointerEvent): void => {
		this.lastPointer.x = e.clientX;
		this.lastPointer.y = e.clientY;
		const { node, hub } = this.pickAt(e);
		if (hub && (!node || hub.dist < node.dist)) {
			this.clearHover();
			this.applyHubHover(hub);
			return;
		}
		if (node?.slot.node.id === this.hover?.node.id) return;
		this.clearHover();
		if (node) this.applyHover(node.slot);
	};

	private slotByLocal(kind: "note" | "ghost", local: number): Slot | null {
		const list = kind === "note" ? this.noteSlots : this.ghostSlots;
		return list[local] ?? null;
	}

	private noteSlots: Slot[] = [];
	private ghostSlots: Slot[] = [];

	private applyHover(pick: Slot): void {
		this.hover = pick;
		this.hoverAnnounced = true;
		this.cb.onNodeHover?.(pick.node);
		this.flow?.accelerate(pick.node.id);
		this.hoverNeighbors = [];
		for (const id of this.neighbors.get(pick.node.id) ?? []) {
			const slot = this.slotById.get(id);
			if (slot) this.hoverNeighbors.push(slot);
		}
		paintSlots(this.noteMesh, this.ghostMesh, [pick], HIGHLIGHT_COLOR);
		paintSlots(this.noteMesh, this.ghostMesh, this.hoverNeighbors, NEIGHBOR_COLOR);
	}

	private applyHubHover(pick: { moduleId: string; count: number }): void {
		this.hubHover = pick;
		this.hubAnnounced = true;
		const def = this.graph?.modules.find((m) => m.id === pick.moduleId);
		this.cb.onHubHover?.({
			moduleId: pick.moduleId,
			name: def?.name ?? pick.moduleId,
			color: def?.color ?? "#888780",
			count: pick.count,
		});
	}

	private clearHover(): void {
		const had = this.hover !== null;
		if (had) {
			restoreSlots(this.noteMesh, this.ghostMesh, [this.hover as Slot, ...this.hoverNeighbors], this.noteBase, this.ghostBase);
			this.flow?.accelerate(null);
		}
		this.hover = null;
		this.hoverNeighbors = [];
		if (this.hoverAnnounced) {
			this.hoverAnnounced = false;
			this.cb.onNodeHover?.(null);
		}
		if (this.hubHover || this.hubAnnounced) {
			this.hubHover = null;
			this.hubAnnounced = false;
			this.cb.onHubHover?.(null);
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
			const now = performance.now();
			const dt = this.lastFrame
				? Math.min(0.05, (now - this.lastFrame) / 1000)
				: 0;
			this.lastFrame = now;
			const hot = !this.layout.isCold() && this.layout.tick();
			if (hot || this.positionsDirty) {
				this.syncPositions();
				this.positionsDirty = false;
			}
			this.flow?.update(dt, this.layout.nodes);
			this.flow?.applyCameraDistance(this.camera, this.controls, this.layout.estimateRadius());
			if (this.fly?.busy) this.fly.tick(dt);
			else this.controls?.update();
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
