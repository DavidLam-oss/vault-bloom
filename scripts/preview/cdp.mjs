// Minimal zero-dependency CDP driver for the Vault Bloom preview harness.
// Uses Node 22's built-in WebSocket; launches chrome-headless-shell with
// software WebGL (SwiftShader) so the three.js canvas actually renders.
//
//   node scripts/preview/cdp.mjs <url> eval "<js expression>"
//   node scripts/preview/cdp.mjs <url> shot <out.png> [waitMs]
//
// Env: REDUCED=1 emulates prefers-reduced-motion: reduce
//      WIDTH/HEIGHT override the emulated viewport (default 1440x900)
//      CLIP="x,y,w,h" captures just that rectangle (region-by-region diffs)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function findChrome() {
	const root = path.join(os.homedir(), "Library/Caches/ms-playwright");
	const revs = fs.existsSync(root)
		? fs.readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()
		: [];
	for (const rev of revs) {
		const bin = path.join(root, rev, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
		if (fs.existsSync(bin)) return bin;
	}
	throw new Error("chrome-headless-shell not found under " + root);
}

const BIN = process.env.CHROME_BIN || findChrome();
const PORT = Number(process.env.CDP_PORT || 9333);
const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Number(process.env.HEIGHT || 900);

const [url, cmd, payload, extra] = process.argv.slice(2);
if (!url || !cmd) {
	console.error("usage: node cdp.mjs <url> eval|shot <payload> [extra]");
	process.exit(2);
}

const proc = spawn(BIN, [
	"--headless",
	"--no-sandbox",
	"--hide-scrollbars",
	"--disable-dev-shm-usage",
	// Software WebGL: without these the canvas silently renders black.
	"--use-gl=angle",
	"--use-angle=swiftshader",
	"--enable-unsafe-swiftshader",
	"--enable-webgl",
	"--ignore-gpu-blocklist",
	`--remote-debugging-port=${PORT}`,
	`--window-size=${WIDTH},${HEIGHT}`,
	"about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let stderrBuf = "";
proc.stderr.on("data", (d) => { stderrBuf += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			const j = await r.json();
			if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
		} catch { /* not up yet */ }
		await sleep(150);
	}
	throw new Error("chrome did not start:\n" + stderrBuf.slice(-800));
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
const events = [];
const consoleLogs = [];
ws.onmessage = (m) => {
	const msg = JSON.parse(m.data);
	if (msg.id && pending.has(msg.id)) {
		const { res, rej } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
	} else if (msg.method) {
		events.push(msg);
		if (msg.method === "Runtime.consoleAPICalled") {
			consoleLogs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
		}
		if (msg.method === "Runtime.exceptionThrown") {
			consoleLogs.push("EXCEPTION " + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
		}
	}
};

function send(method, params = {}, sessionId) {
	const id = nextId++;
	return new Promise((res, rej) => {
		pending.set(id, { res, rej });
		ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 60000);
	});
}

function waitEvent(method, sessionId, timeout = 20000) {
	const t0 = Date.now();
	return new Promise((res, rej) => {
		const tick = () => {
			const i = events.findIndex((e) => e.method === method && (!sessionId || e.sessionId === sessionId));
			if (i >= 0) { const e = events.splice(i, 1)[0]; return res(e); }
			if (Date.now() - t0 > timeout) return rej(new Error("event timeout " + method));
			setTimeout(tick, 50);
		};
		tick();
	});
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Emulation.setDeviceMetricsOverride",
	{ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
if (process.env.REDUCED === "1") {
	await send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	}, sessionId);
}

await send("Page.navigate", { url }, sessionId);
await waitEvent("Page.loadEventFired", sessionId).catch(() => {});
await sleep(Number(process.env.SETTLE_MS || 1400));

async function evaluate(expr) {
	const r = await send("Runtime.evaluate", {
		expression: expr, returnByValue: true, awaitPromise: true,
	}, sessionId);
	if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900));
	return r.result.value;
}

try {
	if (cmd === "eval") {
		console.log(JSON.stringify(await evaluate(payload), null, 1));
	} else if (cmd === "logs") {
		console.log(consoleLogs.join("\n") || "(no console output)");
	} else if (cmd === "shot") {
		const out = payload;
		// Let the force layout settle before the frame is captured.
		await sleep(extra !== undefined ? Number(extra) : 3000);
		const clip = process.env.CLIP
			? (() => {
					const [x, y, width, height] = process.env.CLIP.split(",").map(Number);
					return { x, y, width, height, scale: 1 };
				})()
			: undefined;
		const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip } : {}) }, sessionId);
		fs.writeFileSync(out, Buffer.from(data, "base64"));
		console.log("saved " + out);
		if (consoleLogs.length) console.log("--- console ---\n" + consoleLogs.slice(-15).join("\n"));
	} else {
		console.error("unknown cmd " + cmd);
		process.exit(2);
	}
} finally {
	ws.close();
	proc.kill("SIGKILL");
}
process.exit(0);
