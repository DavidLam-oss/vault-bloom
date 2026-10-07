// Dashboard chrome: everything around the WebGL canvas.
//
// Deliberately built with plain DOM APIs instead of Obsidian's createDiv /
// createEl helpers so the exact same markup can also be rendered by the
// headless preview harness (scripts/preview) - the UI can then be reviewed
// and screenshotted without launching Obsidian. DashboardView stays a thin
// adapter that mounts this plus the renderer.
//
// Layout: the canvas is the product, so it fills the view and every piece of
// chrome floats on top of it. Numbers that only matter while debugging live
// in a collapsed <details> beneath the canvas.

export interface ChromeStats {
	notes: number;
	links: number;
	ghosts: number;
	orphans: number;
	buildMs: number;
}

export interface ChromeModuleRow {
	id: string;
	name: string;
	color: string;
	count: number;
}

export interface ChromeTopNote {
	title: string;
	path: string;
	degree: number;
}

export interface ChromeToggles {
	showGhosts: boolean;
	showOrphans: boolean;
}

export interface ChromeCallbacks {
	onFocusModule(moduleId: string): void;
	onFitView(): void;
	onRebuild(): void;
	onToggleGhosts(value: boolean): void;
	onToggleOrphans(value: boolean): void;
	onOpenNote(path: string): void;
	onClearFocus(): void;
}

export interface DashboardChrome {
	/** the whole view body */
	root: HTMLElement;
	/** element the renderer mounts into (position: relative) */
	canvasWrap: HTMLElement;
	setStats(stats: ChromeStats): void;
	setModules(rows: ChromeModuleRow[]): void;
	setTopNotes(notes: ChromeTopNote[]): void;
	setToggles(toggles: ChromeToggles): void;
	/** hover read-out; null = idle hint */
	setHover(text: string | null): void;
	/** module drill-down state; null = overview */
	setFocused(moduleId: string | null, name: string): void;
	/** mark the active legend chip without changing focus */
	markFocusedChip(moduleId: string | null): void;
}

const IDLE_HINT =
	"Drag to rotate · Cmd/right-drag to pan · Scroll to zoom · Click a note to inspect";

/** Plain-DOM equivalent of Obsidian's `el.empty()`. */
function clear(el: HTMLElement): void {
	while (el.firstChild) el.removeChild(el.firstChild);
}

export function buildChrome(
	container: HTMLElement,
	cb: ChromeCallbacks
): DashboardChrome {
	clear(container);
	container.classList.add("nv-root");

	// --- canvas layer (the product) ---------------------------------------
	const canvasWrap = document.createElement("div");
	canvasWrap.className = "nv-canvas-wrap";
	container.appendChild(canvasWrap);

	const toolbar = document.createElement("div");
	toolbar.className = "nv-toolbar";
	canvasWrap.appendChild(toolbar);

	const backBtn = document.createElement("button");
	backBtn.className = "nv-btn nv-backbtn";
	backBtn.type = "button";
	backBtn.textContent = "← Overview";
	backBtn.title = "Leave module focus (Esc)";
	backBtn.addEventListener("click", () => cb.onClearFocus());
	toolbar.appendChild(backBtn);

	const spacer = document.createElement("div");
	spacer.className = "nv-toolbar-spacer";
	toolbar.appendChild(spacer);

	const toggles: Array<{ el: HTMLButtonElement; key: keyof ChromeToggles }> = [];
	for (const [key, label, title] of [
		["showGhosts", "Ghosts", "Show unresolved links as ghost nodes"],
		["showOrphans", "Orphans", "Show notes with no links"],
	] as const) {
		const btn = document.createElement("button");
		btn.className = "nv-btn nv-toggle";
		btn.type = "button";
		btn.textContent = label;
		btn.title = title;
		btn.addEventListener("click", () => {
			const on = btn.getAttribute("aria-pressed") !== "true";
			btn.setAttribute("aria-pressed", String(on));
			if (key === "showGhosts") cb.onToggleGhosts(on);
			else cb.onToggleOrphans(on);
		});
		toolbar.appendChild(btn);
		toggles.push({ el: btn, key });
	}

	const fitBtn = document.createElement("button");
	fitBtn.className = "nv-btn";
	fitBtn.type = "button";
	fitBtn.textContent = "Fit";
	fitBtn.title = "Frame the whole graph";
	fitBtn.addEventListener("click", () => cb.onFitView());
	toolbar.appendChild(fitBtn);

	const rebuildBtn = document.createElement("button");
	rebuildBtn.className = "nv-btn";
	rebuildBtn.type = "button";
	rebuildBtn.textContent = "Rebuild";
	rebuildBtn.title = "Re-read the vault graph";
	rebuildBtn.addEventListener("click", () => cb.onRebuild());
	toolbar.appendChild(rebuildBtn);

	// Legend: one chip per module, click to drill down.
	const legend = document.createElement("div");
	legend.className = "nv-legend";
	canvasWrap.appendChild(legend);

	const hoverBar = document.createElement("div");
	hoverBar.className = "nv-hoverbar";
	hoverBar.textContent = IDLE_HINT;
	canvasWrap.appendChild(hoverBar);

	// --- details layer (debug numbers, collapsed by default) ---------------
	const details = document.createElement("details");
	details.className = "nv-details";
	container.appendChild(details);

	const summary = document.createElement("summary");
	summary.textContent = "Vault details";
	details.appendChild(summary);

	const statsRow = document.createElement("div");
	statsRow.className = "nv-stats";
	details.appendChild(statsRow);

	const statValues = new Map<keyof ChromeStats, HTMLElement>();
	for (const [key, label] of [
		["notes", "notes"],
		["links", "links"],
		["ghosts", "ghosts"],
		["orphans", "orphans"],
		["buildMs", "build time"],
	] as const) {
		const box = document.createElement("div");
		box.className = "nv-stat";
		const value = document.createElement("div");
		value.className = "nv-stat-value";
		value.textContent = "–";
		const caption = document.createElement("div");
		caption.className = "nv-stat-label";
		caption.textContent = label;
		box.append(value, caption);
		statsRow.appendChild(box);
		statValues.set(key, value);
	}

	const topHeading = document.createElement("h4");
	topHeading.textContent = "Most linked notes";
	details.appendChild(topHeading);

	const topList = document.createElement("ul");
	topList.className = "nv-top-list";
	details.appendChild(topList);

	// --- imperative updates -------------------------------------------------
	const chipByModule = new Map<string, HTMLButtonElement>();

	function setStats(stats: ChromeStats): void {
		for (const [key, el] of statValues) {
			const value = key === "buildMs" ? `${stats[key]}ms` : String(stats[key]);
			el.textContent = value;
		}
	}

	function setModules(rows: ChromeModuleRow[]): void {
		clear(legend);
		chipByModule.clear();
		for (const row of rows) {
			const chip = document.createElement("button");
			chip.className = "nv-chip";
			chip.type = "button";
			chip.title = `Focus ${row.name} (${row.count} notes)`;
			const dot = document.createElement("span");
			dot.className = "nv-dot";
			dot.style.backgroundColor = row.color;
			const name = document.createElement("span");
			name.className = "nv-chip-name";
			name.textContent = row.name;
			const count = document.createElement("span");
			count.className = "nv-chip-count";
			count.textContent = String(row.count);
			chip.append(dot, name, count);
			chip.addEventListener("click", () => cb.onFocusModule(row.id));
			legend.appendChild(chip);
			chipByModule.set(row.id, chip);
		}
	}

	function setTopNotes(notes: ChromeTopNote[]): void {
		clear(topList);
		if (notes.length === 0) {
			const li = document.createElement("li");
			li.textContent = "No linked notes found.";
			topList.appendChild(li);
			return;
		}
		for (const note of notes) {
			const li = document.createElement("li");
			const link = document.createElement("a");
			link.href = "#";
			link.textContent = `${note.title} (${note.degree})`;
			link.addEventListener("click", (e) => {
				e.preventDefault();
				cb.onOpenNote(note.path);
			});
			li.appendChild(link);
			topList.appendChild(li);
		}
	}

	function setToggles(state: ChromeToggles): void {
		for (const { el, key } of toggles) {
			const on = state[key];
			el.setAttribute("aria-pressed", String(on));
			el.classList.toggle("nv-toggle-on", on);
		}
	}

	function markFocusedChip(moduleId: string | null): void {
		for (const [id, chip] of chipByModule) {
			chip.classList.toggle("nv-chip-focused", id === moduleId);
		}
	}

	function setHover(text: string | null): void {
		hoverBar.textContent = text ?? IDLE_HINT;
		hoverBar.classList.toggle("nv-hoverbar-active", text !== null);
	}

	function setFocused(moduleId: string | null, name: string): void {
		backBtn.classList.toggle("nv-visible", moduleId !== null);
		markFocusedChip(moduleId);
		if (moduleId) setHover(`Focused: ${name} · Esc or "Overview" to go back`);
		else setHover(null);
	}

	return {
		root: container,
		canvasWrap,
		setStats,
		setModules,
		setTopNotes,
		setToggles,
		setHover,
		setFocused,
		markFocusedChip,
	};
}
