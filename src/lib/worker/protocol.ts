import type { AgIndexEntry } from '../parsers/antigravity';

export type UnitTool = 'claude' | 'codex' | 'grok' | 'cursor' | 'antigravity';

/** Everything needed to read one session (OpenCode is handled separately: one db holds all). */
export interface Unit {
	tool: UnitTool;
	path: string;
	/** claude/codex/cursor: main; grok: main (chat), summary, usage; antigravity: main (db), wal */
	files: { main: File; summary?: File | null; usage?: File | null; wal?: File | null };
	agMeta?: AgIndexEntry;
}

export type Req =
	| { op: 'summarize'; unit: Unit }
	| { op: 'messages'; unit: Unit }
	| { op: 'ag-index'; db: File; wal: File | null }
	| { op: 'opencode-load'; db: File; wal: File | null; path: string }
	| { op: 'opencode-messages'; sid: string }
	| { op: 'opencode-search'; q: string }
	| { op: 'search'; q: string; units: { id: string; unit: Unit }[] };

export type Res = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
