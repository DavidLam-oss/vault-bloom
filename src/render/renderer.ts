// Renderer abstraction. Phase 1 ships a three.js implementation; Phase 2
// (custom shaders for orb / jellyfish / tendrils) may swap in another
// implementation without the view layer knowing anything changed.

import type { GraphNode, NeuralGraph } from "../data/types";

export interface RendererOptions {
	/** show notes without any link (native graph orphans toggle) */
	showOrphans: boolean;
	/** show ghost nodes from unresolved links */
	showGhosts: boolean;
}

export interface RendererCallbacks {
	/** user clicked a node (note => open in editor, ghost => notice) */
	onNodeClick?: (node: GraphNode) => void;
	/** hover enter/leave; null means the pointer left every node */
	onNodeHover?: (node: GraphNode | null) => void;
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
	/** release all resources */
	dispose(): void;
}
