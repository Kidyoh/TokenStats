import { describe, expect, it } from 'vitest';
import { prefs } from './prefs.svelte';
import { costOf, findPrice, priceSession } from './pricing.svelte';
import { emptyTokens, type Session } from './types';

describe('model price lookup', () => {
	it('matches exact, dated and suffixed ids to the first-party provider', () => {
		expect(findPrice('claude-opus-5-5', 'claude')?.provider).toBe('anthropic');
		expect(findPrice('claude-sonnet-4-5-20250929', 'claude')?.id).toMatch(/^claude-sonnet-4-5/);
		expect(findPrice('gpt-6-luna', 'codex')?.provider).toBe('openai');
		expect(findPrice('grok-4.6-build', 'grok')).toMatchObject({ provider: 'xai', id: 'grok-4.6' });
		expect(findPrice('gemini-3.7-flash', 'antigravity')?.provider).toBe('google');
		expect(findPrice('opencode/deepseek-v4.1-flash-free', 'opencode')?.provider).toBe('opencode');
	});
	it('returns null for unknown models', () => {
		expect(findPrice('totally-made-up-model', 'claude')).toBeNull();
	});
	it('prices cached tokens at the cache rate', () => {
		const p = { provider: 'x', id: 'x', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, reasoning: 15 };
		const usd = costOf({ input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6, reasoning: 1e6 }, p, 'claude');
		expect(usd).toBeCloseTo(3 + 15 + 0.3 + 3.75);
		expect(costOf({ reasoning: 1e6 }, p, 'opencode')).toBeCloseTo(15);
	});

});

describe('price override from Settings', () => {
	const tokens = { ...emptyTokens(), input: 1e6, output: 1e6 };
	const session = (models: Session['models']): Session => ({
		id: 'claude:x', source: 'claude', path: 'p', size: 1, parent: null, subagents: [], subagent_tokens: emptyTokens(),
		title: 't', first_prompt: 't', cwd: null, branch: null, start: 0, end: 0, tokens, models, cost: null, turns: 1, messages: 2, client: null
	});

	it('prices a session at the model it recorded until a model is chosen, then at the chosen one', () => {
		const s = session({ 'claude-opus-5-5': tokens });
		const own = findPrice('claude-opus-5-5', 'claude')!;
		const other = findPrice('xai/grok-4.6', 'claude')!;
		expect(other.input).not.toBe(own.input);

		prefs.priceAs = {};
		expect(priceSession(s)).toMatchObject({ assumed: null });
		expect(priceSession(s).usd).toBeCloseTo(own.input + own.output);

		prefs.priceAs = { claude: 'xai/grok-4.6' };
		expect(priceSession(s)).toMatchObject({ assumed: 'xai/grok-4.6', unpriced: [] });
		expect(priceSession(s).usd).toBeCloseTo(other.input + other.output);

		// Other tools aren't affected, and clearing it goes back.
		expect(priceSession({ ...s, source: 'codex', models: { 'gpt-6-luna': tokens } }).assumed).toBeNull();
		prefs.priceAs = {};
		expect(priceSession(s).usd).toBeCloseTo(own.input + own.output);
	});

	it('prices sessions with no recorded model only when a model is chosen', () => {
		const s = session({});
		prefs.priceAs = {};
		expect(priceSession(s).usd).toBe(0);
		prefs.priceAs = { claude: 'anthropic/claude-opus-5-5' };
		expect(priceSession(s).usd).toBeGreaterThan(0);
		prefs.priceAs = {};
	});
});
