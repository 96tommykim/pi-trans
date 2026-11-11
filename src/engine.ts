// Translator protocol: masked unit texts go out as a JSON array, translations
// come back in the same order, and every placeholder is checked on the way in.
// Ported from cc-trans (MIT, github.com/midagedev/cc-trans).

import { appendFileSync } from "node:fs";
import { restoreUnit, type Unit } from "./markdown.ts";

/** One model call. Resolves to the reply text, throws on any failure. */
export type Complete = (system: string, prompt: string, signal: AbortSignal) => Promise<string>;

export type Translated = {
	/** Restored translations, null for a unit that failed. */
	out: (string | null)[];
	/** Why something failed, when anything did. */
	error?: string;
};

export const MAX_UNITS = 40;
export const MAX_CHARS = 6000;
export const TIMEOUT_MS = 30_000;

export function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

export function systemPrompt(from: string, to: string): string {
	const source = languageName(from);
	const target = languageName(to);
	return [
		"You are a translation engine for a software developer's conversation with a coding assistant.",
		`Translate each string of the JSON array from ${source} to ${target}.`,
		"Reply with ONLY a JSON array of strings: the same length and order as the input, one translation per input string. No prose, no code fence.",
		"Rules:",
		"- Tokens like ⟦0⟧, ⟦1⟧ stand for code, paths or links. Copy every token exactly once, unchanged, where it belongs in the translated sentence.",
		"- Keep Markdown markers (**, *, _, ~~, [ ]) around the words they wrap.",
		`- Keep technical terms, product names and identifiers that ${target}-speaking developers normally leave in English.`,
		"- Keep the tone: terse stays terse. Do not add, explain or omit anything.",
		`- A string already in ${target} is returned unchanged.`,
	].join("\n");
}

/** Reads a JSON array of strings out of a model's reply. */
export function parseArray(reply: string): string[] | null {
	let text = reply.trim();
	const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
	if (fence) text = fence[1] ?? text;
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) return null;
	try {
		const value: unknown = JSON.parse(text.slice(start, end + 1));
		if (!Array.isArray(value)) return null;
		if (!value.every((v) => typeof v === "string")) return null;
		return value as string[];
	} catch {
		return null;
	}
}

/** Splits units into batches by count and size. */
export function batches(texts: string[]): number[][] {
	const out: number[][] = [];
	let cur: number[] = [];
	let size = 0;
	texts.forEach((t, i) => {
		if (cur.length > 0 && (cur.length >= MAX_UNITS || size + t.length > MAX_CHARS)) {
			out.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(i);
		size += t.length;
	});
	if (cur.length > 0) out.push(cur);
	return out;
}

function debugLog(line: string) {
	const file = process.env.PI_TRANS_DEBUG;
	if (!file) return;
	try {
		appendFileSync(file, `${line}\n`);
	} catch {
		// debugging aid only
	}
}

type Raw = (texts: string[]) => Promise<string[]>;

function rawFor(complete: Complete, from: string, to: string, timeoutMs: number): Raw {
	const system = systemPrompt(from, to);
	return async (texts) => {
		debugLog(`call ${from}>${to} n=${texts.length} ${JSON.stringify(texts[0]?.slice(0, 40))}`);
		if (process.env.PI_TRANS_DEBUG_FAIL) throw new Error("forced failure (PI_TRANS_DEBUG_FAIL)");
		const ac = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				ac.abort();
				reject(new Error(`timeout after ${timeoutMs} ms`));
			}, timeoutMs);
		});
		try {
			const reply = await Promise.race([
				complete(system, JSON.stringify(texts), ac.signal),
				timeout,
			]);
			const arr = parseArray(reply);
			if (!arr) throw new Error("reply was not a JSON array");
			return arr;
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Runs a batch; a reply of the wrong length is retried once as two halves. */
async function runBatch(raw: Raw, texts: string[], depth = 0): Promise<(string | null)[]> {
	const arr = await raw(texts);
	if (arr.length === texts.length) return arr;
	if (depth > 0 || texts.length < 2) return texts.map(() => null);
	const mid = Math.ceil(texts.length / 2);
	const [a, b] = await Promise.all([
		runBatch(raw, texts.slice(0, mid), 1),
		runBatch(raw, texts.slice(mid), 1),
	]);
	return [...a, ...b];
}

/** Translates units from `from` to `to`. A failed batch only costs its own units. */
export async function translateUnits(
	complete: Complete,
	units: Unit[],
	from: string,
	to: string,
	timeoutMs = TIMEOUT_MS,
): Promise<Translated> {
	const out: (string | null)[] = units.map(() => null);
	const texts = units.map((u) => u.text);
	const raw = rawFor(complete, from, to, timeoutMs);
	let error: string | undefined;

	for (const batch of batches(texts)) {
		const slice = batch.map((i) => texts[i] ?? "");
		let got: (string | null)[];
		try {
			got = await runBatch(raw, slice);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			continue;
		}
		batch.forEach((unitIndex, k) => {
			const t = got[k];
			const unit = units[unitIndex];
			// A blank answer is a failure: accepting it would replace the line with nothing.
			out[unitIndex] = t == null || !unit || t.trim() === "" ? null : restoreUnit(unit, t);
		});
	}
	if (!error && out.some((t) => t === null)) {
		error = "some lines came back blank or without their code placeholders";
	}
	return { out, error };
}
