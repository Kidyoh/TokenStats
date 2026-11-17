// Cost estimates from models.dev list prices. A copy is bundled at build time (scripts/update-pricing.mjs);
// on load the page fetches the current list from models.dev and uses that instead, falling back to the copy.
// Estimates: subscriptions, free tiers, batch/priority discounts and long-context surcharges aren't known here.
import data from './pricing.json';
import { prefs } from './prefs.svelte';
import type { Session, Tokens, Tool } from './types';

/** What a model is, from models.dev: name, input and output modalities, context window, whether it reasons. */
export interface ModelInfo {
	n?: string;
	i?: string[];
	o?: string[];
	c?: number;
	r?: boolean;
}
// USD per 1M tokens: [input, output, cache read, cache write, reasoning, info]. Keep in sync with scripts/update-pricing.mjs.
type Row = [number, number, number | null, number | null, number | null, ModelInfo?];
type Providers = Record<string, Record<string, Row>>;
let PROVIDERS = data.providers as unknown as Providers;
let ALL = Object.keys(PROVIDERS);

export const pricingSource = 'models.dev';
const API = 'https://models.dev/api.json';
const LIVE_KEY = 'sb-models-dev-2'; // -2: rows carry model info
const MAX_AGE = 6 * 3600e3;
// First-party providers only: resellers list the same models at marked-up prices. Keep in sync with the build script.
const KEEP = ['anthropic', 'openai', 'xai', 'google', 'deepseek', 'opencode', 'mistral', 'moonshotai', 'zai', 'alibaba', 'minimax', 'cohere', 'groq', 'cerebras'];

/** Where the prices on screen came from. Reading it makes cost displays update when live prices arrive. */
export const pricing = $state<{ updated: string | null; live: boolean; version: number }>({ updated: data.updated, live: false, version: 0 });

type ApiModel = {
	name?: string;
	reasoning?: boolean;
	cost?: Record<string, number | undefined>;
	modalities?: { input?: string[]; output?: string[] };
	limit?: { context?: number };
};
const info = (m: ApiModel): ModelInfo => ({
	n: m.name || undefined,
	i: m.modalities?.input?.length ? m.modalities.input : undefined,
	o: m.modalities?.output?.length ? m.modalities.output : undefined,
	c: m.limit?.context || undefined,
	r: m.reasoning || undefined
});

function fromApi(api: Record<string, { models?: Record<string, ApiModel> }>): Providers {
	const out: Providers = {};
	for (const pid of KEEP) {
		const models = api[pid]?.models;
		if (!models) continue;
		const rows: Record<string, Row> = {};
		for (const [id, m] of Object.entries(models)) {
			const c = m.cost;
			if (!c || (c.input == null && c.output == null)) continue;
			rows[id] = [c.input ?? 0, c.output ?? 0, c.cache_read ?? null, c.cache_write ?? null, c.reasoning ?? null, info(m)];
		}
		out[pid] = rows;
	}
	return out;
}

function use(providers: Providers, at: number) {
	if (!Object.keys(providers).length) return;
	PROVIDERS = providers;
	ALL = Object.keys(providers);
	cache.clear();
	pricing.updated = new Date(at).toISOString().slice(0, 10);
	pricing.live = true;
	pricing.version++;
}

/** Load current prices from models.dev (cached for a few hours). Only the public price list is fetched; nothing is sent. */
export async function loadLivePrices() {
	let saved: { at: number; providers: Providers } | null = null;
	try {
		saved = JSON.parse(localStorage.getItem(LIVE_KEY) ?? 'null');
	} catch {
		/* storage blocked or corrupt */
	}
	if (saved?.providers) use(saved.providers, saved.at);
	if (saved && Date.now() - saved.at < MAX_AGE) return;
	try {
		const res = await fetch(API, { signal: AbortSignal.timeout(15_000), credentials: 'omit', referrerPolicy: 'no-referrer' });
		if (!res.ok) return;
		const providers = fromApi(await res.json());
		const at = Date.now();
		use(providers, at);
		try {
			localStorage.setItem(LIVE_KEY, JSON.stringify({ at, providers }));
		} catch {
			/* storage blocked or full: prices just load again next visit */
		}
	} catch {
		/* offline or blocked: keep the bundled or cached prices */
	}
}

export interface Price {
	provider: string;
	id: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

export const PREFERRED: Record<Tool, string[]> = {
	claude: ['anthropic'],
	codex: ['openai'],
	grok: ['xai'],
	antigravity: ['google'],
	opencode: ['opencode'],
	cursor: []
};

// Whether a tool reports reasoning tokens on top of output (rather than inside it).
const REASONING_SEPARATE: Record<Tool, boolean> = {
	claude: false,
	codex: false, // OpenAI's output_tokens already include reasoning
	grok: false, // Grok's totalTokens = input + output, reasoning inside output
	opencode: true,
	antigravity: true, // Gemini reports thinking tokens apart from the answer
	cursor: false
};

/** Candidate ids from most to least specific: "Claude-Opus-4-5-20251101" -> claude-opus-4-5-20251101, claude-opus-4-5, ... */
function candidates(model: string): string[] {
	const out: string[] = [];
	let id = model.toLowerCase().trim();
	const push = (x: string) => x && !out.includes(x) && out.push(x);
	push(id);
	id = id.replace(/-\d{8}$/, '').replace(/@\d{8}$/, '');
	push(id);
	for (const suffix of ['-build', '-latest', '-preview', '-thinking', '-high', '-low', '-medium', '-free']) if (id.endsWith(suffix)) push(id.slice(0, -suffix.length));
	// drop trailing "-segment"s one at a time, but keep at least "family-version"
	let cut = out[out.length - 1];
	while (cut.split('-').length > 2) {
		cut = cut.slice(0, cut.lastIndexOf('-'));
		push(cut);
	}
	return out;
}

const cache = new Map<string, Price | null>();

export function findPrice(model: string, tool: Tool): Price | null {
	void pricing.version; // re-run in derived values when live prices replace the bundled ones
	const key = tool + '|' + model;
	if (cache.has(key)) return cache.get(key)!;
	let found: Price | null = null;
	const slash = model.indexOf('/');
	// "opencode/deepseek-v4.1-flash-free" names its provider
	const [prov, bare] = slash > 0 ? [model.slice(0, slash), model.slice(slash + 1)] : [null, model];
	const order = [...new Set([...(prov ? [prov] : []), ...PREFERRED[tool], ...ALL])];
	outer: for (const id of candidates(bare)) {
		for (const p of order) {
			const row = PROVIDERS[p]?.[id];
			if (row) {
				const [input, output, cr, cw, r] = row;
				found = { provider: p, id, input, output, cacheRead: cr ?? input, cacheWrite: cw ?? input, reasoning: r ?? output };
				break outer;
			}
		}
	}
	cache.set(key, found);
	return found;
}

export function costOf(t: Partial<Tokens>, p: Price, tool: Tool): number {
	const usd =
		(t.input ?? 0) * p.input +
		(t.output ?? 0) * p.output +
		(t.cache_read ?? 0) * p.cacheRead +
		(t.cache_write ?? 0) * p.cacheWrite +
		(REASONING_SEPARATE[tool] ? (t.reasoning ?? 0) * p.reasoning : 0);
	return usd / 1e6;
}

export interface SessionPrice {
	usd: number;
	/** models with token usage but no price on models.dev */
	unpriced: string[];
	/** the model chosen in Settings that this session was priced at, in place of the models it recorded */
	assumed: string | null;
}

/** The model chosen in Settings for a tool. When set, all of that tool's sessions are priced at it,
 *  whatever model they recorded; clearing it goes back to each session's own models. */
export const assumedModel = (tool: Tool): string | null => prefs.priceAs?.[tool] || null;

export interface ModelOption {
	/** "provider/id" */
	value: string;
	provider: string;
	id: string;
	name: string;
	input: number;
	output: number;
	cacheRead: number | null;
	/** input and output modalities, e.g. ["text", "image", "pdf"] → ["text"]; empty when models.dev doesn't say */
	inputs: string[];
	outputs: string[];
	context: number | null;
	reasoning: boolean;
}

/** Every priced model, for choosing one in Settings. */
export function modelList(): ModelOption[] {
	void pricing.version;
	const out: ModelOption[] = [];
	for (const [provider, models] of Object.entries(PROVIDERS))
		for (const [id, [input, output, cacheRead, , , m]] of Object.entries(models))
			out.push({
				value: `${provider}/${id}`,
				provider,
				id,
				name: m?.n ?? id,
				input,
				output,
				cacheRead,
				inputs: m?.i ?? [],
				outputs: m?.o ?? [],
				context: m?.c ?? null,
				reasoning: !!m?.r
			});
	return out.sort((a, b) => a.value.localeCompare(b.value));
}

/** Search models by words in any order: "grok 4.6" finds xai/grok-4.6. Best matches first. */
export function searchModels(list: ModelOption[], query: string, preferred: string[] = [], limit = 40): ModelOption[] {
	const norm = (s: string) => s.toLowerCase().replace(/[-_/\s]+/g, ' ');
	const words = norm(query).split(' ').filter(Boolean);
	if (!words.length) return list.filter((m) => preferred.includes(m.provider)).slice(0, limit);
	const q = norm(query).trim();
	const scored: [number, ModelOption][] = [];
	for (const m of list) {
		const id = norm(m.id);
		const hay = `${norm(m.provider)} ${id} ${norm(m.name)}`;
		if (!words.every((w) => hay.includes(w))) continue;
		let score = 0;
		if (id === q || norm(m.name) === q) score -= 100;
		else if (id.startsWith(q) || norm(m.name).startsWith(q)) score -= 50;
		if (preferred.includes(m.provider)) score -= 20;
		if (m.provider === 'opencode') score += 10; // a reseller listing; the maker's own comes first
		score += id.length / 10;
		scored.push([score, m]);
	}
	return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, m]) => m);
}

const hasTokens = (t: Partial<Tokens>) => (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0) > 0;

/** Estimated cost of a session, including the subagents it spawned (also used for recovered usage, with none). */
export function priceSession(s: Pick<Session, 'source' | 'tokens' | 'models' | 'subagents'>): SessionPrice {
	// A model chosen in Settings replaces whatever the session recorded.
	const override = assumedModel(s.source);
	const op = override ? findPrice(override, s.source) : null;
	if (op) {
		let usd = costOf(s.tokens, op, s.source);
		for (const sub of s.subagents) usd += costOf(sub.tokens, op, s.source);
		return { usd, unpriced: [], assumed: override };
	}
	let usd = 0;
	const unpriced = new Set<string>();
	const add = (models: Record<string, Tokens>) => {
		for (const [model, t] of Object.entries(models ?? {})) {
			if (!hasTokens(t)) continue;
			const p = findPrice(model, s.source);
			if (p) usd += costOf(t, p, s.source);
			else unpriced.add(model);
		}
	};
	add(s.models);
	for (const sub of s.subagents) add(sub.models);
	return { usd, unpriced: [...unpriced], assumed: null };
}

export function usd(n: number): string {
	if (n === 0) return '$0';
	if (n < 0.01) return '<$0.01';
	if (n < 100) return '$' + n.toFixed(2);
	return '$' + Math.round(n).toLocaleString();
}
