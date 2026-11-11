import { afterEach, describe, expect, it, vi } from "vitest";
import {
	batches,
	type Complete,
	MAX_CHARS,
	MAX_UNITS,
	parseArray,
	systemPrompt,
	translateUnits,
} from "../src/engine.ts";
import type { Unit } from "../src/markdown.ts";

const unit = (text: string, spans: string[] = []): Unit => ({ text, spans });
const units = (n: number) => Array.from({ length: n }, (_, i) => unit(`line ${i}`));
/** A translator that answers `T:<text>` for every input string. */
const echo: Complete = async (_s, prompt) =>
	JSON.stringify((JSON.parse(prompt) as string[]).map((t) => `T:${t}`));

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("systemPrompt", () => {
	it("names both languages and the placeholder rule", () => {
		const p = systemPrompt("en", "ko");
		expect(p).toContain("from English to Korean");
		expect(p).toContain("⟦0⟧");
	});
});

describe("parseArray", () => {
	it("reads a plain array, a fenced array and an array inside prose", () => {
		expect(parseArray('["a","b"]')).toEqual(["a", "b"]);
		expect(parseArray('```json\n["a"]\n```')).toEqual(["a"]);
		expect(parseArray('Here you go: ["a", "b"] done')).toEqual(["a", "b"]);
	});

	it("rejects everything else", () => {
		expect(parseArray("no array")).toBeNull();
		expect(parseArray("[1, 2]")).toBeNull();
		expect(parseArray("[oops")).toBeNull();
		expect(parseArray('{"a": 1}')).toBeNull();
	});
});

describe("batches", () => {
	it("caps a batch at 40 units", () => {
		const out = batches(units(MAX_UNITS + 1).map((u) => u.text));
		expect(out.map((b) => b.length)).toEqual([MAX_UNITS, 1]);
	});

	it("caps a batch at 6000 characters", () => {
		const big = "x".repeat(MAX_CHARS / 2 + 1);
		expect(batches([big, big, "y"])).toEqual([[0], [1, 2]]);
		expect(batches(["x".repeat(MAX_CHARS)])).toEqual([[0]]);
	});

	it("is empty for no input", () => {
		expect(batches([])).toEqual([]);
	});
});

describe("translateUnits", () => {
	it("translates in order and restores placeholders", async () => {
		const complete: Complete = async () => JSON.stringify(["실행 ⟦0⟧ 하세요", "둘"]);
		const r = await translateUnits(
			complete,
			[unit("Run ⟦0⟧ now", ["`x`"]), unit("two")],
			"en",
			"ko",
		);
		expect(r.out).toEqual(["실행 `x` 하세요", "둘"]);
		expect(r.error).toBeUndefined();
	});

	it("sends one call per batch", async () => {
		const complete = vi.fn(echo);
		const r = await translateUnits(complete, units(MAX_UNITS + 5), "en", "ko");
		expect(complete).toHaveBeenCalledTimes(2);
		expect(r.out.every((t) => t?.startsWith("T:"))).toBe(true);
		expect(r.out[MAX_UNITS]).toBe(`T:line ${MAX_UNITS}`);
	});

	it("retries a wrong-length reply once, as two halves", async () => {
		const calls: number[] = [];
		const complete: Complete = async (_s, prompt) => {
			const texts = JSON.parse(prompt) as string[];
			calls.push(texts.length);
			if (calls.length === 1) return JSON.stringify(texts.slice(1));
			return JSON.stringify(texts.map((t) => `T:${t}`));
		};
		const r = await translateUnits(complete, units(5), "en", "ko");
		expect(calls).toEqual([5, 3, 2]);
		expect(r.out).toEqual(units(5).map((u) => `T:${u.text}`));
	});

	it("treats a blank translation as a failed unit", async () => {
		const complete: Complete = async () => JSON.stringify(["", "   ", "T:ok"]);
		const r = await translateUnits(complete, units(3), "en", "ko");
		expect(r.out).toEqual([null, null, "T:ok"]);
		expect(r.error).toBeDefined();
	});

	it("gives up on a half that is still the wrong length", async () => {
		const calls: number[] = [];
		const complete: Complete = async (_s, prompt) => {
			const texts = JSON.parse(prompt) as string[];
			calls.push(texts.length);
			return JSON.stringify(["only one"]);
		};
		const r = await translateUnits(complete, units(4), "en", "ko");
		expect(calls).toEqual([4, 2, 2]);
		expect(r.out).toEqual([null, null, null, null]);
		expect(r.error).toBeDefined();
	});

	it("does not split a single unit", async () => {
		const complete = vi.fn(async () => "[]");
		const r = await translateUnits(complete, units(1), "en", "ko");
		expect(complete).toHaveBeenCalledTimes(1);
		expect(r.out).toEqual([null]);
	});

	it("costs only the unit whose placeholder went missing", async () => {
		const complete: Complete = async () => JSON.stringify(["lost it", "fine"]);
		const r = await translateUnits(complete, [unit("a ⟦0⟧", ["`x`"]), unit("b")], "en", "ko");
		expect(r.out).toEqual([null, "fine"]);
		expect(r.error).toMatch(/placeholders/);
	});

	it("fails open per batch when the model call throws", async () => {
		let n = 0;
		const complete: Complete = async (_s, prompt) => {
			if (++n === 1) throw new Error("boom");
			return echo(_s, prompt, new AbortController().signal);
		};
		const r = await translateUnits(complete, units(MAX_UNITS + 1), "en", "ko");
		expect(r.out.slice(0, MAX_UNITS).every((t) => t === null)).toBe(true);
		expect(r.out[MAX_UNITS]).toBe(`T:line ${MAX_UNITS}`);
		expect(r.error).toBe("boom");
	});

	it("rejects a reply that is not a JSON array", async () => {
		const r = await translateUnits(async () => "sorry, no", units(2), "en", "ko");
		expect(r.out).toEqual([null, null]);
		expect(r.error).toMatch(/JSON array/);
	});

	it("times out a call that never answers and aborts its signal", async () => {
		let signal: AbortSignal | undefined;
		const complete: Complete = (_s, _p, s) => {
			signal = s;
			return new Promise(() => {});
		};
		const r = await translateUnits(complete, units(2), "en", "ko", 20);
		expect(r.out).toEqual([null, null]);
		expect(r.error).toMatch(/timeout/);
		expect(signal?.aborted).toBe(true);
	});

	it("honours PI_TRANS_DEBUG_FAIL without calling the model", async () => {
		vi.stubEnv("PI_TRANS_DEBUG_FAIL", "1");
		const complete = vi.fn(echo);
		const r = await translateUnits(complete, units(2), "en", "ko");
		expect(complete).not.toHaveBeenCalled();
		expect(r.out).toEqual([null, null]);
	});
});
