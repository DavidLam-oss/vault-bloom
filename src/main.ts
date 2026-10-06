// Neural Vault - plugin entry.

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { buildGraph } from "./data/graph-builder";
import { makeModuleResolver } from "./data/modules";
import { NeuralGraph } from "./data/types";
import {
	NeuralVaultSettingTab,
	NeuralVaultSettings,
	loadSettings,
	saveSettings,
} from "./settings/settings";
import { DashboardView, VIEW_TYPE_NEURAL_VAULT } from "./view/dashboard-view";

export default class NeuralVaultPlugin extends Plugin {
	settings!: NeuralVaultSettings;
	/** latest built graph, shared with the dashboard view */
	currentGraph: NeuralGraph | null = null;

	private rebuildTimer: number | null = null;

	async onload(): Promise<void> {
		this.settings = await loadSettings(this);

		this.registerView(
			VIEW_TYPE_NEURAL_VAULT,
			(leaf: WorkspaceLeaf) => new DashboardView(leaf, this)
		);

		this.addRibbonIcon("orbit", "Open Neural Vault", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-dashboard",
			name: "Open neural vault dashboard",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "rebuild-graph",
			name: "Rebuild graph",
			callback: () => {
				this.rebuildGraph();
				new Notice("Neural Vault: graph rebuilt");
			},
		});

		this.addSettingTab(new NeuralVaultSettingTab(this.app, this));

		// Incremental-ish refresh: metadataCache keeps itself up to date, we
		// just re-project it. Debounced so burst edits don't thrash the build.
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => this.scheduleRebuild())
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
			`Neural Vault: ${this.currentGraph.snapshot.noteCount} notes, ` +
			`${this.currentGraph.snapshot.edgeCount} edges in ${ms}ms`
		);
	}

	/** Rebuild the graph and refresh the open dashboard view (if any). */
	refreshGraph(): void {
		this.rebuildGraph();
		this.withOpenView((view) => view.renderDebug());
	}

	/** Debounced rebuild after vault changes. */
	scheduleRebuild(): void {
		if (this.rebuildTimer !== null) {
			window.clearTimeout(this.rebuildTimer);
		}
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = null;
			this.refreshGraph();
		}, 1000);
	}

	private withOpenView(fn: (view: DashboardView) => void): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NEURAL_VAULT)[0];
		if (leaf && leaf.view instanceof DashboardView) {
			fn(leaf.view);
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_NEURAL_VAULT);
		if (existing.length > 0) {
			void workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_NEURAL_VAULT, active: true });
		void workspace.revealLeaf(leaf);
	}
}
