import { describe, expect, it } from "vitest";
import {
	hasLetters,
	needsTranslation,
	replyNeedsTranslation,
	scriptOf,
	scriptShare,
} from "../src/detect.ts";

describe("scriptShare", () => {
	it("measures the share of letters in a script", () => {
		expect(scriptShare("안녕하세요", "Hangul")).toBe(1);
		expect(scriptShare("hello", "Hangul")).toBe(0);
		expect(scriptShare("안녕 hello", "Hangul")).toBeCloseTo(2 / 7);
	});

	it("ignores code, URLs and paths", () => {
		expect(
			scriptShare("안녕 `const abcdefgh = 1` https://example.com/abc /usr/local/bin", "Hangul"),
		).toBe(1);
		expect(scriptShare("```ts\nconst x = 1;\n```\n안녕", "Hangul")).toBe(1);
		expect(hasLetters("`code` 123")).toBe(false);
	});

	it("counts Japanese by kana plus kanji", () => {
		expect(scriptShare("日本語です", "Japanese")).toBe(1);
		expect(scriptShare("漢字のみ", "Japanese")).toBe(1);
		expect(scriptShare("中文", "Japanese")).toBe(0);
	});
});

describe("needsTranslation (prompts, 20% rule)", () => {
	it("translates Korean prompts", () => {
		expect(needsTranslation("달에 대해 설명해줘", "ko")).toBe(true);
	});

	it("applies the 20% threshold on a Korean/English mix", () => {
		// 2 Hangul letters of 10 letters = 20%
		expect(needsTranslation("fix the bug 고쳐", "ko")).toBe(false);
		expect(needsTranslation("fix bug 고쳐줘", "ko")).toBe(true);
		expect(needsTranslation("explain this 설명해줘 부탁해요", "ko")).toBe(true);
		expect(needsTranslation("Please explain Promise.allSettled 설명해줘", "ko")).toBe(false);
	});

	it("skips English, short text, slash and bang commands", () => {
		expect(needsTranslation("please explain the moon", "ko")).toBe(false);
		expect(needsTranslation("가", "ko")).toBe(false);
		expect(needsTranslation(" ", "ko")).toBe(false);
		expect(needsTranslation("/model 설명해줘", "ko")).toBe(false);
		expect(needsTranslation("!ls 한글", "ko")).toBe(false);
	});

	it("never translates when the user's language is English", () => {
		expect(needsTranslation("안녕하세요", "en")).toBe(false);
		expect(needsTranslation("안녕하세요", "en-GB")).toBe(false);
	});

	it("translates every Latin-script prompt", () => {
		expect(scriptOf("fr")).toBe("Latin");
		expect(needsTranslation("explique la lune", "fr")).toBe(true);
		expect(needsTranslation("explain the moon", "fr")).toBe(true);
	});
});

describe("replyNeedsTranslation (30% rule)", () => {
	it("translates English replies", () => {
		expect(replyNeedsTranslation("The moon orbits Earth.", "ko")).toBe(true);
	});

	it("skips blocks already more than 30% in the user's script", () => {
		expect(replyNeedsTranslation("달은 지구를 돕니다 moon", "ko")).toBe(false);
		// 3 of 10 letters = exactly 30%: still translated
		expect(replyNeedsTranslation("abcdefg 가나다", "ko")).toBe(true);
		expect(replyNeedsTranslation("abcdef 가나다라", "ko")).toBe(false);
	});

	it("does nothing for English users, and always translates for Latin-script languages", () => {
		expect(replyNeedsTranslation("The moon.", "en")).toBe(false);
		expect(replyNeedsTranslation("The moon.", "fr")).toBe(true);
	});
});
