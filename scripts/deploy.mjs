// Copy build artifacts into the Obsidian vault plugin directory so the plugin
// can be reloaded for testing. Override the target with NEURAL_VAULT_TARGET.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TARGET = join(
	homedir(),
	"Documents/Obsidian/MyVault/.obsidian/plugins/neural-vault"
);

const target = process.env.NEURAL_VAULT_TARGET
	? join(process.cwd(), process.env.NEURAL_VAULT_TARGET)
	: DEFAULT_TARGET;

mkdirSync(target, { recursive: true });

const artifacts = ["main.js", "manifest.json", "styles.css"];
for (const name of artifacts) {
	copyFileSync(join(process.cwd(), name), join(target, name));
	console.log(`deployed ${name} -> ${join(target, name)}`);
}
console.log(`\nDone. Reload the plugin in Obsidian to see changes.`);
