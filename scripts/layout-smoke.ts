// Headless smoke test for ForceLayout: run in Node, assert positions sane.
// Bundle with: node esbuild.config.mjs is plugin-specific, so this uses its
// own esbuild invocation (see scripts/run-layout-smoke.sh or the npm-less cmd).

import { ForceLayout } from "../src/render/layout";
import type { NeuralGraph, GraphNode, GraphEdge, ModuleDef } from "../src/data/types";

function fakeGraph(noteCount: number, edgeCount: number): NeuralGraph {
	const modules: ModuleDef[] = [
		{ id: "a", name: "A", color: "#e2557b", rules: [] },
		{ id: "b", name: "B", color: "#378add", rules: [] },
		{ id: "c", name: "C", color: "#ba7517", rules: [] },
	];
	const nodes: GraphNode[] = [];
	for (let i = 0; i < noteCount; i++) {
		nodes.push({
			id: `n${i}`,
			kind: "note",
			title: `note ${i}`,
			path: `n${i}.md`,
			moduleId: modules[i % 3].id,
			degree: 0,
			tags: [],
			mtime: 0,
			sizeBytes: 0,
		});
	}
	nodes.push({ id: "ghost:x", kind: "ghost", title: "x", path: "", moduleId: "concepts", degree: 0, tags: [], mtime: 0, sizeBytes: 0 });
	const edges: GraphEdge[] = [];
	for (let i = 0; i < edgeCount; i++) {
		const a = Math.floor(Math.random() * noteCount);
		const b = Math.floor(Math.random() * noteCount);
		if (a === b) continue;
		edges.push({ source: `n${a}`, target: `n${b}`, kind: "link" });
	}
	edges.push({ source: "n0", target: "ghost:x", kind: "ghost" });
	return {
		nodes,
		edges,
		modules,
		moduleCounts: {},
		snapshot: { generatedAt: "", noteCount: noteCount, ghostCount: 1, edgeCount: edges.length, orphanCount: 0, buildMs: 0 },
	};
}

const graph = fakeGraph(3000, 1500);
const visibleIds = new Set(graph.nodes.map((n) => n.id));

const layout = new ForceLayout();
const t0 = Date.now();
layout.update(graph, visibleIds);
layout.prewarm();
const elapsed = Date.now() - t0;

let nan = 0;
let maxR = 0;
const centroid = new Map<string, { x: number; y: number; z: number; n: number }>();
for (const n of layout.nodes) {
	if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) nan++;
	const r = Math.hypot(n.x, n.y, n.z);
	if (r > maxR) maxR = r;
	const c = centroid.get(n.moduleId) ?? { x: 0, y: 0, z: 0, n: 0 };
	c.x += n.x; c.y += n.y; c.z += n.z; c.n += 1;
	centroid.set(n.moduleId, c);
}
const centroids = Object.fromEntries(
	[...centroid.entries()].map(([k, v]) => [k, {
		x: Math.round(v.x / v.n),
		y: Math.round(v.y / v.n),
		z: Math.round(v.z / v.n),
		n: v.n,
	}])
);
const centers = Object.entries(centroids)
	.filter(([k]) => k !== "concepts")
	.map(([, v]) => [v.x, v.y, v.z] as const);
let minPairDist = Infinity;
for (let i = 0; i < centers.length; i++) {
	for (let j = i + 1; j < centers.length; j++) {
		const d = Math.hypot(
			centers[i][0] - centers[j][0],
			centers[i][1] - centers[j][1],
			centers[i][2] - centers[j][2]
		);
		if (d < minPairDist) minPairDist = d;
	}
}
console.log(JSON.stringify({
	elapsedMs: elapsed,
	nodeCount: layout.nodes.length,
	edgeCount: layout.edges.length,
	nanCount: nan,
	maxRadius: Math.round(maxR),
	minCentroidPairDist: Math.round(minPairDist),
	centroids,
}, null, 2));

// Incremental update: add one node, ensure old positions are kept (no jump).
const before = layout.nodes.slice(0, 5).map((n) => [n.id, n.x, n.y, n.z]);
const graph2 = fakeGraph(3001, 1500);
graph2.nodes[3000].id = "n-brand-new";
graph2.nodes[3000].moduleId = "a";
const visible2 = new Set(graph2.nodes.map((n) => n.id));
layout.update(graph2, visible2);
const after = before.map(([id]) => {
	const n = layout.nodes.find((x) => x.id === id);
	return [id, n?.x, n?.y, n?.z];
});
const jumped = before.filter((b, i) => {
	const a = after[i];
	return Math.hypot(a[1] - b[1], a[2] - b[2], a[3] - b[3]) > 0.001;
}).length;
console.log("pinned-unchanged:", jumped === 0 ? "PASS" : `FAIL (${jumped} jumped)`);
console.log("new-node-present:", layout.nodes.some((n) => n.id === "n-brand-new") ? "PASS" : "FAIL");
