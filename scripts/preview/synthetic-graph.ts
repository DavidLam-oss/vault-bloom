// Synthetic vault snapshot for the browser preview harness.
// Mirrors the shape of David's vault (5 modules + unassigned, dense diary /
// inbox clusters, cross-module bridges, a sprinkle of ghost nodes) so visual
// tuning does not require reloading Obsidian for every tweak.

import type { GraphEdge, GraphNode, ModuleDef, NeuralGraph } from "../../src/data/types";

export interface SyntheticSpec {
	/** deterministic seed - same seed => same graph => comparable screenshots */
	seed: number;
	notes: number;
	links: number;
	ghosts: number;
}

export const DEFAULT_SPEC: SyntheticSpec = {
	seed: 20261007,
	notes: 1800,
	links: 1500,
	ghosts: 90,
};

/** Small deterministic PRNG (mulberry32) so screenshots are reproducible. */
export function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const MODULES: ModuleDef[] = [
	{ id: "write-publish", name: "写作发布", color: "#e2557b", rules: [] },
	{ id: "learning", name: "学习笔记", color: "#378add", rules: [] },
	{ id: "diary", name: "日记", color: "#ba7517", rules: [] },
	{ id: "inbox", name: "收集箱", color: "#1d9e75", rules: [] },
	{ id: "concepts", name: "概念网络", color: "#7f77dd", rules: [] },
	{ id: "unassigned", name: "未归类", color: "#888780", rules: [] },
];

/** Relative cluster sizes - diary and inbox dominate, like the real vault. */
const WEIGHTS: Record<string, number> = {
	"write-publish": 0.08,
	learning: 0.16,
	diary: 0.4,
	inbox: 0.14,
	concepts: 0.0,
	unassigned: 0.22,
};

const FOLDERS: Record<string, string> = {
	"write-publish": "Wechat",
	learning: "Learn",
	diary: "Diary",
	inbox: "flomo",
	concepts: "Concept",
	unassigned: "Notes",
};

export function buildSyntheticGraph(spec: SyntheticSpec = DEFAULT_SPEC): NeuralGraph {
	const rng = makeRng(spec.seed);
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const seen = new Set<string>();
	const pool: string[][] = [];

	const moduleIds = Object.keys(WEIGHTS).filter((id) => WEIGHTS[id] > 0);
	for (const id of moduleIds) {
		const count = Math.max(1, Math.round(spec.notes * WEIGHTS[id]));
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			const path = `${FOLDERS[id]}/note-${id}-${i}.md`;
			ids.push(path);
			nodes.push({
				id: path,
				kind: "note",
				title: `note-${id}-${i}`,
				path,
				moduleId: id,
				degree: 0,
				tags: [],
				mtime: 0,
				sizeBytes: 0,
			});
		}
		pool.push(ids);
	}

	const degree = new Map<string, number>();
	for (let i = 0; i < spec.links; i++) {
		// 78% intra-module, 22% cross-module bridges - the shape of a real vault.
		const intra = rng() < 0.78;
		const a = pool[Math.floor(rng() * pool.length)];
		const b = intra
			? pool[Math.floor(rng() * pool.length)]
			: pool[Math.floor(rng() * pool.length)];
		const src = a[Math.floor(rng() * a.length)];
		const tgt = b[Math.floor(rng() * b.length)];
		if (!src || !tgt || src === tgt) continue;
		const key = src < tgt ? src + "\u0000" + tgt : tgt + "\u0000" + src;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({ source: src, target: tgt, kind: "link" });
		degree.set(src, (degree.get(src) ?? 0) + 1);
		degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
	}

	// Ghost nodes: unresolved links hanging off random notes.
	for (let i = 0; i < spec.ghosts; i++) {
		const ghostId = `ghost:idea-${i}`;
		nodes.push({
			id: ghostId,
			kind: "ghost",
			title: `idea-${i}`,
			path: "",
			moduleId: "concepts",
			degree: 0,
			tags: [],
			mtime: 0,
			sizeBytes: 0,
		});
		const src = pool[Math.floor(rng() * pool.length)];
		const from = src[Math.floor(rng() * src.length)];
		edges.push({ source: from, target: ghostId, kind: "ghost" });
	}

	for (const n of nodes) {
		if (n.kind === "note") n.degree = degree.get(n.id) ?? 0;
	}

	const moduleCounts: Record<string, number> = {};
	for (const n of nodes) moduleCounts[n.moduleId] = (moduleCounts[n.moduleId] ?? 0) + 1;

	return {
		nodes,
		edges,
		modules: MODULES,
		moduleCounts,
		snapshot: {
			generatedAt: new Date().toISOString(),
			noteCount: nodes.filter((n) => n.kind === "note").length,
			ghostCount: nodes.filter((n) => n.kind === "ghost").length,
			edgeCount: edges.filter((e) => e.kind === "link").length,
			orphanCount: nodes.filter((n) => n.kind === "note" && n.degree === 0).length,
			buildMs: 41,
		},
	};
}
