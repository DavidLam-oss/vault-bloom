// Pure helpers for the module drill-down (focus) feature: member
// computation, visible-set expansion, bounding-sphere fitting and the
// dim paint pass. Kept out of ThreeRenderer so both files stay well
// under the size budget and the math stays headless-testable.

import {
	BufferAttribute,
	Color,
	InstancedMesh,
	LineSegments,
	Vector3,
} from "three";
import type { GraphNode, NeuralGraph } from "../data/types";
import type { RendererOptions } from "./renderer";

export interface PaintSlot {
	mesh: "note" | "ghost";
	local: number;
	node: GraphNode;
}

export interface LayoutView {
	nodes: Array<{ id: string; x: number; y: number; z: number }>;
	edges: Array<{ source: number; target: number }>;
}

const DIM_NODE = 0.14;
const DIM_EDGE = 0.08;

/** All note ids of a module plus, when enabled, its adjacent ghost nodes. */
export function focusMembers(
	graph: NeuralGraph,
	options: RendererOptions,
	moduleId: string
): Set<string> {
	const members = new Set<string>();
	for (const n of graph.nodes) {
		if (n.kind === "note" && n.moduleId === moduleId) members.add(n.id);
	}
	if (options.showGhosts) {
		for (const e of graph.edges) {
			if (e.kind !== "ghost") continue;
			if (members.has(e.source)) members.add(e.target);
			else if (members.has(e.target)) members.add(e.source);
		}
	}
	return members;
}

/** Overview visible set + everything the focus lazy-expands. */
export function expandedVisible(
	overview: Set<string>,
	members: Set<string>
): Set<string> {
	const visible = new Set(overview);
	for (const id of members) visible.add(id);
	return visible;
}

/** Bounding sphere of a node-id set (null = every layout node). */
export function boundsOf(
	nodes: LayoutView["nodes"],
	ids: Set<string> | null
): { center: Vector3; radius: number } | null {
	let count = 0;
	const center = new Vector3();
	for (const n of nodes) {
		if (ids && !ids.has(n.id)) continue;
		center.x += n.x;
		center.y += n.y;
		center.z += n.z;
		count++;
	}
	if (count === 0) return null;
	center.divideScalar(count);
	let radius = 40;
	for (const n of nodes) {
		if (ids && !ids.has(n.id)) continue;
		const d = Math.hypot(n.x - center.x, n.y - center.y, n.z - center.z);
		if (d > radius) radius = d;
	}
	return { center, radius };
}

/**
 * Dim everything outside the focused module. Nodes not in `members` fade to
 * 14% of their base color; an edge fades to 8% when either endpoint left.
 * `edgeBaseColors` is the per-vertex snapshot taken at scene build time.
 */
export function paintFocusDim(
	members: Set<string>,
	slots: ReadonlyArray<PaintSlot | null>,
	noteBase: Float32Array,
	ghostBase: Float32Array,
	noteMesh: InstancedMesh | null,
	ghostMesh: InstancedMesh | null,
	layout: LayoutView,
	edgeLines: LineSegments | null,
	edgeBaseColors: Float32Array | null
): void {
	for (const slot of slots) {
		if (!slot) continue;
		const base = slot.mesh === "note" ? noteBase : ghostBase;
		if (base.length === 0) continue;
		const k = members.has(slot.node.id) ? 1 : DIM_NODE;
		const color = new Color(
			base[slot.local * 3] * k,
			base[slot.local * 3 + 1] * k,
			base[slot.local * 3 + 2] * k
		);
		(slot.mesh === "note" ? noteMesh : ghostMesh)?.setColorAt(slot.local, color);
	}
	if (noteMesh?.instanceColor) noteMesh.instanceColor.needsUpdate = true;
	if (ghostMesh?.instanceColor) ghostMesh.instanceColor.needsUpdate = true;

	if (edgeLines && edgeBaseColors) {
		const attr = edgeLines.geometry.getAttribute("color") as
			| BufferAttribute
			| undefined;
		if (attr) {
			const arr = attr.array as Float32Array;
			layout.edges.forEach((edge, i) => {
				const a = layout.nodes[edge.source];
				const b = layout.nodes[edge.target];
				const k = members.has(a.id) && members.has(b.id) ? 1 : DIM_EDGE;
				for (let v = 0; v < 6; v++) {
					arr[i * 6 + v] = edgeBaseColors[i * 6 + v] * k;
				}
			});
			attr.needsUpdate = true;
		}
	}
}
