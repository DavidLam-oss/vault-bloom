// three.js renderer: instanced glowing nodes + line-segment edges, orbit
// camera, hover-highlight, click-to-fly + focus card, module drill-down.
//
// Layout of responsibilities:
//   palette.ts       the fixed dark canvas palette (never follows the theme)
//   scene-build.ts   graph data -> GPU meshes (buildScene / disposeParts)
//   picking.ts       pointer -> node/hub raycast
//   flow-particles   edge particles + hub tendrils
//   hub-jellyfish    procedural bell + swim pulse for each module hub
//   camera-tween     flight + post-arrival orbit
//   focus-paint      pure math for the module drill-down dim pass
// This file only orchestrates them.

import {
	Color,
	Fog,
	Matrix4,
	MOUSE,
	PerspectiveCamera,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GraphNode, NeuralGraph } from "../data/types";
import { CameraFly } from "./camera-tween";
import { boundsOf, expandedVisible, focusMembers, paintFocusDim } from "./focus-paint";
import { FlowLayer } from "./flow-particles";
import { setJellyfishOpacity, updateJellyfish } from "./hub-jellyfish";
import { cssHex, PALETTE, type Palette } from "./palette";
import { paintSlots, restoreSlots } from "./paint";
import { pickAt, type PickResult } from "./picking";
import { ForceLayout } from "./layout";
import { buildScene, disposeParts, emptyParts, syncPositions, type SceneParts } from "./scene-build";
import { nodeScale, type Slot } from "./slot";
import type {
	GraphRenderer,
	HubHoverInfo,
	RendererCallbacks,
	RendererOptions,
} from "./renderer";

export class ThreeRenderer implements GraphRenderer {
	private cb: RendererCallbacks;
	private layout = new ForceLayout();
	/** palette background as a live Color - the dim pass blends towards it */
	private bgColor = new Color(PALETTE.background);
	private parts: SceneParts = emptyParts();

	private host: HTMLElement | null = null;
	private three: WebGLRenderer | null = null;
	private scene: Scene | null = null;
	private camera: PerspectiveCamera | null = null;
	private controls: OrbitControls | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private raf = 0;

	private dummy = new Matrix4();
	private raycaster = new Raycaster();
	/** scratch NDC vector, reused every pick to avoid per-frame allocation */
	private ndc = new Vector2();

	private hover: Slot | null = null;
	private hoverNeighbors: Slot[] = [];
	private hoverAnnounced = false;
	/** hover came from real pointer motion (vs a node drifting under a
	 *  static cursor during camera rotation) - only the former holds. */
	private hoverFromPointer = false;
	private hubHover: { moduleId: string; count: number } | null = null;
	private hubAnnounced = false;
	private pointerDown = false;
	private downX = 0;
	private downY = 0;
	private paused = false;
	private inViewport = true;
	private positionsDirty = false;
	private colorModule = new Map<string, Color>();

	// --- module focus (drill-down) state ------------------------------------
	private graph: NeuralGraph | null = null;
	private options: RendererOptions = {
		showOrphans: false,
		showGhosts: false,
		reducedMotion: false,
	};
	/** visible node ids in the un-focused overview state */
	private overviewVisible = new Set<string>();
	private focusedModule: string | null = null;
	private fly: CameraFly | null = null;
	private flow: FlowLayer | null = null;
	private lastFrame = 0;
	private lastPointer = { x: -1, y: -1 };

	constructor(cb: RendererCallbacks) {
		this.cb = cb;
	}

	mount(container: HTMLElement): void {
		// Hand the canvas colour to CSS: the wrapper is tinted before the first
		// WebGL frame lands, and reading it from the palette keeps the two from
		// ever drifting apart.
		container.style.setProperty("--nv-canvas-bg", cssHex(PALETTE.background));

		const host = document.createElement("div");
		host.className = "nv-canvas-host";
		container.appendChild(host);
		this.host = host;
		this.bgColor.setHex(PALETTE.background);

		const three = new WebGLRenderer({ antialias: true, alpha: false });
		three.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		three.setClearColor(PALETTE.background);
		host.appendChild(three.domElement);
		this.three = three;

		const scene = new Scene();
		scene.fog = new Fog(PALETTE.background, 500, 2600);
		this.scene = scene;
		this.flow = new FlowLayer(scene, PALETTE);
		this.flow.setMotionEnabled(!this.options.reducedMotion);

		this.camera = new PerspectiveCamera(55, 1, 0.1, 8000);
		this.camera.position.set(260, 180, 260);

		this.controls = new OrbitControls(this.camera, three.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		// Zoom toward the POINTER: dolly to a fixed target stops dead there.
		this.controls.zoomToCursor = true;
		this.controls.minDistance = 0.5;
		this.controls.maxDistance = 6000;
		this.controls.mouseButtons = {
			LEFT: MOUSE.ROTATE,
			MIDDLE: MOUSE.DOLLY,
			RIGHT: MOUSE.PAN,
		};
		// Orbit-hold authority: only POINTER-established hover (or hovering
		// the focus card, where canvas :hover drops) may pause the rotation.
		this.fly = new CameraFly(this.camera, this.controls, () =>
			(this.hover !== null && this.hoverFromPointer) ||
			(this.host?.matches(":hover") === true &&
				this.three?.domElement?.matches(":hover") !== true));
		this.fly.setReducedMotion(this.options.reducedMotion);

		this.bindPointerEvents();

		this.resizeObserver = new ResizeObserver(() => this.applySize());
		this.resizeObserver.observe(host);

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
		this.applyMotionPreference();
		if (this.focusedModule) {
			this.focusedModule = null;
			this.cb.onModuleFocus?.(null);
		}

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

		this.rebuildScene();
		this.clearHover();
		this.positionsDirty = true;

		if (coldStart) this.fitView(true);
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	private applyMotionPreference(): void {
		this.fly?.setReducedMotion(this.options.reducedMotion);
		this.flow?.setMotionEnabled(!this.options.reducedMotion);
	}

	/**
	 * Frame the graph. With useEstimate (animated cold start) the camera is
	 * placed for the expected final extent, since the graph grows into place
	 * over the first seconds of the simulation.
	 */
	fitView(useEstimate = false): void {
		if (!this.camera || !this.controls) return;
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
		this.setFogFor(dist);
		this.controls.update();
	}

	/** Fog brackets the camera distance so the far side of the graph fades. */
	private setFogFor(dist: number): void {
		const fog = this.scene?.fog;
		if (fog instanceof Fog) {
			fog.near = dist * 0.9;
			fog.far = dist * 5;
		}
	}

	// --- module focus (drill-down) -------------------------------------------

	focusModule(moduleId: string): void {
		if (!this.graph || !this.scene || !this.fly) return;
		this.clearHover();
		this.focusedModule = moduleId;

		// Lazy-expand: overview set + every member (orphans included) + the
		// ghosts hanging off members. Existing nodes stay pinned via cache.
		const members = focusMembers(this.graph, this.options, moduleId);
		this.layout.update(this.graph, expandedVisible(this.overviewVisible, members));
		// No pruneCache: expanded positions stay warm across focus visits.
		this.rebuildScene();
		paintFocusDim(
			members, this.parts.slots, this.parts.noteBase, this.parts.ghostBase,
			this.parts.noteMesh, this.parts.ghostMesh, this.layout,
			this.parts.edgeLines, this.parts.edgeBaseColors, this.bgColor
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
		// rebuildScene restores full-strength base colors and edges.
		this.rebuildScene();
		this.applyHubFocusVisuals(null);
		this.flow?.setFocusDim(null);
		this.positionsDirty = true;
		this.flyTo(boundsOf(this.layout.nodes, null), 2.1);
		this.cb.onNodeFocused?.(null);
		this.cb.onModuleFocus?.(null);
	}

	getFocusedModule(): string | null {
		return this.focusedModule;
	}

	/**
	 * Visual state of the jellyfish hubs: the focused module's jellyfish keeps
	 * full strength, the others fade to near-invisible. null = overview, every
	 * hub back at its base opacity. This is the main "something happened" cue
	 * when clicking a hub.
	 */
	private applyHubFocusVisuals(moduleId: string | null): void {
		for (const jelly of this.parts.jellies) {
			const factor =
				moduleId === null ? 1 : jelly.moduleId === moduleId ? 2 : 0.16;
			setJellyfishOpacity(jelly, factor);
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
		this.setFogFor(bounds.radius * fitFactor);
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
		if (this.scene) disposeParts(this.scene, this.parts);
		this.parts = emptyParts();
		this.three?.dispose();
		this.host?.remove();
		this.host = null;
		this.three = null;
		this.scene = null;
		this.camera = null;
		this.controls = null;
	}

	// --- scene construction -------------------------------------------------

	/** Tear down and rebuild every GPU object for the current visible set. */
	private rebuildScene(): void {
		if (!this.scene || !this.graph) return;
		disposeParts(this.scene, this.parts);
		this.parts = buildScene({
			scene: this.scene,
			layout: this.layout,
			graph: this.graph,
			moduleColor: (id) => this.colorModule.get(id) ?? new Color(0x888780),
			palette: PALETTE,
			flow: this.flow,
		});
	}

	// --- interaction ---------------------------------------------------------

	private bindPointerEvents(): void {
		const el = this.three?.domElement;
		if (!el) return;
		// The modifier swap MUST run before OrbitControls' own pointerdown
		// reads mouseButtons; capture on the TARGET fires in registration
		// order (after OrbitControls'), so bind to the host ANCESTOR where
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
		// Esc leaves module focus; key events land on body, so this needs
		// window-capture + a pointer-over-canvas gate.
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
		this.pointerDown = true;
		this.downX = e.clientX;
		this.downY = e.clientY;
		this.fly?.cancel(); // grabbing the canvas hands camera control back
	};

	private onPointerUp = (e: PointerEvent): void => {
		if (!this.pointerDown) return;
		this.pointerDown = false;
		const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
		if (moved > 6) return;
		if (this.hubHover) {
			if (this.focusedModule === this.hubHover.moduleId) this.clearFocus();
			else this.focusModule(this.hubHover.moduleId);
			this.cb.onNodeFocused?.(null);
			return;
		}
		// Single click = fly to the node (galaxy-view model); double-click opens.
		this.flyToNode(this.hover);
	};

	private onWheelCapture = (): void => { if (this.fly?.busy) this.fly.cancel(); };

	private onDoubleClick = (e: MouseEvent): void => {
		const { node, hub } = this.pick(e);
		if (node && (!hub || node.dist <= hub.dist)) this.cb.onNodeOpen?.(node.slot.node);
	};

	/** Fly to frame one node; the arrival orbit sweeps toward its neighbors.
	 *  null = empty-canvas click: clears the selection (focus card). */
	private flyToNode(slot: Slot | null): void {
		if (!slot) { this.cb.onNodeFocused?.(null); return; }
		if (!this.fly) return;
		const sim = this.layout.nodes[this.parts.slots.indexOf(slot)];
		if (!sim) return;
		const pos = new Vector3(sim.x, sim.y, sim.z);
		const r = slot.mesh === "ghost" ? 0.9 : nodeScale(slot.node.degree);
		this.fly.flyToNode(pos, r, this.densityBias(slot.node.id, pos));
		this.cb.onNodeFocused?.(slot.node);
	}

	/** Mean direction from the node to its rendered neighbors. */
	private densityBias(nodeId: string, from: Vector3): Vector3 | null {
		const ids = this.parts.neighbors.get(nodeId);
		if (!ids || ids.length === 0) return null;
		const wanted = new Set(ids);
		const acc = new Vector3();
		let n = 0;
		this.parts.slots.forEach((slot, i) => {
			if (!slot || !wanted.has(slot.node.id)) return;
			const p = this.layout.nodes[i];
			if (p) { acc.x += p.x; acc.y += p.y; acc.z += p.z; n++; }
		});
		return n === 0 ? null : acc.divideScalar(n).sub(from);
	}

	private onPointerLeave = (): void => {
		this.pointerDown = false;
		this.clearHover();
	};

	/** Raycast notes/ghosts/hubs under a client position. */
	private pick(at: { x: number; y: number }): PickResult {
		const el = this.three?.domElement;
		if (!el || !this.camera) return { node: null, hub: null };
		return pickAt(
			this.raycaster,
			{ el, camera: this.camera, parts: this.parts, ndc: this.ndc },
			at
		);
	}

	private onPointerMove = (e: PointerEvent): void => {
		this.lastPointer.x = e.clientX;
		this.lastPointer.y = e.clientY;
		this.pickAndHover(true);
	};

	/** Hover = whatever is under the pointer, re-picked per frame on camera motion. */
	private pickAndHover(fromPointer: boolean): void {
		const { node, hub } = this.pick(this.lastPointer);
		if (fromPointer) this.hoverFromPointer = node !== null;
		else if (node?.slot.node.id !== this.hover?.node.id) {
			this.hoverFromPointer = false;
		}
		if (hub && (!node || hub.dist < node.dist)) {
			this.clearHover();
			this.applyHubHover(hub);
			return;
		}
		if (node?.slot.node.id === this.hover?.node.id) return;
		this.clearHover();
		if (node) this.applyHover(node.slot);
	}

	private applyHover(pick: Slot): void {
		this.hover = pick;
		this.hoverAnnounced = true;
		this.cb.onNodeHover?.(pick.node);
		this.flow?.accelerate(pick.node.id);
		this.hoverNeighbors = [];
		for (const id of this.parts.neighbors.get(pick.node.id) ?? []) {
			const slot = this.parts.slotById.get(id);
			if (slot) this.hoverNeighbors.push(slot);
		}
		paintSlots(this.parts.noteMesh, this.parts.ghostMesh, [pick], PALETTE.highlight);
		paintSlots(
			this.parts.noteMesh, this.parts.ghostMesh, this.hoverNeighbors, PALETTE.neighbor
		);
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
			restoreSlots(
				this.parts.noteMesh, this.parts.ghostMesh,
				[this.hover as Slot, ...this.hoverNeighbors],
				this.parts.noteBase, this.parts.ghostBase
			);
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
			const hot = this.layout.tick();
			if (hot || this.positionsDirty) {
				syncPositions(this.parts, this.layout, this.dummy);
				this.positionsDirty = false;
			}
			this.flow?.update(dt, this.layout.nodes);
			this.flow?.applyCameraDistance(this.camera, this.controls, this.layout.estimateRadius());
			for (const jelly of this.parts.jellies) {
				updateJellyfish(jelly, dt, !this.options.reducedMotion);
			}
			if (this.fly?.busy) {
				this.fly.tick(dt);
				if (this.fly.moving) this.pickAndHover(false);
			} else this.controls?.update();
			this.three.render(this.scene!, this.camera!);
		};
		this.raf = requestAnimationFrame(loop);
	}
}
