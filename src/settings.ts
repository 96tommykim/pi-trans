import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { VIEWS, type View } from "./views.ts";

export interface Settings {
	enabled: boolean;
	language: string;
	view: View;
	preview: boolean;
	model: string;
}

export const DEFAULT_SETTINGS: Settings = {
	enabled: true,
	language: "",
	view: "auto",
	preview: true,
	model: "gpt-6-luna",
};

/** `<agent dir>/pi-trans.json`; `PI_TRANS_SETTINGS` overrides the whole path. */
export function settingsPath(): string {
	return process.env.PI_TRANS_SETTINGS || join(getAgentDir(), "pi-trans.json");
}

/** Reads the settings file. A missing or malformed file, or a bad value, means the default. */
export function loadSettings(path: string): Settings {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_SETTINGS;
	const str = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);
	return {
		enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
		language: str(o.language, d.language),
		view: VIEWS.includes(o.view as View) ? (o.view as View) : d.view,
		preview: typeof o.preview === "boolean" ? o.preview : d.preview,
		model: str(o.model, d.model) || d.model,
	};
}

export function saveSettings(path: string, settings: Settings): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`);
}

type Registry<M> = { find(provider: string, id: string): M | undefined; getAvailable(): M[] };

/**
 * `provider/id` is looked up directly. A bare id picks, among available models
 * with that id, `openai-codex` first, then any. Nothing found: the current model.
 */
export function resolveModel<M extends { provider: string; id: string }>(
	setting: string,
	registry: Registry<M>,
	current: M | undefined,
): { model: M | undefined; fallback: boolean } {
	const slash = setting.indexOf("/");
	let found: M | undefined;
	if (slash > 0) {
		found = registry.find(setting.slice(0, slash), setting.slice(slash + 1));
	} else {
		const same = registry.getAvailable().filter((m) => m.id === setting);
		found = same.find((m) => m.provider === "openai-codex") ?? same[0];
	}
	return found ? { model: found, fallback: false } : { model: current, fallback: true };
}
