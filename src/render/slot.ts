// Node render-slot bookkeeping shared between the renderer and its helpers.

import type { GraphNode } from "../data/types";

/** instance scale = base + sqrt(degree) * k, clamped */
export function nodeScale(degree: number): number {
	return Math.min(9, 0.9 + Math.sqrt(degree) * 1.1);
}

/** A rendered node: which instanced mesh, its per-mesh index, its data. */
export interface Slot {
	mesh: "note" | "ghost";
	local: number;
	node: GraphNode;
}
