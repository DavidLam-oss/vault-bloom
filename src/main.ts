// Vault Bloom - plugin entry.
//
// Responsibilities: own the settings, keep a freshly-projected graph in
// `currentGraph`, and hand it to whichever DashboardView is open. The graph
// is rebuilt from metadataCache (no file parsing), so a rebuild is cheap and
// can be scheduled on every vault change.

import { Notice, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { buildGraph } from "./data/graph-builder";
import { makeModuleResolver } from "./data/modules";
import { NeuralGraph } from "./data/types";
import {
	VaultBloomSettingTab,
	VaultBloomSettings,
	loadSettings,
	saveSettings,
} from "./settings/settings";
import { DashboardView, VIEW_TYPE_VAULT_BLOOM } from "./view/dashboard-view";

/** Vault changes are debounced so a burst of edits rebuilds once. */
const REBUILD_DEBOUNCE_MS = 1000;

export default class VaultBloomPlugin extends Plugin {
	settings!: VaultBloomSettings;
	/** latest built graph, shared with the dashboard view */
	currentGraph: NeuralGraph | null = null;

	private rebuildTimer: number | null = null;

	async onload(): Promise<void> {
		this.settings = await loadSettings(this);

		this.registerView(
			VIEW_TYPE_VAULT_BLOOM,
			(leaf: WorkspaceLeaf) => new DashboardView(leaf, this)
		);

		this.addRibbonIcon("orbit", "Open Vault Bloom", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-dashboard",
			name: "Open dashboard",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "rebuild-graph",
			name: "Rebuild graph",
			callback: () => {
				this.rebuildGraph();
				this.refreshOpenView();
				new Notice("Vault Bloom: graph rebuilt");
			},
		});

		this.addSettingTab(new VaultBloomSettingTab(this.app, this));

		// Incremental-ish refresh: metadataCache keeps itself up to date, we
		// just re-project it. "resolved" covers new links, "changed" covers
		// tag/frontmatter edits, "deleted"/"rename" cover removals.
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => this.scheduleRebuild())
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", () => this.scheduleRebuild())
		);
		this.registerEvent(
			this.app.vault.on("delete", () => this.scheduleRebuild())
		);
		this.registerEvent(
			this.app.vault.on("rename", (_file: TAbstractFile) => this.scheduleRebuild())
		);

		this.rebuildGraph();
	}

	onunload(): void {
		if (this.rebuildTimer !== null) {
			window.clearTimeout(this.rebuildTimer);
		}
	}

	/** Rebuild the graph from metadataCache (cheap: no file parsing). */
	rebuildGraph(): void {
		const started = performance.now();
		const resolver = makeModuleResolver(this.settings.modules);
		this.currentGraph = buildGraph(this.app, this.settings.modules, resolver);
		const ms = Math.round(performance.now() - started);
		console.log(
			`Vault Bloom: ${this.currentGraph.snapshot.noteCount} notes, ` +
			`${this.currentGraph.snapshot.edgeCount} edges in ${ms}ms`
		);
	}

	/** Rebuild the graph and refresh the open dashboard view (if any). */
	refreshGraph(): void {
		this.rebuildGraph();
		this.refreshOpenView();
	}

	/** Merge + persist a settings patch, then apply it to the open view. */
	async updateSettings(patch: Partial<VaultBloomSettings>): Promise<void> {
		this.settings = { ...this.settings, ...patch };
		await saveSettings(this, this.settings);
		this.refreshGraph();
	}

	/** Debounced rebuild after vault changes. */
	scheduleRebuild(): void {
		if (this.rebuildTimer !== null) {
			window.clearTimeout(this.rebuildTimer);
		}
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = null;
			this.refreshGraph();
		}, REBUILD_DEBOUNCE_MS);
	}

	private refreshOpenView(): void {
		this.withOpenView((view) => view.refresh());
	}

	private withOpenView(fn: (view: DashboardView) => void): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_BLOOM)[0];
		if (leaf && leaf.view instanceof DashboardView) {
			fn(leaf.view);
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_VAULT_BLOOM);
		if (existing.length > 0) {
			void workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_VAULT_BLOOM, active: true });
		void workspace.revealLeaf(leaf);
	}
}
