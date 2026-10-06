// graph-builder: turns Obsidian's metadataCache into a NeuralGraph.
// Zero file parsing: links/tags/frontmatter come from the cache Obsidian
// already maintains, so cold start stays fast even for thousands of notes.

import { App, CachedMetadata } from "obsidian";
import {
	GraphEdge,
	GraphNode,
	ModuleDef,
	NeuralGraph,
	ModuleResolver,
} from "./types";
import { UNASSIGNED_MODULE } from "./modules";

const GHOST_PREFIX = "ghost:";

/** Extract tags from frontmatter + inline tags of a note. */
function tagsOf(cache: CachedMetadata | null): string[] {
	const out: string[] = [];
	const fmTags = cache?.frontmatter?.tags;
	if (typeof fmTags === "string") {
		out.push(...fmTags.split(/[,\s，]+/));
	} else if (Array.isArray(fmTags)) {
		out.push(...fmTags.map((t) => String(t)));
	}
	for (const t of cache?.tags ?? []) {
		out.push(t.tag.replace(/^#/, ""));
	}
	return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function pairKey(a: string, b: string): string {
	return a < b ? a + "\u0000" + b : b + "\u0000" + a;
}

/**
 * Build the full graph of the vault.
 *
 * Design notes:
 * - Resolved links produce undirected edges (deduplicated by sorted pair),
 *   matching the native graph's behaviour.
 * - Unresolved links produce ghost nodes (knowledge gaps) + "ghost" edges.
 * - degree = in-degree + out-degree of resolved links; degree 0 = orphan.
 * - Position caching lives in the renderer/layout layer (next step), not here:
 *   this builder is pure and cheap to re-run on every metadataCache change.
 */
export function buildGraph(
	app: App,
	modules: ModuleDef[],
	resolveModule: ModuleResolver
): NeuralGraph {
	const started = Date.now();
	const nodeMap = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const edgeSeen = new Set<string>();
	const inDeg = new Map<string, number>();
	const outDeg = new Map<string, number>();

	// 1. Note nodes.
	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		nodeMap.set(file.path, {
			id: file.path,
			kind: "note",
			title: file.basename,
			path: file.path,
			moduleId: "",
			degree: 0,
			tags: tagsOf(cache),
			mtime: file.stat.mtime,
			sizeBytes: file.stat.size,
		});
	}

	// 2. Resolved links -> undirected edges + degrees.
	// resolvedLinks may reference non-markdown targets (attachments) or paths
	// that vanished between cache updates; only keep edges between known nodes.
	const resolvedLinks = app.metadataCache.resolvedLinks;
	for (const [src, targets] of Object.entries(resolvedLinks)) {
		if (!nodeMap.has(src)) continue;
		for (const tgt of Object.keys(targets)) {
			if (!nodeMap.has(tgt)) continue;
			bump(outDeg, src);
			bump(inDeg, tgt);
			const key = pairKey(src, tgt);
			if (!edgeSeen.has(key)) {
				edgeSeen.add(key);
				edges.push({ source: src, target: tgt, kind: "link" });
			}
		}
	}

	// 3. Unresolved links -> ghost nodes (knowledge gaps) + edges.
	const unresolvedLinks = app.metadataCache.unresolvedLinks;
	for (const [src, targets] of Object.entries(unresolvedLinks)) {
		if (!nodeMap.has(src)) continue;
		for (const linkText of Object.keys(targets)) {
			const ghostId = GHOST_PREFIX + linkText;
			if (!nodeMap.has(ghostId)) {
				nodeMap.set(ghostId, {
					id: ghostId,
					kind: "ghost",
					title: linkText,
					path: "",
					moduleId: "concepts",
					degree: 0,
					tags: [],
					mtime: 0,
					sizeBytes: 0,
				});
			}
			const key = pairKey(src, ghostId);
			if (!edgeSeen.has(key)) {
				edgeSeen.add(key);
				edges.push({ source: src, target: ghostId, kind: "ghost" });
			}
		}
	}

	// 4. Degrees + module assignment.
	const moduleCounts: Record<string, number> = {};
	const nodes = [...nodeMap.values()];
	for (const node of nodes) {
		if (node.kind === "note") {
			node.degree = (inDeg.get(node.id) ?? 0) + (outDeg.get(node.id) ?? 0);
			node.moduleId = resolveModule({ path: node.path, tags: node.tags }).id;
		}
		moduleCounts[node.moduleId] = (moduleCounts[node.moduleId] ?? 0) + 1;
	}

	const orphanCount = nodes.filter((n) => n.kind === "note" && n.degree === 0).length;

	return {
		nodes,
		edges,
		modules: [...modules, UNASSIGNED_MODULE],
		moduleCounts,
		snapshot: {
			generatedAt: new Date().toISOString(),
			noteCount: nodes.filter((n) => n.kind === "note").length,
			ghostCount: nodes.filter((n) => n.kind === "ghost").length,
			edgeCount: edges.filter((e) => e.kind === "link").length,
			orphanCount,
			buildMs: Date.now() - started,
		},
	};
}
