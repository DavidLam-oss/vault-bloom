// Copy build artifacts into the Obsidian vault plugin directory so the plugin
// can be reloaded for testing. Override the target with VAULT_BLOOM_TARGET.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TARGET = join(
	homedir(),
	"Documents/Obsidian/MyVault/.obsidian/plugins/vault-bloom"
);

const target = process.env.VAULT_BLOOM_TARGET
	? join(process.cwd(), process.env.VAULT_BLOOM_TARGET)
	: DEFAULT_TARGET;

mkdirSync(target, { recursive: true });

const artifacts = ["main.js", "manifest.json", "styles.css"];
for (const name of artifacts) {
	copyFileSync(join(process.cwd(), name), join(target, name));
	console.log(`deployed ${name} -> ${join(target, name)}`);
}
console.log(`\nDone. Reload the plugin in Obsidian to see changes.`);
