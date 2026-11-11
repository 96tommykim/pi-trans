import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	resolveModel,
	saveSettings,
	settingsPath,
} from "../src/settings.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-trans-"));

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("loadSettings", () => {
	it("returns the defaults for a missing file", () => {
		expect(loadSettings(join(dir, "missing.json"))).toEqual(DEFAULT_SETTINGS);
		expect(DEFAULT_SETTINGS).toEqual({
			enabled: true,
			language: "",
			view: "auto",
			preview: true,
			model: "gpt-6-luna",
		});
	});

	it("returns the defaults for malformed JSON and non-objects", () => {
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{not json");
		expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
		writeFileSync(bad, "[1,2]");
		expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
		writeFileSync(bad, "null");
		expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps valid keys and defaults the invalid ones", () => {
		const file = join(dir, "mixed.json");
		writeFileSync(
			file,
			JSON.stringify({ enabled: false, language: " ko ", view: "nope", preview: "yes", model: "" }),
		);
		expect(loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, enabled: false, language: "ko" });
	});

	it("round-trips through saveSettings, creating the directory", () => {
		const file = join(dir, "nested", "pi-trans.json");
		const settings = {
			enabled: false,
			language: "ja",
			view: "below" as const,
			preview: false,
			model: "a/b",
		};
		saveSettings(file, settings);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(settings);
		expect(loadSettings(file)).toEqual(settings);
	});
});

describe("settingsPath", () => {
	it("is <agent dir>/pi-trans.json, with PI_TRANS_SETTINGS overriding", () => {
		vi.stubEnv("PI_TRANS_SETTINGS", "");
		vi.stubEnv("PI_CODING_AGENT_DIR", "/x/agent");
		expect(settingsPath()).toBe("/x/agent/pi-trans.json");
		vi.stubEnv("PI_TRANS_SETTINGS", "/y/t.json");
		expect(settingsPath()).toBe("/y/t.json");
	});
});

describe("resolveModel", () => {
	type M = { provider: string; id: string };
	const models: M[] = [
		{ provider: "openai", id: "gpt-6-luna" },
		{ provider: "openai-codex", id: "gpt-6-luna" },
		{ provider: "vessl", id: "other" },
	];
	const registry = {
		find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		getAvailable: () => models,
	};
	const current: M = { provider: "vessl", id: "session-model" };

	it("looks provider/id up directly", () => {
		expect(resolveModel("openai/gpt-6-luna", registry, current)).toEqual({
			model: { provider: "openai", id: "gpt-6-luna" },
			fallback: false,
		});
	});

	it("prefers openai-codex for a bare id, then any provider", () => {
		expect(resolveModel("gpt-6-luna", registry, current).model?.provider).toBe("openai-codex");
		expect(resolveModel("other", registry, current).model?.provider).toBe("vessl");
		const only = { ...registry, getAvailable: () => [models[0] as M] };
		expect(resolveModel("gpt-6-luna", only, current).model?.provider).toBe("openai");
	});

	it("falls back to the session model when nothing resolves", () => {
		expect(resolveModel("nope/nope", registry, current)).toEqual({
			model: current,
			fallback: true,
		});
		expect(resolveModel("nope", registry, current)).toEqual({ model: current, fallback: true });
		expect(resolveModel("nope", registry, undefined)).toEqual({ model: undefined, fallback: true });
	});
});
