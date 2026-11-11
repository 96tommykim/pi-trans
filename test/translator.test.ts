import { describe, expect, it, vi } from "vitest";
import type { Complete } from "../src/engine.ts";
import { cacheKey, createTranslator, MAX_IN_FLIGHT, replyPlan } from "../src/translator.ts";

const echo: Complete = async (_s, prompt) =>
	JSON.stringify((JSON.parse(prompt) as string[]).map((t) => `T:${t}`));

describe("cacheKey", () => {
	it("is from>to|unit", () => {
		expect(cacheKey("en", "ko", "Hello")).toBe("en>ko|Hello");
	});
});

describe("replyPlan", () => {
	it("is null for code only, Korean text, and English users", () => {
		expect(replyPlan("```\ncode\n```", "ko")).toBeNull();
		expect(replyPlan("달은 지구를 돕니다", "ko")).toBeNull();
		expect(replyPlan("The moon.", "en")).toBeNull();
		expect(replyPlan("The moon.", "ko")?.units).toHaveLength(1);
	});
});

describe("reply queue", () => {
	it("translates, caches by unit text and reports fresh pairs", async () => {
		const t = createTranslator(echo);
		const done = vi.fn();
		t.enqueueReply("Hello world.\n\nSecond one.", "ko", done);
		expect(t.status.get("Hello world.\n\nSecond one.")).toBe("pending");
		await vi.waitFor(() => expect(done).toHaveBeenCalled());
		expect(t.status.get("Hello world.\n\nSecond one.")).toBe("done");
		expect(t.cache.get("en>ko|Hello world.")).toBe("T:Hello world.");
		expect(done.mock.calls[0]?.[0]).toEqual([
			["Hello world.", "T:Hello world."],
			["Second one.", "T:Second one."],
		]);
		const { out } = t.lookup("Hello world.\n\nSecond one.", "en", "ko");
		expect(out).toEqual(["T:Hello world.", "T:Second one."]);
	});

	it("does not queue a block twice, and skips one that is fully cached", async () => {
		const complete = vi.fn(echo);
		const t = createTranslator(complete);
		t.load("en", "ko", [["Known line.", "알려진 줄."]]);
		t.enqueueReply("Known line.", "ko", () => {});
		expect(t.status.get("Known line.")).toBe("done");
		t.enqueueReply("New line.", "ko", () => {});
		t.enqueueReply("New line.", "ko", () => {});
		await vi.waitFor(() => expect(t.status.get("New line.")).toBe("done"));
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("marks a block failed when its units come back null", async () => {
		const t = createTranslator(async () => "nope");
		const done = vi.fn();
		t.enqueueReply("Broken line.", "ko", done);
		await vi.waitFor(() => expect(done).toHaveBeenCalled());
		expect(t.status.get("Broken line.")).toBe("failed");
		expect(done).toHaveBeenCalledWith([]);
	});

	it("runs at most three jobs at once", async () => {
		let running = 0;
		let peak = 0;
		const gates: (() => void)[] = [];
		const complete: Complete = async (_s, prompt) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise<void>((resolve) => gates.push(resolve));
			running--;
			return echo(_s, prompt, new AbortController().signal);
		};
		const t = createTranslator(complete);
		for (let i = 0; i < 7; i++) t.enqueueReply(`Block number ${i}.`, "ko", () => {});
		await vi.waitFor(() => expect(gates).toHaveLength(MAX_IN_FLIGHT));
		expect(t.inFlight()).toBe(3);
		expect(t.busy()).toBe(7);
		while (t.busy() > 0) {
			for (const g of gates.splice(0)) g();
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(peak).toBe(3);
		for (let i = 0; i < 7; i++) expect(t.status.get(`Block number ${i}.`)).toBe("done");
	});
});

describe("translatePrompt", () => {
	it("translates and restores code spans", async () => {
		const complete: Complete = async () => JSON.stringify(["Fix ⟦0⟧ please"]);
		const t = createTranslator(complete);
		await expect(t.translatePrompt("`foo()` 고쳐줘", "ko")).resolves.toBe("Fix `foo()` please");
	});

	it("caches the result and shares an in-flight call", async () => {
		const complete = vi.fn(echo);
		const t = createTranslator(complete);
		const [a, b] = await Promise.all([
			t.translatePrompt("안녕하세요", "ko"),
			t.translatePrompt("안녕하세요", "ko"),
		]);
		expect(a).toBe("T:안녕하세요");
		expect(b).toBe(a);
		await t.translatePrompt("안녕하세요", "ko");
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("retries only the units that failed", async () => {
		const seen: string[][] = [];
		let n = 0;
		const complete: Complete = async (_s, prompt) => {
			const texts = JSON.parse(prompt) as string[];
			seen.push(texts);
			if (++n === 1) return JSON.stringify(["one", "not valid ⟦9⟧"]);
			return JSON.stringify(texts.map(() => "two"));
		};
		const t = createTranslator(complete);
		await expect(t.translatePrompt("하나\n\n둘", "ko")).resolves.toBe("one\n\ntwo");
		expect(seen).toEqual([["하나", "둘"], ["둘"]]);
	});

	it("rejects when a unit stays untranslated, and does not cache the failure", async () => {
		const complete = vi.fn(async () => "bad");
		const t = createTranslator(complete);
		await expect(t.translatePrompt("안녕", "ko")).rejects.toThrow();
		await expect(t.translatePrompt("안녕", "ko")).rejects.toThrow();
		expect(complete.mock.calls.length).toBeGreaterThanOrEqual(4);
	});

	it("rejects after the timeout", async () => {
		const t = createTranslator(() => new Promise(() => {}), 30);
		await expect(t.translatePrompt("안녕", "ko")).rejects.toThrow(/timeout/);
	});

	it("rejects text with nothing to translate", async () => {
		const t = createTranslator(echo);
		await expect(t.translatePrompt("`only code`", "ko")).rejects.toThrow();
	});
});
