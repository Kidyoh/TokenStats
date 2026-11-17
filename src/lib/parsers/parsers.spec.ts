import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { decompress } from 'fzstd';
import initSqlJs from 'sql.js';
import { claudeMessages, claudeSummary } from './claude';
import { codexMessages, codexSummary } from './codex';
import { opencodeMessages, opencodeSessions } from './opencode';
import { applyWal } from './sqlite-wal';
import { isMetaPrompt, stripTagBlocks } from './common';
import { addTokens, emptyTokens } from '../types';

const HOME = homedir();
const CLAUDE = join(HOME, '.claude', 'projects');
const CODEX = join(HOME, '.codex');
const OC = join(HOME, '.local', 'share', 'opencode', 'opencode.db');

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

describe('common', () => {
	it('strips injected tag wrappers', () => {
		expect(stripTagBlocks('<a x="1">hi</a>\n<b>y</b> real prompt')).toBe('real prompt');
		expect(isMetaPrompt('<a>only tags</a>')).toBe(true);
		expect(isMetaPrompt('fix the <div> bug')).toBe(false);
	});
});

describe.runIf(existsSync(CLAUDE))('claude (real files)', () => {
	it('parses every main session file', () => {
		const tot = emptyTokens();
		let n = 0;
		for (const proj of readdirSync(CLAUDE)) {
			const dir = join(CLAUDE, proj);
			if (!statSync(dir).isDirectory()) continue;
			for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
				const s = claudeSummary(readFileSync(join(dir, f), 'utf8'));
				addTokens(tot, s.tokens);
				n++;
			}
		}
		console.log('claude sessions', n, JSON.stringify(tot));
		expect(n).toBeGreaterThan(0);
	});
	it('renders a conversation', () => {
		const proj = readdirSync(CLAUDE).find((p) => readdirSync(join(CLAUDE, p)).some((f) => f.endsWith('.jsonl')))!;
		const f = readdirSync(join(CLAUDE, proj)).find((x) => x.endsWith('.jsonl'))!;
		const msgs = claudeMessages(readFileSync(join(CLAUDE, proj, f), 'utf8'));
		expect(msgs.length).toBeGreaterThan(0);
	});
});

describe.runIf(existsSync(join(CODEX, 'sessions')))('codex (real files)', () => {
	it('parses plain and zstd rollouts', () => {
		const files = [...walk(join(CODEX, 'sessions')), ...(existsSync(join(CODEX, 'archived_sessions')) ? walk(join(CODEX, 'archived_sessions')) : [])].filter((f) =>
			/rollout-.*\.jsonl(\.zst)?$/.test(f)
		);
		const tot = emptyTokens();
		let zst = 0;
		for (const f of files) {
			const buf = readFileSync(f);
			const text = f.endsWith('.zst') ? (zst++, new TextDecoder().decode(decompress(buf))) : buf.toString('utf8');
			const s = codexSummary(text, f);
			addTokens(tot, s.tokens);
			if (f === files[0]) expect(codexMessages(text).length).toBeGreaterThan(0);
		}
		console.log('codex sessions', files.length, 'zst', zst, JSON.stringify(tot));
		expect(files.length).toBeGreaterThan(0);
	});
});

describe.runIf(existsSync(OC))('opencode (real db + wal)', () => {
	it('reads sessions including uncheckpointed WAL writes', async () => {
		const SQL = await initSqlJs();
		const wal = existsSync(OC + '-wal') ? readFileSync(OC + '-wal') : null;
		const bytes = applyWal(new Uint8Array(readFileSync(OC)), wal ? new Uint8Array(wal) : null);
		const db = new SQL.Database(bytes);
		const sessions = opencodeSessions(db, OC);
		const tot = emptyTokens();
		for (const s of sessions) addTokens(tot, s.tokens);
		const msgs = opencodeMessages(db, sessions[0].id.split(':')[1]);
		console.log('opencode sessions', sessions.length, JSON.stringify(tot), 'msgs in first', msgs.length);
		expect(sessions.length).toBeGreaterThan(0);
		db.close();
	});
});

// ---- Grok, Cursor, Antigravity -------------------------------------------------
import { grokMessages, grokSummary } from './grok';
import { cursorMessages, cursorSummary, parseCursorStamp } from './cursor';
import { antigravityIndex, antigravityMessages, antigravitySummary } from './antigravity';

const GROK = join(HOME, '.grok', 'sessions');
const CURSOR = join(HOME, '.cursor', 'projects');
const AG = join(HOME, '.gemini', 'antigravity');
const readOpt = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

describe('cursor timestamps', () => {
	it('parses the <timestamp> format', () => {
		expect(parseCursorStamp('Tuesday, Oct 13, 2026, 3:02 PM (UTC+3)')).toBe(Date.parse('2026-10-13T12:02:00Z'));
	});
});

describe.runIf(existsSync(GROK))('grok (real files)', () => {
	it('parses sessions', () => {
		const dirs = walk(GROK).filter((f) => f.endsWith('chat_history.jsonl')).map((f) => join(f, '..'));
		const tot = emptyTokens();
		let msgs = 0;
		for (const d of dirs) {
			const s = grokSummary(readOpt(join(d, 'summary.json')), readFileSync(join(d, 'chat_history.jsonl'), 'utf8'), readOpt(join(d, 'usage.json')));
			addTokens(tot, s.tokens);
			msgs += grokMessages(readFileSync(join(d, 'chat_history.jsonl'), 'utf8')).length;
		}
		console.log('grok sessions', dirs.length, 'msgs', msgs, JSON.stringify(tot));
		expect(dirs.length).toBeGreaterThan(0);
	});
});

describe.runIf(existsSync(CURSOR))('cursor (real files)', () => {
	it('parses agent transcripts', () => {
		const files = walk(CURSOR).filter((f) => f.includes('agent-transcripts') && f.endsWith('.jsonl'));
		let msgs = 0;
		const sample: string[] = [];
		for (const f of files) {
			const rel = f.slice(CURSOR.length + 1).split(sep).join('/');
			const s = cursorSummary(readFileSync(f, 'utf8'), rel, statSync(f).mtimeMs);
			if (sample.length < 3) sample.push(`${s.title.slice(0, 40)} | ${s.cwd} | ${s.start && new Date(s.start).toISOString()}`);
			msgs += cursorMessages(readFileSync(f, 'utf8')).length;
		}
		console.log('cursor sessions', files.length, 'msgs', msgs, '\n  ' + sample.join('\n  '));
		expect(files.length).toBeGreaterThan(0);
	});
});

describe.runIf(existsSync(join(AG, 'conversations')))('antigravity (real db + wal)', () => {
	it('decodes conversations', async () => {
		const SQL = await initSqlJs();
		const open = (p: string) => new SQL.Database(applyWal(new Uint8Array(readFileSync(p)), existsSync(p + '-wal') ? new Uint8Array(readFileSync(p + '-wal')) : null));
		const idx = antigravityIndex(open(join(AG, 'conversation_summaries.db')));
		const files = readdirSync(join(AG, 'conversations')).filter((f) => f.endsWith('.db'));
		const tot = emptyTokens();
		for (const f of files) {
			const db = open(join(AG, 'conversations', f));
			const s = antigravitySummary(db, idx[f.slice(0, -3)]);
			const m = antigravityMessages(db);
			addTokens(tot, s.tokens);
			const kinds = m.reduce((a, x) => ((a[x.kind] = (a[x.kind] ?? 0) + 1), a), {} as Record<string, number>);
			console.log('ag', s.title.slice(0, 40), '|', s.cwd, '|', Object.keys(s.models).join(','), JSON.stringify(kinds));
			db.close();
		}
		console.log('antigravity sessions', files.length, JSON.stringify(tot));
		expect(files.length).toBeGreaterThan(0);
	});
});

describe('injected context detection', () => {
	it('treats Codex snake_case wrapper blocks as context, not prompts', () => {
		expect(isMetaPrompt('<recommended_plugins>\nlist\n<environment_context><cwd>x</cwd>\n</environment_context>')).toBe(true);
		expect(isMetaPrompt('<div> is not rendering, can you fix it?')).toBe(false);
	});
});
