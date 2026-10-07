// Dashboard view - a thin Obsidian adapter.
//
// The chrome lives in dashboard-chrome.ts (plain DOM, reusable by the
// preview harness) and the drawing lives in ThreeRenderer. This file only
// wires them together and translates plugin state into chrome updates.
//
// The renderer instance persists across graph rebuilds so the node position
// cache in its layout survives - that is what stops the graph jumping when a
// note is edited.

import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type VaultBloomPlugin from "../main";
import { GraphNode } from "../data/types";
import { ThreeRenderer } from "../render/three-renderer";
import { resolveReducedMotion } from "../render/motion";
import {
	buildChrome,
	type ChromeModuleRow,
	type ChromeStats,
	type ChromeTopNote,
	type DashboardChrome,
} from "./dashboard-chrome";
import { FocusCard } from "./focus-card";
import type { HubHoverInfo, RendererOptions } from "../render/renderer";

export const VIEW_TYPE_VAULT_BLOOM = "vault-bloom-dashboard";

const TOP_LINKED = 15;

export class DashboardView extends ItemView {
	private plugin: VaultBloomPlugin;
	private renderer: ThreeRenderer | null = null;
	private chrome: DashboardChrome | null = null;
	private focusCard: FocusCard | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VaultBloomPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_VAULT_BLOOM;
	}

	getDisplayText(): string {
		return "Vault Bloom";
	}

	getIcon(): string {
		return "orbit";
	}

	async onOpen(): Promise<void> {
		// No "css-change" listener on purpose: the canvas is a fixed dark
		// studio (see src/render/palette.ts), so a theme switch cannot change
		// anything this view draws.
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.focusCard?.dispose();
		this.focusCard = null;
		this.renderer?.dispose();
		this.renderer = null;
		this.chrome = null;
		this.contentEl.classList.remove("nv-root");
	}

	/** Build the chrome once, then keep pushing fresh data into it. */
	refresh(): void {
		const graph = this.plugin.currentGraph;
		if (!graph) {
			this.contentEl.textContent = "Graph not built yet.";
			return;
		}
		if (!this.chrome) this.build();
		this.pushData();
	}

	private build(): void {
		const chrome = buildChrome(this.contentEl, {
			onFocusModule: (moduleId) => this.renderer?.focusModule(moduleId),
			onClearFocus: () => this.renderer?.clearFocus(),
			onFitView: () => this.renderer?.fitView(),
			onRebuild: () => {
				this.plugin.rebuildGraph();
				this.pushData();
				new Notice("Vault Bloom: graph rebuilt");
			},
			onToggleGhosts: (value) => void this.plugin.updateSettings({ showGhosts: value }),
			onToggleOrphans: (value) => void this.plugin.updateSettings({ showOrphans: value }),
			onOpenNote: (path) => void this.app.workspace.openLinkText(path, ""),
		});
		this.chrome = chrome;

		this.renderer = new ThreeRenderer({
			onNodeOpen: (node) => this.openNode(node),
			onNodeHover: (node) => this.showHover(node),
			onModuleFocus: (moduleId) => this.onFocusChange(moduleId),
			onHubHover: (hub) => this.showHubHover(hub),
			onNodeFocused: (node) => this.showFocusCard(node),
		});
		this.renderer.mount(chrome.canvasWrap);
		this.focusCard = new FocusCard(this.app, chrome.canvasWrap);
	}

	private pushData(): void {
		const graph = this.plugin.currentGraph;
		const chrome = this.chrome;
		if (!graph || !chrome) return;

		const s = graph.snapshot;
		const stats: ChromeStats = {
			notes: s.noteCount,
			links: s.edgeCount,
			ghosts: s.ghostCount,
			orphans: s.orphanCount,
			buildMs: s.buildMs,
		};
		chrome.setStats(stats);

		const rows: ChromeModuleRow[] = graph.modules
			.map((def) => ({
				id: def.id,
				name: def.name,
				color: def.color,
				count: graph.moduleCounts[def.id] ?? 0,
			}))
			.filter((row) => row.count > 0)
			.sort((a, b) => b.count - a.count);
		chrome.setModules(rows);

		const top: ChromeTopNote[] = graph.nodes
			.filter((n) => n.kind === "note" && n.degree > 0)
			.sort((a, b) => b.degree - a.degree)
			.slice(0, TOP_LINKED)
			.map((n) => ({ title: n.title, path: n.path, degree: n.degree }));
		chrome.setTopNotes(top);

		chrome.setToggles({
			showGhosts: this.plugin.settings.showGhosts,
			showOrphans: this.plugin.settings.showOrphans,
		});

		this.renderer?.setData(graph, this.rendererOptions());
	}

	private rendererOptions(): RendererOptions {
		return {
			showOrphans: this.plugin.settings.showOrphans,
			showGhosts: this.plugin.settings.showGhosts,
			reducedMotion: resolveReducedMotion(this.plugin.settings.motion),
		};
	}

	private openNode(node: GraphNode): void {
		if (node.kind === "note" && node.path) {
			void this.app.workspace.openLinkText(node.path, "");
			return;
		}
		new Notice(`"${node.title}" is not created yet - a gap in your knowledge.`);
	}

	private showFocusCard(node: GraphNode | null): void {
		if (!node) {
			this.focusCard?.hide();
			return;
		}
		this.focusCard?.show(node);
	}

	/** Idle read-out: while a module is focused, keep saying so. */
	private idleHoverText(): string | null {
		const focused = this.renderer?.getFocusedModule();
		if (!focused) return null;
		const def = this.plugin.currentGraph?.modules.find((m) => m.id === focused);
		return `Focused: ${def?.name ?? focused} · Esc or "Overview" to go back`;
	}

	private showHover(node: GraphNode | null): void {
		if (!node) {
			this.chrome?.setHover(this.idleHoverText());
			return;
		}
		const moduleDef = this.plugin.currentGraph?.modules.find(
			(m) => m.id === node.moduleId
		);
		const label = node.kind === "ghost"
			? `ghost - ${node.title}`
			: `${node.title} · ${moduleDef?.name ?? node.moduleId} · ${node.degree} links`;
		this.chrome?.setHover(label);
	}

	private showHubHover(hub: HubHoverInfo | null): void {
		if (!hub) {
			this.chrome?.setHover(this.idleHoverText());
			return;
		}
		const focused = this.renderer?.getFocusedModule();
		const action = focused === hub.moduleId
			? "click again to go back"
			: focused
				? "click to switch module"
				: "click to focus";
		this.chrome?.setHover(`${hub.name} · ${hub.count} notes · ${action}`);
	}

	private onFocusChange(moduleId: string | null): void {
		const def = moduleId
			? this.plugin.currentGraph?.modules.find((m) => m.id === moduleId)
			: undefined;
		this.chrome?.setFocused(moduleId, def?.name ?? moduleId ?? "");
	}
}
