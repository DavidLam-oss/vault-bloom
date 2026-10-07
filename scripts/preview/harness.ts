// Browser preview harness: mounts the REAL dashboard chrome + ThreeRenderer
// against a synthetic vault, so the UI can be reviewed and screenshotted
// without launching Obsidian. This is the "web preview dev loop" the plan
// lists as optional Phase 2/3 engineering work.
//
// Build:  node scripts/preview/build.mjs
// Shoot:  node scripts/preview/cdp.mjs "file://.../scripts/preview/.out/index.html" shot /tmp/x.png
//
// Query params:
//   theme=dark|light   which Obsidian theme class to emulate. The fake chrome
//                      strip follows it, the view must NOT: the dashboard is a
//                      fixed dark studio, so both values should render the same
//                      canvas. That difference is the fixture.
//   focus=<moduleId>   drill into a module after the layout settles
//   notes/links/ghosts/seed  resize the synthetic fixture
//   motion=reduce      emulate prefers-reduced-motion
//   settle=1           converge the layout synchronously (byte-comparable shots)
//   details=1          expand the debug drawer

import { DEFAULT_SPEC, buildSyntheticGraph, makeRng } from "./synthetic-graph";
import { ThreeRenderer } from "../../src/render/three-renderer";
import { buildChrome } from "../../src/view/dashboard-chrome";
import { resolveReducedMotion, type MotionSetting } from "../../src/render/motion";
import type { GraphNode } from "../../src/data/types";

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
	const raw = params.get(key);
	return raw === null ? fallback : Number(raw);
};

// Deterministic layout: seeded PRNG replaces Math.random BEFORE any layout runs.
const seed = num("seed", DEFAULT_SPEC.seed);
Math.random = makeRng(seed);

const graph = buildSyntheticGraph({
	seed,
	notes: num("notes", DEFAULT_SPEC.notes),
	links: num("links", DEFAULT_SPEC.links),
	ghosts: num("ghosts", DEFAULT_SPEC.ghosts),
});

const showGhosts = params.get("ghosts-toggle") !== "0";
const showOrphans = params.get("orphans") === "1";
const motionSetting: MotionSetting = params.get("motion") === "reduce" ? "reduce" : "system";

// Emulate an Obsidian theme. Only the fake chrome strip reacts to it; the
// dashboard view is a fixed dark studio (see src/render/palette.ts).
const theme = params.get("theme") === "light" ? "light" : "dark";
document.body.className = `theme-${theme}`;
const themeLabel = document.getElementById("themename");
if (themeLabel) themeLabel.textContent = theme;

const root = document.getElementById("root")!;

const chrome = buildChrome(root, {
	onFocusModule: (moduleId) => renderer.focusModule(moduleId),
	onClearFocus: () => renderer.clearFocus(),
	onFitView: () => renderer.fitView(),
	onRebuild: () => location.reload(),
	onToggleGhosts: (value) => log(`toggle ghosts -> ${value}`),
	onToggleOrphans: (value) => log(`toggle orphans -> ${value}`),
	onOpenNote: (path) => log(`open ${path}`),
});

const renderer = new ThreeRenderer({
	onNodeHover: (node: GraphNode | null) => {
		chrome.setHover(node ? `${node.title} · ${node.degree} links` : idle());
	},
	onHubHover: (hub) => {
		chrome.setHover(hub ? `${hub.name} · ${hub.count} notes` : idle());
	},
	onNodeFocused: (node) => {
		if (node) chrome.setHover(`selected: ${node.title}`);
	},
	onModuleFocus: (moduleId) => {
		const def = graph.modules.find((m) => m.id === moduleId);
		chrome.setFocused(moduleId, def?.name ?? "");
	},
	onNodeOpen: () => { /* no editor in the harness */ },
});

function idle(): string | null {
	const focused = renderer.getFocusedModule();
	if (!focused) return null;
	const def = graph.modules.find((m) => m.id === focused);
	return `Focused: ${def?.name ?? focused}`;
}

function log(message: string): void {
	console.log(`[chrome] ${message}`);
}

renderer.mount(chrome.canvasWrap);

// Same data flow as DashboardView.pushData().
chrome.setStats({
	notes: graph.snapshot.noteCount,
	links: graph.snapshot.edgeCount,
	ghosts: graph.snapshot.ghostCount,
	orphans: graph.snapshot.orphanCount,
	buildMs: graph.snapshot.buildMs,
});
chrome.setModules(
	graph.modules
		.map((def) => ({
			id: def.id,
			name: def.name,
			color: def.color,
			count: graph.moduleCounts[def.id] ?? 0,
		}))
		.filter((row) => row.count > 0)
		.sort((a, b) => b.count - a.count)
);
chrome.setTopNotes(
	graph.nodes
		.filter((n) => n.kind === "note" && n.degree > 0)
		.sort((a, b) => b.degree - a.degree)
		.slice(0, 15)
		.map((n) => ({ title: n.title, path: n.path, degree: n.degree }))
);
chrome.setToggles({ showGhosts, showOrphans });

renderer.setData(graph, {
	showOrphans,
	showGhosts,
	reducedMotion: resolveReducedMotion(motionSetting),
});

// ?settle=1 runs the force layout to convergence synchronously and refits the
// camera. Without it the node positions at capture time depend on how many
// animation frames the (software-rendered) browser managed to draw, which makes
// two screenshots of the same fixture incomparable. Pair with motion=reduce for
// a fully frozen frame.
if (params.get("settle") === "1") {
	(renderer as unknown as { layout: { prewarm(ticks?: number): void } })
		.layout.prewarm();
	renderer.fitView();
}

declare global {
	interface Window {
		__vb: {
			renderer: ThreeRenderer;
			graph: typeof graph;
			moduleIds: string[];
			stats: () => unknown;
		};
	}
}

window.__vb = {
	renderer,
	graph,
	moduleIds: graph.modules.filter((m) => (graph.moduleCounts[m.id] ?? 0) > 0).map((m) => m.id),
	stats: () => ({
		notes: graph.snapshot.noteCount,
		links: graph.snapshot.edgeCount,
		ghosts: graph.snapshot.ghostCount,
		drawCalls: (renderer as unknown as { three: { info: { render: { calls: number } } } })
			.three?.info?.render?.calls,
	}),
};

console.log(
	`harness: ${graph.snapshot.noteCount} notes, ${graph.snapshot.edgeCount} links, ` +
	`${graph.snapshot.ghostCount} ghosts, theme=${document.body.className}`
);

// ?focus=<moduleId> renders the drill-down state without a mouse.
const focusId = params.get("focus");
if (focusId) setTimeout(() => renderer.focusModule(focusId), 2500);

// ?details=1 expands the debug drawer for review.
if (params.get("details") === "1") {
	document.querySelector<HTMLDetailsElement>(".nv-details")!.open = true;
}

// ?card=1 injects a static focus card.
//
// The real FocusCard resolves its content through Obsidian's App / TFile (vault
// reads), which does not exist in the browser harness - so this fixture is here
// to exercise the card's CSS (bare <button>, backlink <a>, scrollbar), which
// would otherwise be the one surface never rendered. Keep the markup in sync
// with src/view/focus-card.ts.
if (params.get("card") === "1") {
	chrome.canvasWrap.insertAdjacentHTML(
		"beforeend",
		`<div class="nv-fcard nv-fcard-visible">
			<div class="nv-fcard-head">
				<div class="nv-fcard-title">2026-10-07</div>
				<div class="nv-fcard-close">✕</div>
			</div>
			<div class="nv-fcard-body">
				<div class="nv-fcard-meta">12 links · 4 backlinks</div>
				<div class="nv-fcard-tags"><span>#diary</span><span>#learn</span></div>
				<div class="nv-fcard-snippet">今天把仪表盘的呈现固定成深色了。</div>
				<div class="nv-fcard-backlinks">
					<div class="nv-fcard-section">Linked from</div>
					<ul>
						<li><a href="#">Learn/SEO/索引.md</a></li>
						<li><a href="#">Diary/2026-10-06.md</a></li>
					</ul>
				</div>
				<button class="nv-btn nv-fcard-open">Open note</button>
			</div>
		</div>`
	);
}
