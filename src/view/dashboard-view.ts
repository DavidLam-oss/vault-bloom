// Dashboard view - stats + module distribution + the three.js neural canvas.
// The renderer instance persists across graph rebuilds so the node position
// cache in its layout survives (no jump on note edits).

import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type NeuralVaultPlugin from "../main";
import { GraphNode } from "../data/types";
import { ThreeRenderer } from "../render/three-renderer";
import type { HubHoverInfo, RendererOptions } from "../render/renderer";

export const VIEW_TYPE_VAULT_BLOOM = "vault-bloom-dashboard";

const TOP_LINKED = 15;

export class DashboardView extends ItemView {
	private plugin: NeuralVaultPlugin;
	private renderer: ThreeRenderer | null = null;
	private skeletonBuilt = false;
	private statValues = new Map<string, HTMLElement>();
	private moduleTableBody: HTMLElement | null = null;
	private topListEl: HTMLElement | null = null;
	private hoverBar: HTMLElement | null = null;
	private backBtn: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: NeuralVaultPlugin) {
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
		this.renderDebug();
	}

	async onClose(): Promise<void> {
		this.renderer?.dispose();
		this.renderer = null;
		this.contentEl.empty();
	}

	/** Build the skeleton once, then refresh numbers + renderer data. */
	renderDebug(): void {
		const graph = this.plugin.currentGraph;
		if (!graph) {
			this.contentEl.createEl("p", { text: "Graph not built yet." });
			return;
		}
		if (!this.skeletonBuilt) {
			this.buildSkeleton();
			this.skeletonBuilt = true;
		}
		this.refreshData();
	}

	private buildSkeleton(): void {
		const { contentEl } = this;
		contentEl.empty();

		// Canvas first: the dashboard is a renderer with stats underneath.
		const canvasWrap = contentEl.createDiv("nv-canvas-wrap");
		this.hoverBar = canvasWrap.createDiv("nv-hoverbar");
		this.hoverBar.setText("Left-drag rotate · Cmd/right-drag pan · Scroll zoom to cursor · Click note to fly · Double-click to open");

		this.backBtn = canvasWrap.createDiv("nv-backbtn");
		this.backBtn.setText("← Back to overview (Esc)");
		this.backBtn.addEventListener("click", () => this.renderer?.clearFocus());

		this.renderer = new ThreeRenderer({
			onNodeOpen: (node) => this.openNode(node),
			onNodeHover: (node) => this.showHover(node),
			onModuleFocus: (moduleId) => this.onFocusChange(moduleId),
			onHubHover: (hub) => this.showHubHover(hub),
		});
		this.renderer.mount(canvasWrap);

		const header = contentEl.createDiv("nv-header");
		header.createEl("h3", { text: "Vault Bloom - data layer debug" });

		const stats = contentEl.createDiv("nv-stats");
		for (const [key, label] of [
			["notes", "notes"],
			["links", "links"],
			["ghosts", "ghosts"],
			["orphans", "orphans"],
			["build", "build time"],
		] as const) {
			const box = stats.createDiv("nv-stat");
			const value = box.createDiv("nv-stat-value");
			box.createDiv("nv-stat-label").setText(label);
			this.statValues.set(key, value);
		}

		const actions = contentEl.createDiv("nv-actions");
		const refresh = actions.createEl("button", { text: "Rebuild now" });
		refresh.addEventListener("click", () => {
			this.plugin.rebuildGraph();
			this.renderDebug();
			new Notice("Vault Bloom: graph rebuilt");
		});
		const fit = actions.createEl("button", { text: "Fit view" });
		fit.addEventListener("click", () => this.renderer?.fitView());

		contentEl.createEl("h4", { text: "Modules" });
		const table = contentEl.createEl("table", { cls: "nv-module-table" });
		const head = table.createEl("tr");
		head.createEl("th", { text: "Module" });
		head.createEl("th", { text: "Nodes" });
		this.moduleTableBody = table;

		contentEl.createEl("h4", { text: "Most linked notes" });
		this.topListEl = contentEl.createEl("ul", { cls: "nv-top-list" });
	}

	private refreshData(): void {
		const graph = this.plugin.currentGraph;
		if (!graph) return;
		const s = graph.snapshot;
		this.statValues.get("notes")?.setText(String(s.noteCount));
		this.statValues.get("links")?.setText(String(s.edgeCount));
		this.statValues.get("ghosts")?.setText(String(s.ghostCount));
		this.statValues.get("orphans")?.setText(String(s.orphanCount));
		this.statValues.get("build")?.setText(s.buildMs + "ms");

		if (this.moduleTableBody) {
			this.moduleTableBody.empty();
			for (const def of graph.modules) {
				const row = this.moduleTableBody.createEl("tr", { cls: "nv-module-row" });
				row.addEventListener("click", () => this.renderer?.focusModule(def.id));
				const nameCell = row.createEl("td");
				const dot = nameCell.createEl("span", { cls: "nv-module-dot" });
				dot.style.backgroundColor = def.color;
				nameCell.appendText(def.name);
				row.createEl("td", { text: String(graph.moduleCounts[def.id] ?? 0) });
			}
		}

		if (this.renderer) {
			this.renderer.setData(graph, this.rendererOptions());
		}

		// Most connected notes (verification: these should match the hubs you see).
		if (this.topListEl) {
			this.topListEl.empty();
			const top = graph.nodes
				.filter((n) => n.kind === "note" && n.degree > 0)
				.sort((a, b) => b.degree - a.degree)
				.slice(0, TOP_LINKED);
			for (const node of top) {
				const li = this.topListEl.createEl("li");
				const link = li.createEl("a", { text: `${node.title} (${node.degree})` });
				link.href = "#";
				link.addEventListener("click", (e) => {
					e.preventDefault();
					void this.app.workspace.openLinkText(node.path, "");
				});
			}
			if (top.length === 0) {
				this.topListEl.createEl("li", { text: "No linked notes found." });
			}
		}
	}

	private rendererOptions(): RendererOptions {
		return {
			showOrphans: this.plugin.settings.showOrphans,
			showGhosts: this.plugin.settings.showGhosts,
		};
	}

	private openNode(node: GraphNode): void {
		if (node.kind === "note" && node.path) {
			void this.app.workspace.openLinkText(node.path, "");
			return;
		}
		new Notice(`"${node.title}" is not created yet - a gap in your knowledge.`);
	}

	private showHover(node: GraphNode | null): void {
		if (!this.hoverBar) return;
		if (!node) {
			this.hoverBar.setText(
				this.renderer?.getFocusedModule()
					? "Module focus - click the hub again or press Esc to go back"
					: "Hover a node to inspect it"
			);
			this.hoverBar.removeClass("nv-hoverbar-active");
			return;
		}
		const moduleDef = this.plugin.currentGraph?.modules.find(
			(m) => m.id === node.moduleId
		);
		const label = node.kind === "ghost"
			? `ghost - ${node.title}`
			: `${node.title} - ${moduleDef?.name ?? node.moduleId} - ${node.degree} links`;
		this.hoverBar.setText(label);
		this.hoverBar.addClass("nv-hoverbar-active");
	}

	private showHubHover(hub: HubHoverInfo | null): void {
		if (!this.hoverBar) return;
		if (!hub) {
			this.hoverBar.setText(
				this.renderer?.getFocusedModule()
					? "Module focus - click the hub again or press Esc to go back"
					: "Hover a node to inspect it"
			);
			this.hoverBar.removeClass("nv-hoverbar-active");
			return;
		}
		const focused = this.renderer?.getFocusedModule();
		const action = focused === hub.moduleId
			? "click again to go back"
			: focused
				? "click to switch module"
				: "click to focus";
		this.hoverBar.setText(`Module: ${hub.name} · ${hub.count} notes · ${action}`);
		this.hoverBar.addClass("nv-hoverbar-active");
	}

	private onFocusChange(moduleId: string | null): void {
		this.backBtn?.toggleClass("nv-visible", moduleId !== null);
		if (moduleId && this.hoverBar) {
			const def = this.plugin.currentGraph?.modules.find(
				(m) => m.id === moduleId
			);
			this.hoverBar.setText(
				`Focused: ${def?.name ?? moduleId} · Esc or "Back" to return`
			);
			this.hoverBar.addClass("nv-hoverbar-active");
		}
	}
}
