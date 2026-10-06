// Module rules engine: maps a node to its "jellyfish" module.
// Inspired by neural-creator-dashboard's role-based modules (works / methods /
// ideas / drafts) fused with Obsidian native graph's path color groups.
// Rules are data (stored in settings), not hardcoded logic.

import { ModuleDef, ModuleResolver, ModuleRule } from "./types";

/**
 * Default module mapping for David's vault. Five "jellyfish":
 * write-publish / learning / diary / inbox / concepts (derived, reserved).
 * Users can override these in data.json (settings UI comes in Phase 3).
 */
export const DEFAULT_MODULES: ModuleDef[] = [
	{
		id: "write-publish",
		name: "写作发布",
		color: "#e2557b",
		rules: [{ type: "path", value: "Wechat" }],
	},
	{
		id: "learning",
		name: "学习笔记",
		color: "#378add",
		rules: [
			{ type: "path", value: "Learn" },
			{ type: "path", value: "AI 编程" },
			{ type: "path", value: "SEO" },
			{ type: "path", value: "Prompt" },
			{ type: "path", value: "学习" },
		],
	},
	{
		id: "diary",
		name: "日记",
		color: "#ba7517",
		rules: [{ type: "path", value: "Diary" }],
	},
	{
		id: "inbox",
		name: "收集箱",
		color: "#1d9e75",
		rules: [
			{ type: "path", value: "flomo" },
			{ type: "path", value: "Inbox" },
			{ type: "path", value: "CLIP_inbox" },
			{ type: "path", value: "Clippings" },
			{ type: "path", value: "瞎搞" },
		],
	},
	{
		// Derived module: concept nodes come from shared tags (>=2 notes).
		// Populated by the concept builder, not by rules. Reserved for v1.x.
		id: "concepts",
		name: "概念网络",
		color: "#7f77dd",
		rules: [],
	},
];

/** Fallback for notes matched by no rule. */
export const UNASSIGNED_MODULE: ModuleDef = {
	id: "unassigned",
	name: "未归类",
	color: "#888780",
	rules: [],
};

interface CompiledModule {
	def: ModuleDef;
	pathRules: ModuleRule[];
	tagRules: ModuleRule[];
}

function compile(modules: ModuleDef[]): CompiledModule[] {
	return modules.map((def) => ({
		def,
		pathRules: def.rules.filter((r) => r.type === "path"),
		tagRules: def.rules.filter((r) => r.type === "tag"),
	}));
}

export function makeModuleResolver(modules: ModuleDef[]): ModuleResolver {
	const compiled = compile(modules);
	return (node) => {
		for (const { def, pathRules, tagRules } of compiled) {
			for (const rule of pathRules) {
				if (node.path === rule.value || node.path.startsWith(rule.value + "/")) {
					return def;
				}
			}
			for (const rule of tagRules) {
				if (node.tags.includes(rule.value)) {
					return def;
				}
			}
		}
		return UNASSIGNED_MODULE;
	};
}
