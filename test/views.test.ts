import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { effectiveView, renderMarkdown, sideRows, wrapText } from "../src/views.ts";

const DOC = "# Moon facts\n\nThe Moon orbits Earth.\n\n- Tides\n- Phases\n\n```js\na();\nb();\n```";
const OUT = ["달 정보", "달은 지구를 돈다.", "조수", "위상"];

describe("effectiveView", () => {
	it("auto is side from 140 columns, else stacked", () => {
		expect(effectiveView("auto", 140)).toBe("side");
		expect(effectiveView("auto", 139)).toBe("stacked");
	});

	it("an explicit side degrades to stacked below 100 columns", () => {
		expect(effectiveView("side", 100)).toBe("side");
		expect(effectiveView("side", 99)).toBe("stacked");
	});

	it("leaves the other views alone", () => {
		for (const v of ["stacked", "interleave", "below", "translated", "original"] as const) {
			expect(effectiveView(v, 50)).toBe(v);
		}
	});
});

describe("renderMarkdown", () => {
	it("stacked: italic paragraph, quoted italic list, code once", () => {
		expect(renderMarkdown("stacked", DOC, OUT, undefined)).toBe(
			[
				"# Moon facts",
				"",
				"_달 정보_",
				"",
				"The Moon orbits Earth.",
				"",
				"_달은 지구를 돈다._",
				"",
				"- Tides",
				"- Phases",
				"",
				"> - _조수_",
				"> - _위상_",
				"",
				"```js",
				"a();",
				"b();",
				"```",
			].join("\n"),
		);
	});

	it("stacked: falls back to a blockquote when emphasis would break", () => {
		const out = renderMarkdown(
			"stacked",
			"Rename the flag.",
			["`my_flag` 이름을 바꿔라"],
			undefined,
		);
		expect(out).toBe("Rename the flag.\n\n> `my_flag` 이름을 바꿔라");
	});

	it("interleave: quote after each block, heading joined with a dot", () => {
		expect(renderMarkdown("interleave", DOC, OUT, undefined)).toBe(
			[
				"# Moon facts · 달 정보",
				"",
				"The Moon orbits Earth.",
				"",
				"> 달은 지구를 돈다.",
				"",
				"- Tides",
				"- Phases",
				"",
				"> - 조수",
				"> - 위상",
				"",
				"```js",
				"a();",
				"b();",
				"```",
			].join("\n"),
		);
	});

	it("below: the original, then the translated document quoted with code folded", () => {
		expect(renderMarkdown("below", DOC, OUT, undefined)).toBe(
			[
				DOC,
				"",
				"> # 달 정보",
				">",
				"> 달은 지구를 돈다.",
				">",
				"> - 조수",
				"> - 위상",
				">",
				"> `⋯ code (4)`",
			].join("\n"),
		);
	});

	it("translated: only the translation, code verbatim", () => {
		expect(renderMarkdown("translated", DOC, OUT, undefined)).toBe(
			[
				"# 달 정보",
				"",
				"달은 지구를 돈다.",
				"",
				"- 조수",
				"- 위상",
				"",
				"```js",
				"a();",
				"b();",
				"```",
			].join("\n"),
		);
	});

	it("original (and side, which draws elsewhere): unchanged", () => {
		expect(renderMarkdown("original", DOC, OUT, undefined)).toBe(DOC);
		expect(renderMarkdown("side", DOC, OUT, undefined)).toBe(DOC);
	});

	it("shows an untranslated unit as the original only", () => {
		const out = [null, "달은 지구를 돈다.", null, null];
		expect(renderMarkdown("interleave", DOC, out, undefined)).toContain(
			"# Moon facts\n\nThe Moon orbits Earth.\n\n> 달은 지구를 돈다.\n\n- Tides",
		);
		expect(renderMarkdown("translated", DOC, out, undefined).split("\n")[0]).toBe("# Moon facts");
	});

	it("appends the pending and failed notes as the last line", () => {
		const pending = renderMarkdown("stacked", "Hello there.", [null], "pending");
		expect(pending).toBe("Hello there.\n\n_… translating_");
		const failed = renderMarkdown("interleave", "Hello there.", [null], "failed");
		expect(failed).toBe("Hello there.\n\n_translation unavailable_");
		expect(renderMarkdown("translated", "Hello there.", ["안녕."], "pending")).toBe(
			"안녕.\n\n_… translating_",
		);
	});
});

describe("sideRows", () => {
	const left = (row: string) => row.split(" │ ")[0]?.trimEnd();
	const right = (row: string) => row.split(" │ ")[1];

	it("puts original left and translation right, code across the full width", () => {
		const rows = sideRows(DOC, OUT, 60);
		expect(rows).toEqual([
			"# Moon facts                 │ # 달 정보",
			"",
			"The Moon orbits Earth.       │ 달은 지구를 돈다.",
			"",
			"- Tides                      │ - 조수",
			"- Phases                     │ - 위상",
			"",
			"```js",
			"a();",
			"b();",
			"```",
		]);
	});

	it("shows … for a missing translation", () => {
		const rows = sideRows("Hello there.", [null], 60);
		expect(rows).toEqual([`${"Hello there.".padEnd(28)} │ …`]);
	});

	for (const width of [160, 90]) {
		it(`wraps long Korean text with double-width cells at ${width} columns`, () => {
			const ko = "달은 지구의 유일한 자연 위성이며 밤하늘에서 가장 밝은 천체입니다. "
				.repeat(4)
				.trim();
			const en =
				"The Moon is Earth's only natural satellite and the brightest object in the night sky. "
					.repeat(3)
					.trim();
			const rows = sideRows(en, [ko], width);
			const half = Math.floor((width - 3) / 2);
			expect(rows.length).toBeGreaterThan(2);
			for (const row of rows) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				expect(row).not.toContain("\n");
				expect(visibleWidth(left(row) ?? "")).toBeLessThanOrEqual(half);
				expect(visibleWidth(right(row) ?? "")).toBeLessThanOrEqual(half);
			}
			// every separator sits in the same column
			const cols = new Set(rows.map((r) => visibleWidth(r.slice(0, r.indexOf(" │ ")))));
			expect(cols).toEqual(new Set([half]));
			expect(rows.map(right).join("").replaceAll(" ", "")).toBe(ko.replaceAll(" ", ""));
		});
	}

	it("hard-wraps a long Korean string without spaces", () => {
		const ko = "가".repeat(100);
		const rows = sideRows("Short english.", [ko], 90);
		const half = Math.floor((90 - 3) / 2);
		expect(rows.length).toBeGreaterThan(2);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(90);
		expect(rows.map(right).join("")).toBe(ko);
		expect(visibleWidth(right(rows[0] ?? "") ?? "")).toBeLessThanOrEqual(half);
	});
});

describe("wrapText", () => {
	it("keeps blank lines and never exceeds the width", () => {
		expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
		for (const row of wrapText("한글".repeat(30), 11))
			expect(visibleWidth(row)).toBeLessThanOrEqual(11);
	});
});
