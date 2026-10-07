// Renderer abstraction. Phase 1 ships a three.js implementation; Phase 2
// (custom shaders for orb / jellyfish / tendrils) may swap in another
// implementation without the view layer knowing anything changed.

import type { GraphNode, NeuralGraph } from "../data/types";

export interface RendererOptions {
	/** show notes without any link (native graph orphans toggle) */
	showOrphans: boolean;
	/** show ghost nodes from unresolved links */
	showGhosts: boolean;
	/** suppress auto-orbit, camera flights and particle travel */
	reducedMotion: boolean;
}

/** Payload for module-hub hover, so the view can label it. */
export interface HubHoverInfo {
	moduleId: string;
	name: string;
	color: string;
	/** number of note members in the module */
	count: number;
}

export interface RendererCallbacks {
	/** user double-clicked a node (note => open in editor, ghost => notice).
	 *  Single click flies the camera to the node (renderer-internal, the
	 *  galaxy-view / Obsidian-core-graph interaction model). */
	onNodeOpen?: (node: GraphNode) => void;
	/** hover enter/leave; null means the pointer left every node */
	onNodeHover?: (node: GraphNode | null) => void;
	/** module focus entered (moduleId) or returned to overview (null) */
	onModuleFocus?: (moduleId: string | null) => void;
	/** pointer entered/left a module hub (null = left) */
	onHubHover?: (hub: HubHoverInfo | null) => void;
	/** camera flew to a node (selected); null = selection cleared */
	onNodeFocused?: (node: GraphNode | null) => void;
}

export interface GraphRenderer {
	/** attach the canvas to a container element (once) */
	mount(container: HTMLElement): void;
	/**
	 * Push a (re)built graph. Nodes already known keep their positions
	 * (position cache), only new nodes enter the simulation.
	 */
	setData(graph: NeuralGraph, options: RendererOptions): void;
	/** pause/resume the animation loop (call when the view is hidden/shown) */
	setPaused(paused: boolean): void;
	/** move the camera so the whole graph fits */
	fitView(): void;
	/**
	 * Focus one module: fly the camera to its cluster, lazy-expand every
	 * member note (including orphans), dim the rest. Clicking the focused
	 * hub again or clearFocus() goes back to the overview.
	 */
	focusModule(moduleId: string): void;
	/** leave module focus and return to the full overview */
	clearFocus(): void;
	/** currently focused module id, null while in the overview */
	getFocusedModule(): string | null;
	/** release all resources */
	dispose(): void;
}
