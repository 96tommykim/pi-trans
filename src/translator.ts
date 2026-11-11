// Translation cache, reply queue and prompt pipeline on top of the engine.
// Ported from cc-trans (MIT, github.com/midagedev/cc-trans).

import { replyNeedsTranslation } from "./detect.ts";
import { type Complete, TIMEOUT_MS, translateUnits } from "./engine.ts";
import { buildDocument, type Plan, planMarkdown, type Unit, unmask } from "./markdown.ts";

export const MAX_IN_FLIGHT = 3;

export type ReplyStatus = "pending" | "done" | "failed";
export type Pair = [unit: string, translation: string];

export const cacheKey = (from: string, to: string, unit: string) => `${from}>${to}|${unit}`;

/** The plan of a reply block, or null when there is nothing to translate in it. */
export function replyPlan(text: string, lang: string): Plan | null {
	if (!replyNeedsTranslation(text, lang)) return null;
	const plan = planMarkdown(text);
	return plan.units.length > 0 ? plan : null;
}

export function createTranslator(complete: Complete, timeoutMs = TIMEOUT_MS) {
	/** `${from}>${to}|${unit text}` -> translation. */
	const cache = new Map<string, string>();
	/** Reply status by block text. */
	const status = new Map<string, ReplyStatus>();
	const prompts = new Map<string, Promise<string>>();
	const queue: (() => Promise<void>)[] = [];
	let inflight = 0;

	/** Cached translations of a plan's units, null where missing. */
	function lookupUnits(units: Unit[], from: string, to: string): (string | null)[] {
		return units.map((u) => cache.get(cacheKey(from, to, unmask(u))) ?? null);
	}

	async function translatePlanUnits(units: Unit[], from: string, to: string) {
		const out = lookupUnits(units, from, to);
		const missing = out.flatMap((o, i) => (o === null ? [i] : []));
		const fresh: Pair[] = [];
		let error: string | undefined;
		if (missing.length > 0) {
			const r = await translateUnits(
				complete,
				missing.map((i) => units[i] as Unit),
				from,
				to,
				timeoutMs,
			);
			error = r.error;
			missing.forEach((ui, k) => {
				const tr = r.out[k] ?? null;
				const unit = units[ui] as Unit;
				out[ui] = tr;
				if (tr === null) return;
				cache.set(cacheKey(from, to, unmask(unit)), tr);
				fresh.push([unmask(unit), tr]);
			});
		}
		return { out, error, fresh };
	}

	function pump() {
		while (inflight < MAX_IN_FLIGHT && queue.length > 0) {
			const job = queue.shift();
			if (!job) break;
			inflight++;
			job()
				.catch(() => {})
				.finally(() => {
					inflight--;
					pump();
				});
		}
	}

	return {
		cache,
		status,
		/** Jobs queued or running. */
		busy: () => queue.length + inflight,
		inFlight: () => inflight,

		/** The cached translation of each unit of `text`, null where there is none. */
		lookup(text: string, from: string, to: string): { plan: Plan; out: (string | null)[] } {
			const plan = planMarkdown(text);
			return { plan, out: lookupUnits(plan.units, from, to) };
		},

		/** Adds persisted pairs to the cache. */
		load(from: string, to: string, pairs: readonly Pair[]) {
			for (const [unit, tr] of pairs) cache.set(cacheKey(from, to, unit), tr);
		},

		/**
		 * Queues a reply block (English to `to`) unless it is known. `done` gets the
		 * pairs that were newly translated, once the block has settled.
		 */
		enqueueReply(text: string, to: string, done: (fresh: Pair[]) => void) {
			if (status.has(text)) return;
			const plan = replyPlan(text, to);
			if (!plan) return;
			if (!lookupUnits(plan.units, "en", to).includes(null)) {
				status.set(text, "done");
				return;
			}
			status.set(text, "pending");
			queue.push(async () => {
				let fresh: Pair[] = [];
				try {
					const r = await translatePlanUnits(plan.units, "en", to);
					fresh = r.fresh;
					status.set(text, r.out.includes(null) ? "failed" : "done");
				} catch {
					status.set(text, "failed");
				}
				done(fresh);
			});
			pump();
		},

		/**
		 * Translates a prompt to English. One retry of only the units that failed;
		 * rejects when any unit is still missing or after `timeoutMs`.
		 */
		translatePrompt(text: string, from: string): Promise<string> {
			const hit = prompts.get(text);
			if (hit) return hit;
			const run = async () => {
				const plan = planMarkdown(text);
				if (plan.units.length === 0) throw new Error("nothing to translate");
				let r = await translatePlanUnits(plan.units, from, "en");
				if (r.out.includes(null)) r = await translatePlanUnits(plan.units, from, "en");
				if (r.out.includes(null)) throw new Error(r.error ?? "no translation");
				return buildDocument(plan, r.out);
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			});
			const p = Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
			prompts.set(text, p);
			p.catch(() => prompts.delete(text));
			return p;
		},
	};
}

export type Translator = ReturnType<typeof createTranslator>;
