// Bundles the preview harness into scripts/preview/.out/ (IIFE, so it loads
// straight from file:// - no dev server needed) together with an index.html
// that pulls in the plugin's real styles.css.
//
// The page fakes an Obsidian window: a chrome strip on top that DOES follow
// the emulated theme, and the view underneath. Switching ?theme=light tints
// the strip light and leaves the view dark - that contrast is the fixture for
// "the dashboard must never go light".

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, ".out");
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
	entryPoints: [path.join(here, "harness.ts")],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2019",
	outfile: path.join(outDir, "harness.js"),
	sourcemap: false,
	logLevel: "warning",
	define: { "process.env.NODE_ENV": '"production"' },
});

const css = fs.readFileSync(path.join(here, "..", "..", "styles.css"), "utf8");

fs.writeFileSync(
	path.join(outDir, "index.html"),
	`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Vault Bloom preview</title>
<style>
	:root {
		--background-primary: #0b0f17;
		--background-secondary: #141a26;
		--background-modifier-border: #2a3348;
		--background-modifier-hover: #1d2536;
		--text-normal: #d7e0f2;
		--text-muted: #8291ad;
		--text-faint: #5d6b86;
		--text-accent: #7fa9ff;
}
	body.theme-light {
		--background-primary: #fbfbfd;
		--background-secondary: #ffffff;
		--background-modifier-border: #dde2ec;
		--background-modifier-hover: #eef1f7;
		--text-normal: #1d2433;
		--text-muted: #5c6880;
		--text-faint: #8b95a8;
		--text-accent: #2f5fd0;
	}
	html, body { margin: 0; height: 100%; }
	body {
		background: var(--background-primary);
		color: var(--text-normal);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	}
	/* fake Obsidian window: the strip follows the theme, the view does not */
	#shell { display: flex; flex-direction: column; height: 100vh; }
	#obsidian-chrome {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 38px;
		padding: 0 14px;
		background: var(--background-secondary);
		color: var(--text-muted);
		border-bottom: 1px solid var(--background-modifier-border);
		font-size: 12px;
	}
	#obsidian-chrome .dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: var(--text-accent);
	}
	#root {
		flex: 1 1 auto;
		min-height: 0;
		padding: 12px;
		box-sizing: border-box;
	}
${css}
	/* preview-only: give the canvas the rest of the window */
	.nv-canvas-wrap { height: 100%; margin: 0; }
</style>
</head>
<body class="theme-dark">
<div id="shell">
	<div id="obsidian-chrome"><span class="dot"></span><span>Obsidian chrome (follows the theme) - theme=<b id="themename">dark</b></span></div>
	<div id="root"></div>
</div>
<script src="./harness.js"></script>
</body>
</html>
`
);

console.log("preview built -> " + path.relative(process.cwd(), path.join(outDir, "index.html")));
