// Focus card - a draggable info card pinned next to the currently
// selected (flown-to) note: backlinks, tags, content snippet, open button.
// Pure view-layer: the renderer only reports selection via onNodeFocused.

import { App, getAllTags, Notice, TFile } from "obsidian";
import type { GraphNode } from "../data/types";

/** Rendered length of the content snippet, in characters. */
const SNIPPET_CHARS = 180;

export class FocusCard {
	private el: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	/** guards against stale async fills when selection changes fast */
	private requestId = 0;

	constructor(
		private app: App,
		private host: HTMLElement
	) {}

	dispose(): void {
		this.el?.remove();
		this.el = null;
	}

	show(node: GraphNode): void {
		if (!this.el) this.build();
		this.el?.addClass("nv-fcard-visible");
		this.titleEl?.setText(node.title);
		this.bodyEl?.setText("Loading…");
		void this.fill(node, ++this.requestId);
	}

	hide(): void {
		this.requestId++;
		this.el?.removeClass("nv-fcard-visible");
	}

	private build(): void {
		if (!this.host) return;
		const el = createDiv("nv-fcard");
		const header = el.createDiv("nv-fcard-head");
		this.titleEl = header.createDiv("nv-fcard-title");
		const close = header.createDiv("nv-fcard-close");
		close.setText("✕");
		close.addEventListener("click", () => this.hide());

		this.bodyEl = el.createDiv("nv-fcard-body");

		// Drag by the header (pointer events; card is position:absolute).
		header.addEventListener("pointerdown", (e) => {
			if ((e.target as HTMLElement).hasClass("nv-fcard-close")) return;
			const startLeft = el.offsetLeft;
			const startTop = el.offsetTop;
			const startX = e.clientX;
			const startY = e.clientY;
			const move = (ev: PointerEvent): void => {
				el.style.left = `${startLeft + ev.clientX - startX}px`;
				el.style.top = `${startTop + ev.clientY - startY}px`;
			};
			const up = (): void => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		});

		el.addEventListener("dblclick", (e) => e.stopPropagation());
		this.host.appendChild(el);
		this.el = el;
	}

	/** Resolve the note file and render tags / backlinks / snippet. */
	private async fill(node: GraphNode, id: number): Promise<void> {
		const file = node.path
			? this.app.vault.getAbstractFileByPath(node.path)
			: null;
		if (!(file instanceof TFile)) {
			this.bodyEl?.setText("Unresolved link - note not created yet.");
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = (cache ? getAllTags(cache) : [])?.slice(0, 8) ?? [];
		// This Obsidian API level has no getBacklinksForFile; derive the
		// backlink list from resolvedLinks (one O(notes) scan per fill).
		const backlinks = Object.entries(this.app.metadataCache.resolvedLinks)
			.filter(([, dests]) => node.path! in dests)
			.map(([src]) => src);
		const snippet = extractSnippet(await this.app.vault.cachedRead(file));
		if (id !== this.requestId || !this.bodyEl) return;

		this.bodyEl.empty();
		const meta = this.bodyEl.createDiv("nv-fcard-meta");
		meta.setText(`${node.degree} links · ${backlinks.length} backlinks`);

		if (tags.length > 0) {
			const tagRow = this.bodyEl.createDiv("nv-fcard-tags");
			for (const tag of tags) tagRow.createSpan({ text: tag });
		}

		this.bodyEl.createDiv({ cls: "nv-fcard-snippet", text: snippet });

		const links = this.bodyEl.createDiv("nv-fcard-backlinks");
		links.createDiv("nv-fcard-section").setText("Linked from");
		const list = links.createEl("ul");
		for (const src of backlinks.slice(0, 6)) {
			const li = list.createEl("li");
			const a = li.createEl("a", { text: src });
			a.href = "#";
			a.addEventListener("click", (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(src, "");
			});
		}
		if (backlinks.length > 6) {
			list.createEl("li", { text: `…and ${backlinks.length - 6} more` });
		}
		if (backlinks.length === 0) {
			list.createEl("li", { text: "No backlinks yet." });
		}

		// nv-btn pins the studio button colours; see the reset note in styles.css.
		const open = this.bodyEl.createEl("button", { text: "Open note" });
		open.addClass("nv-btn", "nv-fcard-open");
		open.addEventListener("click", () => {
			if (node.path) void this.app.workspace.openLinkText(node.path, "");
			else new Notice("Unresolved link - note not created yet.");
		});
	}
}

/** First readable lines of a note: frontmatter and headings stripped. */
function extractSnippet(raw: string): string {
	let text = raw;
	if (text.startsWith("---")) {
		const end = text.indexOf("\n---", 3);
		if (end >= 0) text = text.slice(end + 4);
	}
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#") && !l.startsWith("![") &&
			!l.startsWith("%%") && !l.startsWith("> [!"));
	return lines.join(" ").slice(0, SNIPPET_CHARS) || "(empty note)";
}
