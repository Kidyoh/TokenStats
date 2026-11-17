import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeCoverage, claudeRetention, codexCoverage, dayStart, dedupeCalls, otherNotes, parseClaudeStatsCache, parseDay } from './history';
import { claudeSummary } from './parsers/claude';
import { codexSummary } from './parsers/codex';
import { classify } from './sources';
import { totalTokens, type Call } from './types';

const day = (s: string) => parseDay(s)!;
const at = (s: string, h = 12) => day(s) + h * 36e5;
const sum = (h: { tokens: Parameters<typeof totalTokens>[0] }[]) => h.reduce((a, x) => a + totalTokens(x.tokens), 0);

function cache(o: { last: string; daily?: [string, Record<string, number>][]; activity?: [string, number][]; models: Record<string, [number, number, number, number]>; first?: string }) {
	return JSON.stringify({
		version: 5,
		lastComputedDate: o.last,
		firstSessionDate: o.first ? o.first + 'T08:00:00.000Z' : undefined,
		dailyActivity: (o.activity ?? []).map(([date, messageCount]) => ({ date, messageCount, sessionCount: 1, toolCallCount: 0 })),
		dailyModelTokens: (o.daily ?? []).map(([date, tokensByModel]) => ({ date, tokensByModel })),
		modelUsage: Object.fromEntries(
			Object.entries(o.models).map(([m, [i, out, cr, cw]]) => [m, { inputTokens: i, outputTokens: out, cacheReadInputTokens: cr, cacheCreationInputTokens: cw }])
		)
	});
}
const call = (id: string, model: string, when: number | null, n: number): Call => [id, model, when, 0, 0, n, 0];

describe('Claude Code: responses repeated across files', () => {
	it('counts a response once, in the earliest file', () => {
		const a = { id: 'a', start: 1, calls: [call('m1', 'opus', 1, 100), call('m2', 'opus', 2, 50)] };
		const b = { id: 'b', start: 5, calls: [call('m1', 'opus', 1, 100), call('m3', 'opus', 6, 10)] };
		const { calls, extra } = dedupeCalls([b, a]);
		expect(calls.map((c) => c[0])).toEqual(['m1', 'm2', 'm3']);
		expect(extra.has('a')).toBe(false);
		expect(totalTokens(extra.get('b')!.tokens)).toBe(100);
		expect(totalTokens(extra.get('b')!.models.opus)).toBe(100);
	});

	it('keeps one usage per message id within a file and records its time', () => {
		const line = (id: string, out: number, ts: string) =>
			JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'opus', usage: { input_tokens: 1, output_tokens: out } } });
		const s = claudeSummary([line('m1', 1, '2026-11-10T10:00:00Z'), line('m1', 7, '2026-11-10T10:00:01Z'), line('m2', 3, '2026-11-10T10:01:00Z')].join('\n'));
		expect(s.tokens.output).toBe(10);
		expect(s.calls).toEqual([
			['m1', 'opus', Date.parse('2026-11-10T10:00:00Z'), 1, 7, 0, 0],
			['m2', 'opus', Date.parse('2026-11-10T10:01:00Z'), 1, 3, 0, 0]
		]);
	});
});

describe('Claude Code: stats-cache.json', () => {
	const now = at('2026-11-17');

	it('adds the cached usage when no transcript covers it, and reports the gap after it', () => {
		const c = parseClaudeStatsCache(
			cache({
				last: '2026-10-08',
				daily: [
					['2026-10-07', { opus: 300 }],
					['2026-10-08', { opus: 700 }]
				],
				models: { opus: [100, 100, 700, 100] }
			})
		)!;
		const { history, notes } = claudeCoverage({ cache: c, calls: [call('x', 'opus', at('2026-11-10'), 5)], now });
		expect(sum(history)).toBe(1000);
		expect(history.map((h) => [h.from, totalTokens(h.tokens)])).toEqual([
			[day('2026-10-07'), 300],
			[day('2026-10-08'), 700]
		]);
		// split like the model's all-time mix
		expect(history[1].models.opus).toEqual({ input: 70, output: 70, cache_read: 490, cache_write: 70, reasoning: 0 });
		const gap = notes.find((n) => n.kind === 'gap')!;
		expect([gap.from, gap.to]).toEqual([day('2026-10-09'), day('2026-11-09')]);
	});

	it("doesn't count usage twice where surviving transcripts overlap the cache", () => {
		const c = parseClaudeStatsCache(
			cache({
				last: '2026-10-08',
				daily: [
					['2026-10-07', { opus: 300 }],
					['2026-10-08', { opus: 700 }]
				],
				models: { opus: [0, 0, 1000, 0] }
			})
		)!;
		// a transcript from Oct 8 is still there with 200 of that day's 700; later ones go past the cache
		const calls = [call('a', 'opus', at('2026-10-08'), 200), call('b', 'opus', at('2026-10-09'), 50)];
		const { history, notes } = claudeCoverage({ cache: c, calls, now });
		expect(sum(history)).toBe(800);
		expect(history.find((h) => h.from === day('2026-10-08'))!.tokens.cache_read).toBe(500);
		expect(notes.some((n) => n.kind === 'gap')).toBe(false);
	});

	it('never goes negative when transcripts hold more than the cache', () => {
		const c = parseClaudeStatsCache(cache({ last: '2026-10-08', daily: [['2026-10-08', { opus: 10 }]], models: { opus: [0, 0, 10, 0] } }))!;
		const { history } = claudeCoverage({ cache: c, calls: [call('a', 'opus', at('2026-10-08'), 999)], now });
		expect(history).toEqual([]);
	});

	it('spreads usage the cache has no per-day tokens for over its active days by messages', () => {
		const c = parseClaudeStatsCache(
			cache({
				last: '2026-08-02',
				first: '2026-07-02',
				activity: [
					['2026-07-02', 30],
					['2026-07-04', 10],
					['2026-08-01', 5]
				],
				daily: [['2026-08-01', { opus: 100 }]],
				models: { opus: [0, 0, 500, 0], haiku: [0, 0, 40, 0] }
			})
		)!;
		const { history } = claudeCoverage({ cache: c, calls: [], now });
		expect(sum(history)).toBe(540);
		const on = (d: string) => totalTokens(history.find((h) => h.from === day(d))!.tokens);
		expect(on('2026-07-02')).toBe(300 + 30);
		expect(on('2026-07-04')).toBe(100 + 10);
		expect(on('2026-08-01')).toBe(100);
	});

	it('reports the whole span to today when no transcripts are left', () => {
		const c = parseClaudeStatsCache(cache({ last: '2026-10-08', daily: [['2026-10-08', { opus: 1 }]], models: { opus: [0, 0, 1, 0] } }))!;
		const gap = claudeCoverage({ cache: c, calls: [], now }).notes.find((n) => n.kind === 'gap')!;
		expect([gap.from, gap.to]).toEqual([day('2026-10-09'), dayStart(now)]);
	});

	it('rejects files in a shape it does not know', () => {
		expect(parseClaudeStatsCache('{"version":5}')).toBeNull();
		expect(parseClaudeStatsCache('not json')).toBeNull();
	});
});

describe('Claude Code: retention', () => {
	const now = at('2026-11-17');
	const recent = [call('a', 'opus', at('2026-10-19'), 1)];

	it('says older usage is missing when transcripts start at the retention limit', () => {
		const { notes } = claudeCoverage({ cache: null, retention: null, calls: recent, now });
		expect(notes.find((n) => n.kind === 'gap')?.to).toBe(day('2026-10-18'));
		expect(notes.find((n) => n.kind === 'tip')?.text).toContain('cleanupPeriodDays');
	});

	it('stays quiet when retention is long', () => {
		expect(claudeCoverage({ cache: null, retention: 99999, calls: recent, now }).notes).toEqual([]);
	});

	it('gives no tip when settings.json was not picked', () => {
		expect(claudeCoverage({ cache: null, calls: recent, now }).notes.some((n) => n.kind === 'tip')).toBe(false);
	});

	it('reads cleanupPeriodDays', () => {
		expect(claudeRetention('{"cleanupPeriodDays": 90}')).toBe(90);
		expect(claudeRetention('{}')).toBeNull();
	});
});

describe('Codex', () => {
	const tc = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
	const count = (input: number, cached: number, output: number, extra: object = {}) =>
		JSON.stringify({
			type: 'event_msg',
			payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output, ...extra } } }
		});

	it('credits each turn to the model in use, and ignores repeated totals', () => {
		const s = codexSummary([tc('sol'), count(100, 60, 10), count(100, 60, 10), tc('luna'), count(300, 200, 30)].join('\n'));
		expect(totalTokens(s.tokens)).toBe(330); // = final total_tokens
		expect(s.models.sol).toMatchObject({ input: 40, cache_read: 60, output: 10 });
		expect(s.models.luna).toMatchObject({ input: 60, cache_read: 140, output: 20 });
	});

	it("doesn't count cache writes twice when input_tokens already includes them", () => {
		const s = codexSummary(count(100, 20, 10, { cache_write_input_tokens: 30 }));
		expect(totalTokens(s.tokens)).toBe(110);
		expect(s.tokens).toMatchObject({ input: 50, cache_read: 20, cache_write: 30 });
		// …and adds them when total_tokens shows they're separate
		const t = codexSummary(count(100, 20, 10, { cache_write_input_tokens: 30, total_tokens: 140 }));
		expect(totalTokens(t.tokens)).toBe(140);
	});

	it('recovers threads whose rollout files are gone from the state database', () => {
		const threads = [
			{ id: 'kept', tokens: 500, model: 'sol', cwd: '/p', title: 'a', start: at('2026-11-01'), end: at('2026-11-01') },
			{ id: 'gone', tokens: 1000, model: 'sol', cwd: '/p', title: 'b', start: at('2026-09-01'), end: at('2026-09-02') },
			{ id: 'empty', tokens: 0, model: 'sol', cwd: '/p', title: 'c', start: null, end: null }
		];
		const { history, notes } = codexCoverage(threads, new Set(['kept']), { sol: { input: 10, output: 10, cache_read: 80, cache_write: 0, reasoning: 0 } });
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ from: day('2026-09-02'), cwd: '/p', approx: true });
		expect(history[0].models.sol).toMatchObject({ input: 100, output: 100, cache_read: 800 });
		expect(notes[0].text).toContain('1 thread');
	});
});

describe('tools that keep no usage', () => {
	it('explains Cursor and encrypted Antigravity conversations instead of showing nothing', () => {
		const notes = otherNotes({ cursor: 3, agEncrypted: 2 });
		expect(notes.map((n) => [n.source, n.kind])).toEqual([
			['cursor', 'missing'],
			['antigravity', 'missing']
		]);
		expect(otherNotes({ cursor: 0, agEncrypted: 0 })).toEqual([]);
	});
});

describe('finding the extra files', () => {
	it('classifies running-total files', () => {
		expect(classify(['.claude', 'stats-cache.json'])?.kind).toBe('claude-stats');
		expect(classify(['mac', '.claude', 'settings.json'])?.kind).toBe('claude-settings');
		expect(classify(['proj', '.vscode', 'settings.json'])).toBeNull();
		expect(classify(['.codex', 'state_5.sqlite'])?.kind).toBe('codex-state');
		expect(classify(['.codex', 'state_5.sqlite-wal'])?.kind).toBe('codex-state-wal');
		expect(classify(['antigravity', 'conversations', '01233267-0b1d-43a6-8d24-4899c80407ea.pb'])).toEqual({ kind: 'ag-pb', sid: '01233267-0b1d-43a6-8d24-4899c80407ea' });
	});
});

// Against this machine's own files, when there are any: transcripts plus what's recovered from the cache
// should come to at least the cache's own all-time total (more when transcripts go past its last day).
const CLAUDE = join(homedir(), '.claude');
describe.runIf(existsSync(join(CLAUDE, 'stats-cache.json')) && existsSync(join(CLAUDE, 'projects')))('Claude Code (real files)', () => {
	it('recovers the cached totals without double counting', () => {
		const c = parseClaudeStatsCache(readFileSync(join(CLAUDE, 'stats-cache.json'), 'utf8'));
		if (!c) return void expect(c).toBeNull();
		const files: { id: string; start: number | null; calls?: Call[] }[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(d, e.name));
				else if (e.name.endsWith('.jsonl')) {
					const s = claudeSummary(readFileSync(join(d, e.name), 'utf8'));
					files.push({ id: join(d, e.name), start: s.start, calls: s.calls });
				}
			}
		};
		walk(join(CLAUDE, 'projects'));
		const { calls } = dedupeCalls(files);
		const { history, notes } = claudeCoverage({ cache: c, calls });
		const cached = Object.values(c.models).reduce((a, t) => a + totalTokens(t), 0);
		const transcripts = calls.reduce((a, x) => a + x[3] + x[4] + x[5] + x[6], 0);
		console.log('claude cache', cached, 'recovered', sum(history), 'transcripts', transcripts, 'notes', notes.map((n) => n.kind));
		expect(sum(history) + transcripts).toBeGreaterThanOrEqual(cached - 1000);
	});
});
