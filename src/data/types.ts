// Neural Vault - graph data model.
// Bottom layer follows the native Obsidian graph model: nodes are files,
// edges are [[wikilinks]], tags optional, orphan notes toggleable.
// The "module" concept (jellyfish hubs) lives in the grouping layer.

export type NodeKind = "note" | "ghost" | "tag" | "concept";

export type EdgeKind = "link" | "ghost" | "concept" | "co-tag";

/** One grouping rule. First matching rule (in module order) wins. */
export interface ModuleRule {
	/** path: vault-path prefix match; tag: exact tag match; status: frontmatter status (reserved) */
	type: "path" | "tag" | "status";
	value: string;
}

export interface ModuleDef {
	id: string;
	name: string;
	color: string;
	rules: ModuleRule[];
}

export interface GraphNode {
	/** note: vault path; ghost: "ghost:<link text>"; tag: "tag:<name>" */
	id: string;
	kind: NodeKind;
	title: string;
	/** vault path, empty for ghost/tag nodes */
	path: string;
	moduleId: string;
	/** number of resolved links (in + out) */
	degree: number;
	tags: string[];
	mtime: number;
	sizeBytes: number;
}

export interface GraphEdge {
	source: string;
	target: string;
	kind: EdgeKind;
}

export interface GraphSnapshot {
	generatedAt: string;
	noteCount: number;
	ghostCount: number;
	edgeCount: number;
	orphanCount: number;
	/** total build time in ms */
	buildMs: number;
}

export interface NeuralGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** module definitions actually used for this build */
	modules: ModuleDef[];
	/** moduleId -> node count, for quick stats */
	moduleCounts: Record<string, number>;
	snapshot: GraphSnapshot;
}

export interface ModuleResolvable {
	path: string;
	tags: string[];
}

export type ModuleResolver = (node: ModuleResolvable) => ModuleDef;
