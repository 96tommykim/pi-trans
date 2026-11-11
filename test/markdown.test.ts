import { describe, expect, it } from "vitest";
import {
	blockUnits,
	buildBlock,
	buildDocument,
	maskText,
	planMarkdown,
	restoreUnit,
	unmask,
} from "../src/markdown.ts";

// one sample per INLINE_PATTERNS category: [text, the span that must be protected]
const CATEGORIES: [string, string][] = [
	["Keep ⟦literal⟧ as is today", "⟦literal⟧"],
	["See the logo ![alt text](img/logo.png) here", "![alt text](img/logo.png)"],
	["Read [the docs](https://example.com/docs) first", "](https://example.com/docs)"],
	["Read [the docs][ref] first", "][ref]"],
	["Visit <https://example.com/a> now", "<https://example.com/a>"],
	["Visit https://example.com/a/b?q=1 now", "https://example.com/a/b?q=1"],
	["Use the <br/> tag here", "<br/>"],
	["Mail me at dev@example.com please", "dev@example.com"],
	["Open /usr/local/bin now please", "/usr/local/bin"],
	["Open ~/projects/app now please", "~/projects/app"],
	["Open ./scripts/build now please", "./scripts/build"],
	["Open src/lib/util now please", "src/lib/util"],
	["Edit src/index.ts:12 now please", "src/index.ts:12"],
	["Edit package.json now please", "package.json"],
	["Run it with --max-old-space-size=4096 now", "--max-old-space-size=4096"],
	[`Set $HOME and \${PATH} first`, `\${PATH}`],
	[`Set $HOME and \${PATH} first`, "$HOME"],
	["Call fetchAll() and obj.method(arg) now", "fetchAll()"],
	["Use Promise.allSettled for that", "Promise.allSettled"],
	["Rename MAX_RETRY_COUNT today", "MAX_RETRY_COUNT"],
	["Rename retry_count today", "retry_count"],
	["Rename retryCount today", "retryCount"],
	["Rename RetryCount today", "RetryCount"],
	["Run `npm install` first", "`npm install`"],
];

describe("maskText", () => {
	for (const [text, span] of CATEGORIES) {
		it(`protects ${JSON.stringify(span)}`, () => {
			const unit = maskText(text);
			expect(unit).not.toBeNull();
			expect(unit?.spans).toContain(span);
			expect(unit?.text).not.toContain(span);
			expect(unit && unmask(unit)).toBe(text);
			expect(unit && restoreUnit(unit, unit.text)).toBe(text);
		});
	}

	it("returns null when only placeholders and symbols are left", () => {
		expect(maskText("`code`")).toBeNull();
		expect(maskText("src/index.ts")).toBeNull();
		expect(maskText("123 - 456")).toBeNull();
	});
});

describe("restoreUnit", () => {
	const unit = maskText("Run `a` then `b` now") as NonNullable<ReturnType<typeof maskText>>;

	it("puts spans back wherever the translation moved them, tolerating inner spaces", () => {
		expect(restoreUnit(unit, "지금 ⟦ 1 ⟧ 다음 ⟦0⟧ 실행")).toBe("지금 `b` 다음 `a` 실행");
	});

	it("requires every index to appear exactly once", () => {
		expect(restoreUnit(unit, "⟦0⟧ only")).toBeNull();
		expect(restoreUnit(unit, "⟦0⟧ ⟦0⟧ ⟦1⟧")).toBeNull();
		expect(restoreUnit(unit, "⟦0⟧ ⟦1⟧ ⟦2⟧")).toBeNull();
		expect(restoreUnit(unit, "no tokens")).toBeNull();
	});
});

describe("planMarkdown", () => {
	const doc = [
		"# Title here",
		"",
		"First paragraph with `code`.",
		"",
		"- item one",
		"- item two",
		"",
		"```ts",
		"const x = 'not prose';",
		"",
		"```",
		"",
		"| Name | Value |",
		"| ---- | ----- |",
		"| foo  | bar baz |",
		"",
		"> quoted words",
		"",
		"---",
	].join("\n");
	const plan = planMarkdown(doc);

	it("round-trips to the original text", () => {
		expect(buildDocument(plan, [])).toBe(doc);
		expect(plan.blocks.map((b) => b.original).join("\n")).toBe(doc);
	});

	it("classifies blocks", () => {
		const kinds = plan.blocks.map((b) => b.kind).filter((k) => k !== "blank");
		expect(kinds).toEqual(["heading", "prose", "list", "code", "table", "quote", "rule"]);
	});

	it("never makes a unit out of fenced code", () => {
		const code = plan.blocks.find((b) => b.kind === "code");
		expect(code && blockUnits(code)).toEqual([]);
		expect(code?.original).toContain("const x");
		expect(code?.original.split("\n")).toHaveLength(4);
	});

	it("recognises a code fence in CRLF text", () => {
		const crlf = planMarkdown("Explain this\r\n\r\n```js\r\nconst x = 1;\r\n```\r\n");
		expect(crlf.units.map((u) => u.text.trim())).toEqual(["Explain this"]);
	});

	it("makes one unit per heading, prose line, list item, table cell and quote", () => {
		expect(plan.units.map((u) => u.text)).toEqual([
			"Title here",
			"First paragraph with ⟦0⟧.",
			"item one",
			"item two",
			"Name",
			"Value",
			"foo",
			"bar baz",
			"quoted words",
		]);
	});

	it("keeps markers outside the units and rebuilds a block from translations", () => {
		const list = plan.blocks.find((b) => b.kind === "list");
		const out = plan.units.map((u) => `T(${u.text})`);
		expect(list && buildBlock(list, out)).toBe("- T(item one)\n- T(item two)");
		const heading = plan.blocks[0];
		expect(heading && buildBlock(heading, out)).toBe("# T(Title here)");
		expect(heading && buildBlock(heading, [])).toBeNull();
	});

	it("keeps an unfenced indented block as code", () => {
		const p = planMarkdown("Intro text\n\n    indented code\n    more code");
		expect(p.blocks.map((b) => b.kind)).toEqual(["prose", "blank", "code"]);
	});
});
