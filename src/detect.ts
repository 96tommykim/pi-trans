// Which writing system a text is in, ignoring code, URLs and paths.

export type Script =
	| "Latin"
	| "Hangul"
	| "Japanese"
	| "Han"
	| "Cyrillic"
	| "Greek"
	| "Arabic"
	| "Hebrew"
	| "Thai"
	| "Devanagari";

const BY_LANGUAGE: Record<string, Script> = {
	ko: "Hangul",
	ja: "Japanese",
	zh: "Han",
	yue: "Han",
	ru: "Cyrillic",
	uk: "Cyrillic",
	be: "Cyrillic",
	bg: "Cyrillic",
	sr: "Cyrillic",
	mk: "Cyrillic",
	kk: "Cyrillic",
	mn: "Cyrillic",
	el: "Greek",
	ar: "Arabic",
	fa: "Arabic",
	ur: "Arabic",
	he: "Hebrew",
	yi: "Hebrew",
	th: "Thai",
	hi: "Devanagari",
	mr: "Devanagari",
	ne: "Devanagari",
};

/** The script a language is written in; Latin for anything not listed. */
export function scriptOf(lang: string): Script {
	const primary = lang.toLowerCase().split(/[-_]/)[0] ?? "";
	return BY_LANGUAGE[primary] ?? "Latin";
}

const SCRIPT_RE: Record<Exclude<Script, "Japanese">, RegExp> = {
	Latin: /\p{Script=Latin}/gu,
	Hangul: /\p{Script=Hangul}/gu,
	Han: /\p{Script=Han}/gu,
	Cyrillic: /\p{Script=Cyrillic}/gu,
	Greek: /\p{Script=Greek}/gu,
	Arabic: /\p{Script=Arabic}/gu,
	Hebrew: /\p{Script=Hebrew}/gu,
	Thai: /\p{Script=Thai}/gu,
	Devanagari: /\p{Script=Devanagari}/gu,
};

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;

function count(text: string, re: RegExp): number {
	re.lastIndex = 0;
	return (text.match(re) ?? []).length;
}

/** The text with fenced code, inline code, URLs and paths taken out. */
export function proseOnly(text: string): string {
	return text
		.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s*\1[^\n]*$|(?![\s\S]))/gm, " ")
		.replace(/(`+)[\s\S]*?\1/g, " ")
		.replace(/\b(?:https?|file|ftp):\/\/\S+/g, " ")
		.replace(/(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}/g, " ");
}

/** The share of letters, outside code, written in `script` (0 with no letters). */
export function scriptShare(text: string, script: Script): number {
	const prose = proseOnly(text);
	const letters = count(prose, /\p{L}/gu);
	if (letters === 0) return 0;
	if (script === "Japanese") {
		const kana = count(prose, KANA);
		if (kana === 0) return 0;
		return (kana + count(prose, SCRIPT_RE.Han)) / letters;
	}
	return count(prose, SCRIPT_RE[script]) / letters;
}

/** True when the text has any letter outside code. */
export function hasLetters(text: string): boolean {
	return /\p{L}/u.test(proseOnly(text));
}

/**
 * Whether a prompt typed in `lang` should be translated to English: not blank,
 * not a slash or bash command, and (for non-Latin scripts) at least 20% of its
 * prose letters in the user's script.
 */
export function needsTranslation(text: string, lang: string): boolean {
	if (lang.toLowerCase().startsWith("en")) return false;
	const trimmed = text.trim();
	if (trimmed.length < 2 || trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
	const script = scriptOf(lang);
	if (script !== "Latin") return scriptShare(trimmed, script) >= 0.2;
	// ponytail: no classify call for Latin-script languages; an English prompt costs one identity translation. Add a classifier if that cost matters.
	return true;
}

/**
 * Whether an English reply block should be translated to `lang`: not when more
 * than 30% of its letters are already in the user's script. Latin-script
 * languages share the script with English, so the rule cannot apply to them.
 */
export function replyNeedsTranslation(text: string, lang: string): boolean {
	if (lang.toLowerCase().startsWith("en")) return false;
	const script = scriptOf(lang);
	return script === "Latin" || scriptShare(text, script) <= 0.3;
}
