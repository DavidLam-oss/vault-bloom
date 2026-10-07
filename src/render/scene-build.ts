// Scene construction for the three.js renderer.
//
// Extracted from three-renderer.ts (which sat at the 800-line budget): all of
// the "turn graph data into GPU objects" work lives here, taking a layout and
// returning a bundle of meshes/attributes. Nothing in this file reads or
// writes renderer state, which is what makes the split mechanical.

import {
	BufferAttribute,
	BufferGeometry,
	Color,
	DynamicDrawUsage,
	InstancedMesh,
	LineBasicMaterial,
	LineSegments,
	Matrix4,
	MeshBasicMaterial,
	Scene,
	SphereGeometry,
} from "three";
import type { NeuralGraph } from "../data/types";
import { buildFlowSegments, type FlowLayer } from "./flow-particles";
import { createJellyfish, disposeJellyfish, type Jellyfish } from "./hub-jellyfish";
import type { ForceLayout } from "./layout";
import type { Palette } from "./palette";
import { nodeScale, type Slot } from "./slot";

export interface SceneParts {
	/** layout index -> render slot */
	slots: Array<Slot | null>;
	/** rendered node id -> slot (O(1) hover lookups) */
	slotById: Map<string, Slot>;
	noteSlots: Slot[];
	ghostSlots: Slot[];
	noteMesh: InstancedMesh | null;
	ghostMesh: InstancedMesh | null;
	/** per-instance base colors, parallel to the instanced meshes */
	noteBase: Float32Array;
	ghostBase: Float32Array;
	edgeLines: LineSegments | null;
	/** per-vertex edge colors before focus dimming */
	edgeBaseColors: Float32Array | null;
	/** layout index pairs per edge, for per-frame position sync */
	edgePairs: Int32Array;
	/** one jellyfish per module - the pickable hubs */
	jellies: Jellyfish[];
	neighbors: Map<string, string[]>;
}

export function emptyParts(): SceneParts {
	return {
		slots: [],
		slotById: new Map(),
		noteSlots: [],
		ghostSlots: [],
		noteMesh: null,
		ghostMesh: null,
		noteBase: new Float32Array(0),
		ghostBase: new Float32Array(0),
		edgeLines: null,
		edgeBaseColors: null,
		edgePairs: new Int32Array(0),
		jellies: [],
		neighbors: new Map(),
	};
}

export interface BuildSceneInput {
	scene: Scene;
	layout: ForceLayout;
	graph: NeuralGraph;
	moduleColor: (id: string) => Color;
	palette: Palette;
	flow: FlowLayer | null;
}

export function buildScene(input: BuildSceneInput): SceneParts {
	const { scene, layout, graph, moduleColor, palette, flow } = input;
	const parts = emptyParts();

	const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
	const noteNodes: Array<{ slot: Slot }> = [];
	const ghostNodes: Array<{ slot: Slot }> = [];

	for (const sim of layout.nodes) {
		const node = nodeById.get(sim.id);
		if (!node) {
			parts.slots.push(null);
			continue;
		}
		const slot: Slot = node.kind === "ghost"
			? { mesh: "ghost", local: ghostNodes.length, node }
			: { mesh: "note", local: noteNodes.length, node };
		parts.slots.push(slot);
		parts.slotById.set(node.id, slot);
		(node.kind === "ghost" ? ghostNodes : noteNodes).push({ slot });
	}

	if (noteNodes.length > 0) {
		const mesh = new InstancedMesh(
			new SphereGeometry(1, 10, 8),
			new MeshBasicMaterial({ toneMapped: false }),
			noteNodes.length
		);
		mesh.instanceMatrix.setUsage(DynamicDrawUsage);
		parts.noteBase = new Float32Array(noteNodes.length * 3);
		noteNodes.forEach(({ slot }, i) => {
			parts.noteSlots.push(slot);
			const color = moduleColor(slot.node.moduleId).clone();
			if (slot.node.degree === 0) color.multiplyScalar(0.4);
			parts.noteBase.set([color.r, color.g, color.b], i * 3);
			mesh.setColorAt(i, color);
		});
		mesh.instanceColor?.setUsage(DynamicDrawUsage);
		scene.add(mesh);
		parts.noteMesh = mesh;
	}

	if (ghostNodes.length > 0) {
		const mesh = new InstancedMesh(
			new SphereGeometry(1, 8, 6),
			new MeshBasicMaterial({
				transparent: true,
				opacity: 0.38,
				depthWrite: false,
				toneMapped: false,
			}),
			ghostNodes.length
		);
		mesh.instanceMatrix.setUsage(DynamicDrawUsage);
		parts.ghostBase = new Float32Array(ghostNodes.length * 3);
		ghostNodes.forEach(({ slot }, i) => {
			parts.ghostSlots.push(slot);
			parts.ghostBase.set([palette.ghost.r, palette.ghost.g, palette.ghost.b], i * 3);
			mesh.setColorAt(i, palette.ghost);
		});
		scene.add(mesh);
		parts.ghostMesh = mesh;
	}

	// Hubs: one procedurally built jellyfish per module, sized by member count
	// and coloured by the module. Replaces the old flat placeholder sphere.
	const noteCountByModule = new Map<string, number>();
	for (const n of graph.nodes) {
		if (n.kind !== "note") continue;
		noteCountByModule.set(n.moduleId, (noteCountByModule.get(n.moduleId) ?? 0) + 1);
	}
	for (const [moduleId, hub] of layout.getHubs()) {
		const count = noteCountByModule.get(moduleId) ?? 0;
		const def = graph.modules.find((m) => m.id === moduleId);
		parts.jellies.push(
			createJellyfish(
				scene,
				moduleId,
				count,
				new Color(def?.color ?? "#888780"),
				palette,
				hub
			)
		);
	}

	// Edges: one LineSegments with per-vertex colors (ghost edges tinted).
	const edgeCount = layout.edges.length;
	if (edgeCount > 0) {
		parts.edgePairs = new Int32Array(edgeCount * 2);
		const positions = new Float32Array(edgeCount * 2 * 3);
		const colors = new Float32Array(edgeCount * 2 * 3);
		layout.edges.forEach((edge, i) => {
			parts.edgePairs[i * 2] = edge.source;
			parts.edgePairs[i * 2 + 1] = edge.target;
			const c = edge.kind === "ghost" ? palette.ghostEdge : palette.link;
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
			opacity: palette.edgeOpacity,
			depthWrite: false,
		});
		parts.edgeBaseColors = colors.slice();
		parts.edgeLines = new LineSegments(geometry, material);
		scene.add(parts.edgeLines);
	}

	if (flow) {
		flow.rebuild(
			buildFlowSegments(
				layout.nodes,
				layout.edges,
				nodeById,
				layout.getHubs(),
				moduleColor,
				palette.linkFlow,
				palette.ghostFlow
			),
			layout.nodes
		);
	}

	for (const edge of graph.edges) {
		if (!parts.slotById.has(edge.source) || !parts.slotById.has(edge.target)) {
			continue;
		}
		pushNeighbor(parts.neighbors, edge.source, edge.target);
		pushNeighbor(parts.neighbors, edge.target, edge.source);
	}

	return parts;
}

export function disposeParts(scene: Scene, parts: SceneParts): void {
	for (const obj of [parts.noteMesh, parts.ghostMesh, parts.edgeLines]) {
		if (!obj) continue;
		scene.remove(obj);
		obj.geometry.dispose();
		(obj.material as MeshBasicMaterial | LineBasicMaterial).dispose();
	}
	parts.noteMesh = null;
	parts.ghostMesh = null;
	parts.edgeLines = null;
	for (const jelly of parts.jellies) disposeJellyfish(scene, jelly);
	parts.jellies = [];
}

/** Copy settled layout positions into the GPU buffers. */
export function syncPositions(
	parts: SceneParts,
	layout: ForceLayout,
	dummy: Matrix4
): void {
	const { noteMesh, ghostMesh, edgeLines } = parts;
	if (!noteMesh && !ghostMesh && !edgeLines) return;

	for (let i = 0; i < layout.nodes.length; i++) {
		const sim = layout.nodes[i];
		const slot = parts.slots[i];
		if (!slot) continue;
		const scale = slot.mesh === "ghost" ? 0.9 : nodeScale(slot.node.degree);
		dummy.makeScale(scale, scale, scale);
		dummy.setPosition(sim.x, sim.y, sim.z);
		(slot.mesh === "note" ? noteMesh : ghostMesh)?.setMatrixAt(slot.local, dummy);
	}
	if (noteMesh) noteMesh.instanceMatrix.needsUpdate = true;
	if (ghostMesh) ghostMesh.instanceMatrix.needsUpdate = true;

	if (edgeLines) {
		const attr = edgeLines.geometry.getAttribute("position") as BufferAttribute;
		const arr = attr.array as Float32Array;
		for (let e = 0; e < layout.edges.length; e++) {
			const a = layout.nodes[parts.edgePairs[e * 2]];
			const b = layout.nodes[parts.edgePairs[e * 2 + 1]];
			const o = e * 6;
			arr[o] = a.x; arr[o + 1] = a.y; arr[o + 2] = a.z;
			arr[o + 3] = b.x; arr[o + 4] = b.y; arr[o + 5] = b.z;
		}
		attr.needsUpdate = true;
		edgeLines.geometry.computeBoundingSphere();
	}
}

function pushNeighbor(map: Map<string, string[]>, a: string, b: string): void {
	const list = map.get(a);
	if (list) list.push(b);
	else map.set(a, [b]);
}
