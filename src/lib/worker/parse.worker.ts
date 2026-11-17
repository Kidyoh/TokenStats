/// <reference lib="webworker" />
// Parses session files off the main thread. Files never leave the device:
// they arrive here as File objects and only summaries/messages go back.
import { decompress } from 'fzstd';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { antigravityIndex, antigravityMessages, antigravitySummary } from '../parsers/antigravity';
import { claudeMessages, claudeSearchable, claudeSummary } from '../parsers/claude';
import { codexMessages, codexSummary } from '../parsers/codex';
import { lines, snippetAround } from '../parsers/common';
import { cursorMessages, cursorSummary } from '../parsers/cursor';
import { grokMessages, grokSummary } from '../parsers/grok';
import { opencodeMessages, opencodeSearch, opencodeSessions } from '../parsers/opencode';
import { applyWal } from '../parsers/sqlite-wal';
import { estimateTokens } from '../estimate';
import { computeStats } from '../stats';
import { totalTokens, type Msg, type Summary } from '../types';
import type { Req, Res, Unit } from './protocol';

let SQL: Promise<SqlJsStatic> | null = null;
let ocDb: Database | null = null;

async function readText(file: File): Promise<string> {
	if (file.name.endsWith('.zst')) return new TextDecoder().decode(decompress(new Uint8Array(await file.arrayBuffer())));
	return file.text();
}

async function openDb(db: File, wal: File | null | undefined): Promise<Database> {
	SQL ??= initSqlJs({ locateFile: () => wasmUrl });
	const sql = await SQL;
	const bytes = new Uint8Array(await db.arrayBuffer());
	const walBytes = wal ? new Uint8Array(await wal.arrayBuffer()) : null;
	return new sql.Database(applyWal(bytes, walBytes));
}

async function withDb<T>(u: Unit, fn: (db: Database) => T): Promise<T> {
	const db = await openDb(u.files.main, u.files.wal);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

/** A summary, with tokens estimated from the transcript when the tool recorded none. */
async function summarize(u: Unit): Promise<Summary> {
	const s = await readSummary(u);
	let msgs: Msg[] | null = null;
	try {
		msgs = await messages(u);
		s.stats = computeStats(msgs);
	} catch {
		/* keep the summary without stats */
	}
	if (totalTokens(s.tokens) === 0 && s.messages > 0 && msgs) {
		try {
			const t = await estimateTokens(msgs);
			if (totalTokens(t) > 0) {
				s.tokens = t;
				s.estimated = true;
			}
		} catch {
			/* keep the summary without tokens */
		}
	}
	return s;
}

async function readSummary(u: Unit): Promise<Summary> {
	switch (u.tool) {
		case 'claude':
			return claudeSummary(await readText(u.files.main));
		case 'codex':
			return codexSummary(await readText(u.files.main), u.path);
		case 'cursor':
			return cursorSummary(await readText(u.files.main), u.path, u.files.main.lastModified);
		case 'grok':
			return grokSummary(
				u.files.summary ? await u.files.summary.text() : null,
				await u.files.main.text(),
				u.files.usage ? await u.files.usage.text() : null
			);
		case 'antigravity':
			return withDb(u, (db) => antigravitySummary(db, u.agMeta));
	}
}

async function messages(u: Unit): Promise<Msg[]> {
	switch (u.tool) {
		case 'claude':
			return claudeMessages(await readText(u.files.main));
		case 'codex':
			return codexMessages(await readText(u.files.main));
		case 'cursor':
			return cursorMessages(await readText(u.files.main));
		case 'grok':
			return grokMessages(await u.files.main.text());
		case 'antigravity':
			return withDb(u, antigravityMessages);
	}
}

async function search(q: string, units: { id: string; unit: Unit }[]) {
	const ql = q.toLowerCase();
	const hits: { id: string; snippet: string }[] = [];
	for (const { id, unit } of units) {
		try {
			if (unit.tool === 'antigravity') {
				for (const m of await messages(unit)) {
					const i = (m.text ?? '').toLowerCase().indexOf(ql);
					if (i >= 0) {
						hits.push({ id, snippet: snippetAround(m.text!, i) });
						break;
					}
				}
				continue;
			}
			for (const line of lines(await readText(unit.files.main))) {
				if (unit.tool === 'claude' && !claudeSearchable(line)) continue;
				const i = line.toLowerCase().indexOf(ql);
				if (i >= 0) {
					hits.push({ id, snippet: snippetAround(line, i) });
					break;
				}
			}
		} catch {
			/* unreadable file: skip */
		}
	}
	return hits;
}

async function handle(req: Req): Promise<unknown> {
	switch (req.op) {
		case 'summarize':
			return summarize(req.unit);
		case 'messages':
			return messages(req.unit);
		case 'search':
			return search(req.q, req.units);
		case 'ag-index': {
			const db = await openDb(req.db, req.wal);
			try {
				return antigravityIndex(db);
			} finally {
				db.close();
			}
		}
		case 'opencode-load':
			ocDb?.close();
			ocDb = await openDb(req.db, req.wal);
			return opencodeSessions(ocDb, req.path).map((s) => {
				try {
					s.stats = computeStats(opencodeMessages(ocDb!, s.id.slice(9)));
				} catch {
					/* leave this session without stats */
				}
				return s;
			});
		case 'opencode-messages':
			if (!ocDb) throw new Error('OpenCode database is not loaded');
			return opencodeMessages(ocDb, req.sid);
		case 'opencode-search':
			return ocDb ? opencodeSearch(ocDb, req.q) : [];
	}
}

self.onmessage = async (e: MessageEvent<{ id: number; req: Req }>) => {
	const { id, req } = e.data;
	try {
		const result = await handle(req);
		self.postMessage({ id, ok: true, result } satisfies Res);
	} catch (err) {
		self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Res);
	}
};
