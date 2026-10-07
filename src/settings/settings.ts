// Plugin settings.
//
// Phase 1 shipped the two graph toggles; module rules still live in data.json
// (the visual rule editor is a Phase 3 item). The motion preference is here
// because prefers-reduced-motion is a Phase 2 acceptance point.

import { Plugin, PluginSettingTab, App, Setting } from "obsidian";
import { ModuleDef } from "../data/types";
import { DEFAULT_MODULES } from "../data/modules";
import { MOTION_OPTIONS, type MotionSetting } from "../render/motion";
import type VaultBloomPlugin from "../main";

export interface VaultBloomSettings {
	modules: ModuleDef[];
	/** show notes without any link (native graph "orphans" toggle) */
	showOrphans: boolean;
	/** show ghost nodes from unresolved links (knowledge gaps) */
	showGhosts: boolean;
	/** prefers-reduced-motion handling */
	motion: MotionSetting;
}

export const DEFAULT_SETTINGS: VaultBloomSettings = {
	modules: DEFAULT_MODULES,
	showOrphans: false,
	showGhosts: true,
	motion: "system",
};

export async function loadSettings(plugin: Plugin): Promise<VaultBloomSettings> {
	const data = (await plugin.loadData()) as Partial<VaultBloomSettings> | null;
	return Object.assign({}, DEFAULT_SETTINGS, data);
}

export async function saveSettings(plugin: Plugin, settings: VaultBloomSettings): Promise<void> {
	await plugin.saveData(settings);
}

export class VaultBloomSettingTab extends PluginSettingTab {
	private plugin: VaultBloomPlugin;

	constructor(app: App, plugin: VaultBloomPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Vault Bloom" });

		containerEl.createEl("h3", { text: "Graph" });

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

		containerEl.createEl("h3", { text: "Motion" });

		new Setting(containerEl)
			.setName("Animation")
			.setDesc(
				"The dashboard animates continuously (force layout, edge particles, " +
				"camera flights and a slow orbit after you focus a note). " +
				"\"Follow system\" honours your OS 'reduce motion' setting."
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(MOTION_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.motion).onChange(async (value) => {
					this.plugin.settings.motion = value as MotionSetting;
					await saveSettings(this.plugin, this.plugin.settings);
					this.plugin.refreshGraph();
				});
			});

		new Setting(containerEl)
			.setName("Module rules")
			.setDesc(
				"Module grouping rules are stored in data.json under \"modules\". " +
				"Each rule: { \"type\": \"path\" | \"tag\", \"value\": \"...\" }. " +
				"First matching module wins, in list order."
			)
			.addButton((button) =>
				button.setButtonText("Open plugin folder").onClick(() => {
					// Best effort: reveal the plugin folder in the system file explorer.
					const req = (window as unknown as {
						require?: (module: string) => unknown;
					}).require;
					const electron = req?.("electron") as
						| { shell?: { showItemInFolder(path: string): void } }
						| undefined;
					const dir = this.plugin.manifest.dir;
					if (electron?.shell && dir) {
						electron.shell.showItemInFolder(`${dir}/data.json`);
					}
				})
			);
	}
}
