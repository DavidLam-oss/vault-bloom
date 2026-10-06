// Minimal settings for Phase 1. Module rules live in data.json so they can be
// edited by hand today and get a proper UI in Phase 3.

import { Plugin, PluginSettingTab, App, Setting } from "obsidian";
import { ModuleDef } from "../data/types";
import { DEFAULT_MODULES } from "../data/modules";
import type NeuralVaultPlugin from "../main";

export interface NeuralVaultSettings {
	modules: ModuleDef[];
	/** show notes without any link (native graph "orphans" toggle) */
	showOrphans: boolean;
	/** show ghost nodes from unresolved links (knowledge gaps) */
	showGhosts: boolean;
}

export const DEFAULT_SETTINGS: NeuralVaultSettings = {
	modules: DEFAULT_MODULES,
	showOrphans: false,
	showGhosts: true,
};

export async function loadSettings(plugin: Plugin): Promise<NeuralVaultSettings> {
	const data = (await plugin.loadData()) as Partial<NeuralVaultSettings> | null;
	return Object.assign({}, DEFAULT_SETTINGS, data);
}

export async function saveSettings(plugin: Plugin, settings: NeuralVaultSettings): Promise<void> {
	await plugin.saveData(settings);
}

export class NeuralVaultSettingTab extends PluginSettingTab {
	private plugin: NeuralVaultPlugin;

	constructor(app: App, plugin: NeuralVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Vault Bloom" });

		new Setting(containerEl)
			.setName("Show orphan notes")
			.setDesc("Notes without any link, shown as dim dust (same as native graph orphans).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showOrphans).onChange(async (value) => {
					this.plugin.settings.showOrphans = value;
					await saveSettings(this.plugin, this.plugin.settings);
					this.plugin.refreshGraph();
				})
			);

		new Setting(containerEl)
			.setName("Show ghost nodes")
			.setDesc("Unresolved [[links]] to notes that do not exist yet - the gaps in your knowledge.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showGhosts).onChange(async (value) => {
					this.plugin.settings.showGhosts = value;
					await saveSettings(this.plugin, this.plugin.settings);
					this.plugin.refreshGraph();
				})
			);

		new Setting(containerEl)
			.setName("Module rules")
			.setDesc(
				"Module grouping rules are stored in data.json under \"modules\". " +
				"Each rule: { \"type\": \"path\" | \"tag\", \"value\": \"...\" }. " +
				"Visual rule editor comes in Phase 3."
			)
			.addButton((button) =>
				button.setButtonText("Open data.json folder").onClick(() => {
					// Best effort: open the plugin folder in the system file explorer.
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const electron = (window as any).require?.("electron");
					if (electron?.shell) {
						electron.shell.showItemInFolder(this.plugin.manifest.dir + "/data.json");
					}
				})
			);
	}
}
