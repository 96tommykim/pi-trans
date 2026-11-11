// How a reply is drawn in each view. Pure functions: the translations come in
// as an array (null where missing), the markdown or the rows come out.
// Layout rules follow cc-trans (MIT, github.com/midagedev/cc-trans).

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Block, buildBlock, type Plan, planMarkdown, unmaskAt } from "./markdown.ts";

export const VIEWS = [
	"auto",
	"stacked",
	"interleave",
	"side",
	"below",
	"translated",
	"original",
] as const;
export type View = (typeof VIEWS)[number];
export type EffectiveView = Exclude<View, "auto">;
export type Note = "pending" | "failed" | undefined;
type Out = readonly (string | null | undefined)[];

export const SIDE_AUTO_MIN_COLUMNS = 140;
export const SIDE_MIN_COLUMNS = 100;

/** `auto` is side on wide terminals; an explicit side degrades to stacked on narrow ones. */
export function effectiveView(
	view: View,
	columns: number = process.stdout.columns || 80,
): EffectiveView {
	if (view === "auto") return columns >= SIDE_AUTO_MIN_COLUMNS ? "side" : "stacked";
	if (view === "side" && columns < SIDE_MIN_COLUMNS) return "stacked";
	return view;
}

const TRANSLATABLE = new Set(["prose", "heading", "list", "quote", "table"]);

const hasUnits = (block: Block) => block.parts.some((p) => typeof p !== "string");

/** The block's translation, or null when it has none (or none that differs). */
function translationOf(block: Block, out: Out): string | null {
	if (!TRANSLATABLE.has(block.kind) || !hasUnits(block)) return null;
	const tr = buildBlock(block, out);
	return tr === null || tr === block.original ? null : tr;
}

function quote(md: string): string {
	return md
		.split("\n")
		.map((line) => (line.trim() === "" ? ">" : `> ${line}`))
		.join("\n");
}

const BLOCK_START = /^\s*(?:[-*+>#|]|\d{1,9}[.)])/m;
const BREAKS_EMPHASIS = /[_*`~\\<[\]|]/;
const ITEM = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)(.*)$/;

/** An italic paragraph (or italic list items), or a blockquote when emphasis could not survive. */
function subtle(translation: string, kind: string): string {
	const text = kind === "heading" ? translation.replace(/^\s*#{1,6}\s*/, "") : translation;
	const body = text.trim();
	const lines = body.split("\n").map((l) => ITEM.exec(l));
	if (body !== "" && lines.every((m) => m?.[2] && !BREAKS_EMPHASIS.test(m[2]))) {
		// a plain list after a list would merge with it, so it goes in a quote
		return quote(lines.map((m) => `${m?.[1]}_${m?.[2]?.trim()}_`).join("\n"));
	}
	if (body === "" || BREAKS_EMPHASIS.test(body) || BLOCK_START.test(body)) {
		return quote(text.trimEnd());
	}
	return `_${body}_`;
}

/** The translation with code blocks folded to one line, for the `below` view. */
function foldedTranslation(plan: Plan, out: Out): string {
	return plan.blocks
		.map((block) => {
			if (block.kind === "code") return `\`⋯ code (${block.original.split("\n").length})\``;
			return block.parts
				.map((p) => (typeof p === "string" ? p : (out[p.unit] ?? unmaskAt(plan, p.unit))))
				.join("");
		})
		.join("\n");
}

function documentOf(plan: Plan, out: Out): string {
	return plan.blocks
		.map((b) =>
			b.parts
				.map((p) => (typeof p === "string" ? p : (out[p.unit] ?? unmaskAt(plan, p.unit))))
				.join(""),
		)
		.join("\n");
}

/** The markdown of a reply block in `view` (never `side` or `auto`; those return it unchanged). */
export function renderMarkdown(view: View, md: string, out: Out, note: Note): string {
	if (view === "original" || view === "auto" || view === "side") return md;
	const plan = planMarkdown(md);
	let body: string;
	if (view === "translated") {
		body = documentOf(plan, out);
	} else if (view === "below") {
		body = `${md}\n\n${quote(foldedTranslation(plan, out))}`;
	} else {
		body = plan.blocks
			.filter((b) => b.kind !== "blank")
			.map((block) => {
				const tr = translationOf(block, out);
				if (tr === null) return block.original;
				if (view === "stacked") return `${block.original}\n\n${subtle(tr, block.kind)}`;
				if (block.kind === "heading") {
					const head = block.original.replace(/\s+$/, "");
					return `${head} · ${tr.replace(/^\s*#{1,6}\s*/, "").trim()}`;
				}
				return `${block.original}\n\n${quote(tr)}`;
			})
			.join("\n\n");
	}
	if (note === "pending") return `${body}\n\n_… translating_`;
	if (note === "failed") return `${body}\n\n_translation unavailable_`;
	return body;
}

// ---------------------------------------------------------------------------
// side by side

/** Wraps one source line to `width` cells, breaking words that are longer than a row. */
function wrapLine(line: string, width: number): string[] {
	if (line === "") return [""];
	const rows: string[] = [];
	for (const row of wrapTextWithAnsi(line, width)) {
		if (visibleWidth(row) <= width) {
			rows.push(row);
			continue;
		}
		let cur = "";
		for (const ch of row) {
			if (cur !== "" && visibleWidth(cur + ch) > width) {
				rows.push(cur);
				cur = "";
			}
			cur += ch;
		}
		rows.push(cur);
	}
	return rows;
}

export function wrapText(text: string, width: number): string[] {
	const w = Math.max(1, width);
	return text.split("\n").flatMap((line) => wrapLine(line, w));
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
export const SIDE_SEPARATOR = " │ ";

/**
 * Rows for the side view: per block, the original on the left and its
 * translation on the right (`…` while missing); blocks with nothing to
 * translate span the full width.
 */
export function sideRows(md: string, out: Out, width: number): string[] {
	const plan = planMarkdown(md);
	const half = Math.max(1, Math.floor((width - SIDE_SEPARATOR.length) / 2));
	const rows: string[] = [];
	for (const block of plan.blocks) {
		if (block.kind === "blank") continue;
		if (rows.length > 0) rows.push("");
		if (!TRANSLATABLE.has(block.kind) || !hasUnits(block)) {
			rows.push(...wrapText(block.original, width));
			continue;
		}
		const left = wrapText(block.original, half);
		const tr = buildBlock(block, out);
		const right = tr === null ? ["…"] : wrapText(tr, half);
		for (let i = 0; i < Math.max(left.length, right.length); i++) {
			const r = right[i];
			const l = left[i] ?? "";
			rows.push(pad(l, half) + SIDE_SEPARATOR + (r ?? ""));
		}
	}
	return rows;
}
