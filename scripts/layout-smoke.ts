// Headless smoke test for ForceLayout: run in Node, assert positions sane.
// Bundle with: node esbuild.config.mjs is plugin-specific, so this uses its
// own esbuild invocation (see scripts/run-layout-smoke.sh or the npm-less cmd).

import { ForceLayout } from "../src/render/layout";
import { FlowLayer } from "../src/render/flow-particles";
import {
	createJellyfish,
	setJellyfishOpacity,
	updateJellyfish,
} from "../src/render/hub-jellyfish";
import { cssHex, PALETTE } from "../src/render/palette";
import * as paletteModule from "../src/render/palette";
import { resolveReducedMotion } from "../src/render/motion";
import {
	AdditiveBlending,
	Color,
	LineBasicMaterial,
	MeshBasicMaterial,
	Scene,
} from "three";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bundled to CJS by the npm "smoke" script, so __dirname is the scripts/ dir.
declare const __dirname: string;
import type { NeuralGraph, GraphNode, GraphEdge, ModuleDef } from "../src/data/types";

function fakeGraph(noteCount: number, edgeCount: number): NeuralGraph {
	const modules: ModuleDef[] = [
		{ id: "a", name: "A", color: "#e2557b", rules: [] },
		{ id: "b", name: "B", color: "#378add", rules: [] },
		{ id: "c", name: "C", color: "#ba7517", rules: [] },
	];
	const nodes: GraphNode[] = [];
	for (let i = 0; i < noteCount; i++) {
		nodes.push({
			id: `n${i}`,
			kind: "note",
			title: `note ${i}`,
			path: `n${i}.md`,
			moduleId: modules[i % 3].id,
			degree: 0,
			tags: [],
			mtime: 0,
			sizeBytes: 0,
		});
	}
	nodes.push({ id: "ghost:x", kind: "ghost", title: "x", path: "", moduleId: "concepts", degree: 0, tags: [], mtime: 0, sizeBytes: 0 });
	const edges: GraphEdge[] = [];
	for (let i = 0; i < edgeCount; i++) {
		const a = Math.floor(Math.random() * noteCount);
		const b = Math.floor(Math.random() * noteCount);
		if (a === b) continue;
		edges.push({ source: `n${a}`, target: `n${b}`, kind: "link" });
	}
	edges.push({ source: "n0", target: "ghost:x", kind: "ghost" });
	return {
		nodes,
		edges,
		modules,
		moduleCounts: {},
		snapshot: { generatedAt: "", noteCount: noteCount, ghostCount: 1, edgeCount: edges.length, orphanCount: 0, buildMs: 0 },
	};
}

const graph = fakeGraph(3000, 1500);
const visibleIds = new Set(graph.nodes.map((n) => n.id));

const layout = new ForceLayout();
const t0 = Date.now();
layout.update(graph, visibleIds);
layout.prewarm();
const elapsed = Date.now() - t0;

let nan = 0;
let maxR = 0;
const centroid = new Map<string, { x: number; y: number; z: number; n: number }>();
for (const n of layout.nodes) {
	if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) nan++;
	const r = Math.hypot(n.x, n.y, n.z);
	if (r > maxR) maxR = r;
	const c = centroid.get(n.moduleId) ?? { x: 0, y: 0, z: 0, n: 0 };
	c.x += n.x; c.y += n.y; c.z += n.z; c.n += 1;
	centroid.set(n.moduleId, c);
}
const centroids = Object.fromEntries(
	[...centroid.entries()].map(([k, v]) => [k, {
		x: Math.round(v.x / v.n),
		y: Math.round(v.y / v.n),
		z: Math.round(v.z / v.n),
		n: v.n,
	}])
);
const centers = Object.entries(centroids)
	.filter(([k]) => k !== "concepts")
	.map(([, v]) => [v.x, v.y, v.z] as const);
let minPairDist = Infinity;
for (let i = 0; i < centers.length; i++) {
	for (let j = i + 1; j < centers.length; j++) {
		const d = Math.hypot(
			centers[i][0] - centers[j][0],
			centers[i][1] - centers[j][1],
			centers[i][2] - centers[j][2]
		);
		if (d < minPairDist) minPairDist = d;
	}
}
console.log(JSON.stringify({
	elapsedMs: elapsed,
	nodeCount: layout.nodes.length,
	edgeCount: layout.edges.length,
	nanCount: nan,
	maxRadius: Math.round(maxR),
	minCentroidPairDist: Math.round(minPairDist),
	centroids,
}, null, 2));

// Incremental update: add one node, ensure old positions are kept (no jump).
const before = layout.nodes.slice(0, 5).map((n) => [n.id, n.x, n.y, n.z]);
const graph2 = fakeGraph(3001, 1500);
graph2.nodes[3000].id = "n-brand-new";
graph2.nodes[3000].moduleId = "a";
const visible2 = new Set(graph2.nodes.map((n) => n.id));
layout.update(graph2, visible2);
const after = before.map(([id]) => {
	const n = layout.nodes.find((x) => x.id === id);
	return [id, n?.x, n?.y, n?.z];
});
const jumped = before.filter((b, i) => {
	const a = after[i];
	return Math.hypot(a[1] - b[1], a[2] - b[2], a[3] - b[3]) > 0.001;
}).length;
console.log("pinned-unchanged:", jumped === 0 ? "PASS" : `FAIL (${jumped} jumped)`);
console.log("new-node-present:", layout.nodes.some((n) => n.id === "n-brand-new") ? "PASS" : "FAIL");

// Module-focus simulation: collapse the visible set to one module's members
// (what focusModule does), then expand back. Pinned nodes must not move and
// nothing may go NaN — this is the drill-down path from Phase 1.
const moduleAIds = new Set(
	graph2.nodes
		.filter((n) => n.moduleId === "a" || n.kind === "ghost")
		.map((n) => n.id)
);
layout.update(graph2, moduleAIds);
layout.prewarm();
const collapsedFinite = layout.nodes.every(
	(n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)
);
const collapsedCount = layout.nodes.length === moduleAIds.size;
console.log(
	"focus-collapse:",
	collapsedFinite && collapsedCount ? "PASS" : `FAIL (finite=${collapsedFinite}, count=${layout.nodes.length}/${moduleAIds.size})`
);

// Expand back to the overview: positions of nodes that survived both ways
// must be identical (they were pinned through the whole round trip).
const pinnedIds = before.map((b) => b[0]).filter((id) => moduleAIds.has(id));
layout.update(graph2, visible2);
const roundTrip = pinnedIds.map((id) => {
	const n0 = before.find((b) => b[0] === id)!;
	const n1 = layout.nodes.find((x) => x.id === id);
	const d = Math.hypot(n1!.x - n0[1], n1!.y - n0[2], n1!.z - n0[3]);
	return d;
});
const roundTripJumps = roundTrip.filter((d) => d > 0.001).length;
console.log(
	"focus-roundtrip-pinned:",
	roundTripJumps === 0 ? "PASS" : `FAIL (${roundTripJumps}/${pinnedIds.length} jumped)`
);

// --- layout must go idle once it has cooled ------------------------------
// Regression guard: previously the render loop kept ticking the simulation
// (and rewriting the whole position cache) forever after convergence, because
// d3's alpha decays towards zero without ever reaching it.
let idleGuard = 0;
while (layout.tick() && idleGuard++ < 5000) { /* settle */ }
const frozenBefore = layout.nodes.map((n) => [n.x, n.y, n.z] as const);
for (let i = 0; i < 120; i++) layout.tick();
const drift = layout.nodes.reduce((max, n, i) => {
	const b = frozenBefore[i];
	return Math.max(max, Math.hypot(n.x - b[0], n.y - b[1], n.z - b[2]));
}, 0);
console.log(
	"layout-idle-frozen:",
	drift === 0 ? "PASS" : `FAIL (drifted ${drift.toFixed(6)})`
);

// --- prefers-reduced-motion must freeze the edge particles ---------------
const motionScene = new Scene();
const flow = new FlowLayer(motionScene, PALETTE);
flow.rebuild(
	buildTestSegments(),
	[
		{ x: 0, y: 0, z: 0 },
		{ x: 100, y: 0, z: 0 },
	]
);
const flowNodes = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }];

flow.setMotionEnabled(false);
flow.update(1 / 60, flowNodes);
const frozen = Float32Array.from(flow.positionBuffer);
for (let i = 0; i < 30; i++) flow.update(1 / 60, flowNodes);
const frozenDelta = maxDelta(frozen, flow.positionBuffer);

flow.setMotionEnabled(true);
const moving = Float32Array.from(flow.positionBuffer);
for (let i = 0; i < 30; i++) flow.update(1 / 60, flowNodes);
const movingDelta = maxDelta(moving, flow.positionBuffer);

console.log(
	"reduced-motion-particles-frozen:",
	frozenDelta === 0 ? "PASS" : `FAIL (moved ${frozenDelta.toFixed(4)})`
);
console.log(
	"normal-motion-particles-stream:",
	movingDelta > 1 ? "PASS" : `FAIL (only ${movingDelta.toFixed(4)})`
);

// --- motion preference resolution ----------------------------------------
const motionOk =
	resolveReducedMotion("reduce") === true &&
	resolveReducedMotion("full") === false &&
	// Node has no window: "system" must degrade to no-reduction, not throw.
	resolveReducedMotion("system") === false;
console.log("motion-setting-resolves:", motionOk ? "PASS" : "FAIL");

// --- the canvas is a fixed dark studio -----------------------------------
// The view deliberately does NOT follow the Obsidian theme: every effect in
// it (glow, jellyfish, particles) is additive-blended and dies on a light
// surface. These three assertions are the guard rail for that decision - a
// well-meaning "support light mode" change has to trip at least one of them.
const bg = new Color(PALETTE.background);
const bgLuminance = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
console.log(
	"canvas-always-dark:",
	bgLuminance < 0.2 ? "PASS" : `FAIL (background luminance ${bgLuminance.toFixed(3)})`
);
console.log(
	"canvas-glow-additive:",
	PALETTE.flowBlending === AdditiveBlending ? "PASS" : "FAIL"
);
const themeless =
	!("buildPalette" in paletteModule) &&
	!("LIGHT_PALETTE" in paletteModule) &&
	!("DARK_PALETTE" in paletteModule);
console.log(
	"palette-has-no-theme-branch:",
	themeless ? "PASS" : "FAIL (palette.ts resolves a palette from the host again)"
);

// The canvas wrapper is tinted by CSS before the first WebGL frame lands, and
// that tint is a literal in styles.css. Keep it equal to the palette's own
// background or the view flashes the wrong colour on open.
const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
const tint = css.match(/--nv-canvas-bg:\s*(#[0-9a-fA-F]{6})/);
console.log(
	"css-canvas-tint-matches-palette:",
	tint && tint[1].toLowerCase() === cssHex(PALETTE.background)
		? "PASS"
		: `FAIL (css ${tint?.[1] ?? "missing"} vs palette ${cssHex(PALETTE.background)})`
);

// Same decision, other half: the overlay chrome (toolbar, chips, focus card)
// must read the --nv-* studio tokens, not Obsidian's theme variables. A single
// var(--background-*) creeping back in would flip that element with the theme
// and put pale-on-dark text in the middle of the picture.
const themeVarsInCss = (css.match(/var\(--(background|text|link|interactive|divider)-/g) ?? []).length;
console.log(
	"chrome-does-not-follow-theme:",
	themeVarsInCss === 0
		? "PASS"
		: `FAIL (${themeVarsInCss} Obsidian theme vars left in styles.css)`
);

// --- jellyfish hub: swim pulse, reduced-motion freeze, pick bound ---------
// Runs in Node: the bell is pure geometry + vertex colours, so no WebGL,
// no canvas texture and no DOM are involved.
const jellyScene = new Scene();
const jelly = createJellyfish(
	jellyScene,
	"a",
	800,
	new Color(0xe2557b),
	PALETTE,
	{ x: 0, y: 0, z: 0 }
);
const bellPos = (): Float32Array =>
	jelly.bell.geometry.getAttribute("position").array as Float32Array;
const filamentPos = (): Float32Array =>
	jelly.filaments.geometry.getAttribute("position").array as Float32Array;

// Motion on -> the bell actually breathes.
updateJellyfish(jelly, 1 / 60, true);
const bellA = Float32Array.from(bellPos());
for (let i = 0; i < 20; i++) updateJellyfish(jelly, 1 / 60, true);
const pulse = maxDelta(bellA, bellPos());
console.log(
	"jellyfish-swim-pulse:",
	pulse > 0.01 ? "PASS" : `FAIL (only moved ${pulse.toFixed(5)})`
);

// Motion off -> bell AND filaments hold still, frame after frame.
updateJellyfish(jelly, 1 / 60, false);
const stillBell = Float32Array.from(bellPos());
const stillFilament = Float32Array.from(filamentPos());
for (let i = 0; i < 30; i++) updateJellyfish(jelly, 1 / 60, false);
const bellDrift = maxDelta(stillBell, bellPos());
const filamentDrift = maxDelta(stillFilament, filamentPos());
console.log(
	"jellyfish-reduced-motion-frozen:",
	bellDrift === 0 && filamentDrift === 0
		? "PASS"
		: `FAIL (bell ${bellDrift}, filaments ${filamentDrift})`
);

// The raycast early-out uses the bell's bounding sphere, computed once at
// build time. Sweep a whole pulse and prove it still contains every animated
// vertex — otherwise clicking a hub would start missing as it swims.
const sphere = jelly.bell.geometry.boundingSphere!;
let maxAnimated = 0;
for (let step = 0; step < 240; step++) {
	jelly.phase = (step / 240) * Math.PI * 2;
	updateJellyfish(jelly, 0, true);
	const arr = bellPos();
	for (let i = 0; i < arr.length; i += 3) {
		maxAnimated = Math.max(
			maxAnimated,
			Math.hypot(
				arr[i] - sphere.center.x,
				arr[i + 1] - sphere.center.y,
				arr[i + 2] - sphere.center.z
			)
		);
	}
}
console.log(
	"jellyfish-pick-bound-valid:",
	maxAnimated <= sphere.radius
		? "PASS"
		: `FAIL (${maxAnimated.toFixed(3)} > ${sphere.radius.toFixed(3)})`
);

// Module focus must dim the bell and its filaments together.
const fullBell = (jelly.bell.material as MeshBasicMaterial).opacity;
const fullFilament = (jelly.filaments.material as LineBasicMaterial).opacity;
setJellyfishOpacity(jelly, 0.16);
const dimBell = (jelly.bell.material as MeshBasicMaterial).opacity;
const dimFilament = (jelly.filaments.material as LineBasicMaterial).opacity;
setJellyfishOpacity(jelly, 1);
console.log(
	"jellyfish-focus-dim:",
	dimBell < fullBell && dimFilament < fullFilament ? "PASS" : "FAIL"
);

function maxDelta(a: Float32Array, b: Float32Array): number {
	let max = 0;
	for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
	return max;
}

/** One link segment plus one module tendril (hub -> member). */
function buildTestSegments() {
	return [
		{
			aIdx: 0,
			bIdx: 1,
			aId: "a",
			bId: "b",
			color: new Color(0x9db4e6),
			kind: "link" as const,
		},
		{
			aIdx: -1,
			fixedA: { x: 0, y: 0, z: 0 },
			aId: null,
			bIdx: 1,
			bId: "b",
			color: new Color(0x7f77dd),
			kind: "tendril" as const,
		},
	];
}
