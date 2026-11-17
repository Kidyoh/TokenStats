// Refreshes src/lib/pricing.json from models.dev (https://models.dev/api.json).
// Runs before every build; if models.dev can't be reached the existing file is kept,
// so builds never fail because of it. Only first-party providers are kept: resellers
// list the same models at marked-up prices.
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../src/lib/pricing.json', import.meta.url);
const PROVIDERS = ['anthropic', 'openai', 'xai', 'google', 'deepseek', 'opencode', 'mistral', 'moonshotai', 'zai', 'alibaba', 'minimax', 'cohere', 'groq', 'cerebras'];

const info = (m) => ({
	n: m.name || undefined,
	i: m.modalities?.input?.length ? m.modalities.input : undefined,
	o: m.modalities?.output?.length ? m.modalities.output : undefined,
	c: m.limit?.context || undefined,
	r: m.reasoning || undefined
});

async function main() {
	let api;
	try {
		const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		api = await res.json();
	} catch (e) {
		const existing = await readFile(OUT, 'utf8').catch(() => null);
		console.warn(`[pricing] models.dev unavailable (${e.message}); keeping ${existing ? 'existing' : 'no'} pricing.json`);
		if (!existing) await writeFile(OUT, JSON.stringify({ updated: null, source: 'https://models.dev', providers: {} }));
		return;
	}
	const providers = {};
	let count = 0;
	for (const pid of PROVIDERS) {
		const p = api[pid];
		if (!p?.models) continue;
		const models = {};
		for (const [id, m] of Object.entries(p.models)) {
			const c = m.cost;
			if (!c || (c.input == null && c.output == null)) continue;
			// USD per 1M tokens: [input, output, cache read, cache write, reasoning], then what the model is:
			// { n: name, i: input modalities, o: output modalities, c: context window, r: reasons }. Keep in sync with pricing.svelte.ts.
			models[id] = [c.input ?? 0, c.output ?? 0, c.cache_read ?? null, c.cache_write ?? null, c.reasoning ?? null, info(m)];
			count++;
		}
		providers[pid] = models;
	}
	await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), source: 'https://models.dev', providers }));
	console.log(`[pricing] ${count} model prices from models.dev`);
}

main();
