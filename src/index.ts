import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { needsTranslation } from "./detect.ts";
import type { Complete } from "./engine.ts";
import { pickLanguage } from "./language.ts";
import {
	loadSettings,
	resolveModel,
	type Settings,
	saveSettings,
	settingsPath,
} from "./settings.ts";
import { createTranslator, type Pair, replyPlan } from "./translator.ts";
import { effectiveView, renderMarkdown, sideRows, VIEWS, type View, wrapText } from "./views.ts";

const PREVIEW_KEY = "pi-trans-preview";
const POLL_MS = 250;
const STABLE_MS = 700;
const REFRESH_MS = 50;
const USAGE =
	"Usage: /translate [on|off|status|view <auto|stacked|interleave|side|below|translated|original>|preview on|off|model <id>]";

type CacheData = { from: string; to: string; pairs: Pair[] };
type CustomEntryLike = { type: string; customType?: string; data?: unknown };

const textOf = (block: { type: string; text?: string }) =>
	block.type === "text" ? (block.text ?? "").trim() : "";

export default function piTrans(pi: ExtensionAPI) {
	const path = settingsPath();
	let settings: Settings = loadSettings(path);
	/** The newest context an event handed us; replaced on every event so it never goes stale. */
	let current: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let modelNoticeShown = false;
	/** Block texts that have a `pi-trans-side` entry. */
	let sideTexts = new Set<string>();
	/** english text -> the user's original, waiting for its user message. */
	const pendingNative = new Map<string, string>();
	/** Originals of submitted prompts whose entry is appended when the reply starts. */
	const queuedNative: string[] = [];

	const language = () => pickLanguage(settings.language, process.env);
	const active = () => settings.enabled && language().code !== "en";
	const interactive = () => current?.mode === "tui";

	// --- rendering ----------------------------------------------------------

	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** Re-runs the transformers and entry renderers of everything on screen. */
	function refresh() {
		if (refreshTimer || !tui) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			tui?.invalidate();
			tui?.requestRender();
		}, REFRESH_MS);
	}

	const complete: Complete = async (system, prompt, signal) => {
		const ctx = current;
		if (!ctx) throw new Error("no active session");
		const { model, fallback } = resolveModel(settings.model, ctx.modelRegistry, ctx.model);
		if (!model) throw new Error("no model available");
		if (fallback && !modelNoticeShown) {
			modelNoticeShown = true;
			ctx.ui.notify(
				`pi-trans: model "${settings.model}" not available, using ${model.provider}/${model.id}`,
				"warning",
			);
		}
		const levels = ["minimal", "low", "medium", "high"] as const;
		const reasoning = model.reasoning
			? levels.find((l) => model.thinkingLevelMap?.[l] !== null)
			: undefined;
		const message = await ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt: system,
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				{ signal, ...(reasoning ? { reasoning } : {}) },
			)
			.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? message.stopReason);
		}
		return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	};
	const translator = createTranslator(complete);

	// --- live preview -------------------------------------------------------

	class PreviewWidget implements Component {
		english = "";
		constructor(private theme: { fg(color: "dim", text: string): string }) {}
		invalidate() {}
		render(width: number): string[] {
			if (!this.english) return [];
			return wrapText(`EN ▸ ${this.english}`, width).map((l) => this.theme.fg("dim", l));
		}
	}
	let widget: PreviewWidget | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;
	let lastText = "";
	let changedAt = 0;
	let previewed = "";

	function setPreview(english: string) {
		if (!widget || widget.english === english) return;
		widget.english = english;
		tui?.requestRender();
	}

	function pollEditor() {
		const ctx = current;
		if (!ctx || !widget) return;
		if (!active() || !settings.preview) {
			generation++;
			setPreview("");
			return;
		}
		let text: string;
		try {
			text = ctx.ui.getEditorText();
		} catch {
			return;
		}
		const now = Date.now();
		if (text !== lastText) {
			lastText = text;
			changedAt = now;
			generation++;
			if (!needsTranslation(text, language().code)) {
				previewed = "";
				setPreview("");
			}
			return;
		}
		if (now - changedAt < STABLE_MS || text === previewed) return;
		if (!needsTranslation(text, language().code)) return;
		previewed = text;
		const mine = generation;
		translator
			.translatePrompt(text, language().code)
			.then((english) => {
				if (mine === generation) setPreview(english);
			})
			.catch(() => {
				if (mine === generation) setPreview("");
			});
	}

	/** The effective view depends on the width, so a resize re-runs everything on screen. */
	const onResize = () => refresh();

	function stopPreview() {
		if (timer) clearInterval(timer);
		timer = undefined;
		process.stdout.off("resize", onResize);
		generation++;
		widget = undefined;
		tui = undefined;
	}

	// --- session ------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		modelNoticeShown = false;
		pendingNative.clear();
		queuedNative.length = 0;
		sideTexts = new Set();
		for (const entry of ctx.sessionManager.getEntries() as CustomEntryLike[]) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "pi-trans-cache") {
				const d = entry.data as CacheData | undefined;
				if (d && Array.isArray(d.pairs)) translator.load(d.from, d.to, d.pairs);
			} else if (entry.customType === "pi-trans-side") {
				const d = entry.data as { text?: string } | undefined;
				if (d?.text) sideTexts.add(d.text);
			}
		}
		if (ctx.mode !== "tui") return;
		stopPreview();
		ctx.ui.setWidget(
			PREVIEW_KEY,
			(t, theme) => {
				tui = t;
				widget = new PreviewWidget(theme);
				return widget;
			},
			{ placement: "aboveEditor" },
		);
		lastText = "";
		previewed = "";
		timer = setInterval(pollEditor, POLL_MS);
		process.stdout.on("resize", onResize);
		refresh();
	});

	pi.on("session_shutdown", () => {
		stopPreview();
		current = undefined;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
	});

	// --- prompt -------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		current = ctx;
		const lang = language().code;
		if (!active() || !needsTranslation(event.text, lang)) return { action: "continue" };
		generation++;
		setPreview("");
		try {
			const english = await translator.translatePrompt(event.text, lang);
			if (interactive()) pendingNative.set(english, event.text);
			return { action: "transform", text: english, images: event.images };
		} catch {
			ctx.ui.notify("pi-trans: translation failed, prompt sent as typed", "warning");
			return { action: "continue" };
		}
	});

	// Pi drops an entry whose renderer answers undefined at creation and never asks again, so
	// these two always answer with a component and draw nothing while their view is off.
	pi.registerEntryRenderer<{ native: string }>("pi-trans-prompt", (entry, _options, theme) => {
		const native = entry.data?.native;
		if (!native) return undefined;
		return {
			invalidate() {},
			render: (width) => {
				if (!active() || settings.view === "original") return [];
				const label = `${language().code.toUpperCase()} ▸ `;
				return wrapText(`${label}${native}`, Math.max(1, width - 1)).map(
					(l) => ` ${theme.fg("dim", l)}`,
				);
			},
		};
	});

	// --- replies ------------------------------------------------------------

	// The user message is stored after its message_end handlers run, so the original is appended
	// once the reply starts: below the English message live, and after it when the session reloads.
	pi.on("message_start", (event, ctx) => {
		current = ctx;
		if (event.message.role !== "assistant" || ctx.mode !== "tui") return;
		for (const native of queuedNative.splice(0)) pi.appendEntry("pi-trans-prompt", { native });
	});

	pi.on("message_end", (event, ctx) => {
		current = ctx;
		if (ctx.mode !== "tui") return;
		const message = event.message;
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map(textOf).join("");
			const native = pendingNative.get(text.trim()) ?? pendingNative.get(text);
			if (native !== undefined) {
				pendingNative.delete(text.trim());
				pendingNative.delete(text);
				queuedNative.push(native);
			}
			return;
		}
		if (message.role !== "assistant" || !active()) return;
		const lang = language().code;
		for (const block of message.content) {
			const text = textOf(block);
			if (!text || !replyPlan(text, lang)) continue;
			// ponytail: translation starts at message_end, not on 800 ms-stable blocks mid-stream as cc-trans does. Add early queuing if long replies feel slow.
			translator.enqueueReply(text, lang, (fresh) => {
				if (fresh.length > 0 && current) {
					pi.appendEntry<CacheData>("pi-trans-cache", { from: "en", to: lang, pairs: fresh });
				}
				refresh();
			});
			pi.appendEntry("pi-trans-side", { text });
			sideTexts.add(text);
		}
		refresh();
	});

	pi.registerEntryRenderer<CacheData>("pi-trans-cache", () => undefined);

	pi.registerEntryRenderer<{ text: string }>("pi-trans-side", (entry) => {
		const text = entry.data?.text;
		if (!text) return undefined;
		// Rendered on every frame, so the rows are kept per width. refresh() invalidates the
		// screen, which calls this renderer again and so starts from an empty memo.
		let rows: string[] | undefined;
		let rowsWidth = -1;
		return {
			invalidate() {},
			render: (width) => {
				if (!active() || effectiveView(settings.view) !== "side") return [];
				if (!rows || rowsWidth !== width) {
					const { out } = translator.lookup(text, "en", language().code);
					rows = sideRows(text, out, width);
					rowsWidth = width;
				}
				return rows;
			},
		};
	});

	pi.registerMarkdownTransformer(
		(markdown, context) => {
			if (context.isStreaming || !active()) return markdown;
			const view = effectiveView(settings.view);
			const text = markdown.trim();
			if (view === "original" || !text) return markdown;
			if (view === "side") return sideTexts.has(text) ? "" : markdown;
			const lang = language().code;
			const { out } = translator.lookup(text, "en", lang);
			const state = translator.status.get(text);
			const note = state === "pending" || state === "failed" ? state : undefined;
			if (!note && !out.some((o) => o !== null)) return markdown;
			return renderMarkdown(view, text, out, note);
		},
		{ messageTypes: ["assistant"] },
	);

	// --- /translate ---------------------------------------------------------

	function update(ctx: ExtensionCommandContext, patch: Partial<Settings>, message: string) {
		settings = { ...settings, ...patch };
		try {
			saveSettings(path, settings);
		} catch (e) {
			ctx.ui.notify(`pi-trans: could not save settings: ${(e as Error).message}`, "error");
		}
		if (patch.model !== undefined) modelNoticeShown = false;
		ctx.ui.notify(message, "info");
		refresh();
	}

	pi.registerCommand("translate", {
		description: "Toggle or configure prompt/reply translation",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			const options =
				words.length < 2
					? ["on", "off", "status", "view", "preview", "model"]
					: words[0] === "view"
						? [...VIEWS]
						: words[0] === "preview"
							? ["on", "off"]
							: [];
			const last = words[words.length - 1] ?? "";
			const head = words.length > 1 ? `${words[0]} ` : "";
			const items = options
				.filter((o) => o.startsWith(last))
				.map((o) => ({ value: `${head}${o}`, label: o }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [word, arg] = args.trim().split(/\s+/);
			if (!word || word === "on" || word === "off") {
				const on = word ? word === "on" : !settings.enabled;
				if (!on) {
					generation++;
					setPreview("");
				}
				update(ctx, { enabled: on }, `Translation is ${on ? "on" : "off"}.`);
			} else if (word === "view") {
				if (!arg || !VIEWS.includes(arg as View)) ctx.ui.notify(USAGE, "info");
				else update(ctx, { view: arg as View }, `Replies are shown as: ${arg}`);
			} else if (word === "preview") {
				if (arg !== "on" && arg !== "off") ctx.ui.notify(USAGE, "info");
				else {
					if (arg === "off") setPreview("");
					update(ctx, { preview: arg === "on" }, `Live preview is ${arg}.`);
				}
			} else if (word === "model") {
				if (!arg) ctx.ui.notify(USAGE, "info");
				else update(ctx, { model: arg }, `Translator model: ${arg}`);
			} else if (word === "status") {
				const lang = language();
				const resolved = resolveModel(settings.model, ctx.modelRegistry, ctx.model);
				const used = resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : "none";
				const view = effectiveView(settings.view);
				ctx.ui.notify(
					[
						`Translation: ${settings.enabled ? "on" : "off"}`,
						`Language: ${lang.code} <-> en (${lang.from === "none" ? "nothing set: no translation" : `from ${lang.from}`})`,
						`View: ${view}${settings.view === "auto" ? " (auto)" : ""}`,
						`Model: ${settings.model}${resolved.fallback ? ` (not available, using ${used})` : ` (${used})`}`,
						`Live preview: ${settings.preview ? "on" : "off"}`,
					].join("\n"),
					"info",
				);
			} else {
				ctx.ui.notify(USAGE, "info");
			}
		},
	});
}
