import { describe, expect, it } from "vitest";
import { pickLanguage, toLanguageCode } from "../src/language.ts";

describe("toLanguageCode", () => {
	it("understands codes, locales and names", () => {
		expect(toLanguageCode("ko")).toBe("ko");
		expect(toLanguageCode("pt-BR")).toBe("pt");
		expect(toLanguageCode("ko_KR.UTF-8")).toBe("ko");
		expect(toLanguageCode("Korean")).toBe("ko");
		expect(toLanguageCode("한국어")).toBe("ko");
		expect(toLanguageCode("日本語")).toBe("ja");
	});

	it("rejects C, POSIX, empty and nonsense", () => {
		expect(toLanguageCode("C")).toBeUndefined();
		expect(toLanguageCode("POSIX")).toBeUndefined();
		expect(toLanguageCode("")).toBeUndefined();
		expect(toLanguageCode("Klingon of the north")).toBeUndefined();
	});
});

describe("pickLanguage", () => {
	it("prefers the setting, then LC_ALL, LC_MESSAGES, LANG, then English", () => {
		expect(pickLanguage("ja", { LANG: "ko_KR.UTF-8" })).toEqual({ code: "ja", from: "setting" });
		expect(pickLanguage("", { LC_ALL: "fr_FR.UTF-8", LANG: "ko_KR.UTF-8" })).toEqual({
			code: "fr",
			from: "locale",
		});
		expect(pickLanguage("", { LC_MESSAGES: "de_DE", LANG: "ko_KR.UTF-8" }).code).toBe("de");
		expect(pickLanguage("", { LANG: "ko_KR.UTF-8" }).code).toBe("ko");
		expect(pickLanguage("", { LANG: "C" })).toEqual({ code: "en", from: "none" });
		expect(pickLanguage("", {})).toEqual({ code: "en", from: "none" });
		expect(pickLanguage("not a language", {}).code).toBe("en");
	});
});
