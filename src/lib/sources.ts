// Finding session files inside folders the person picked.
// Works with File System Access handles (Chromium; can be remembered between visits)
// and with <input webkitdirectory> file lists (every browser; picked again each visit).
import type { Tool } from './types';

export type EntryKind =
	| 'claude'
	| 'claude-sub'
	| 'claude-stats'
	| 'claude-settings'
	| 'codex'
	| 'codex-index'
	| 'codex-state'
	| 'codex-state-wal'
	| 'oc-db'
	| 'oc-wal'
	| 'grok-chat'
	| 'grok-summary'
	| 'grok-usage'
	| 'cursor'
	| 'cursor-sub'
	| 'ag-db'
	| 'ag-wal'
	| 'ag-index'
	| 'ag-index-wal'
	| 'ag-pb';

export interface Entry {
	kind: EntryKind;
	/** path inside the picked folder, starting with the folder's own name */
	path: string;
	file: File;
	/** session id (claude-sub: the parent session's id) */
	sid?: string;
}

export interface Root {
	id: string;
	name: string;
	handle?: FileSystemDirectoryHandle;
	files?: File[];
	/** relative paths for `files` when they didn't come from a directory input */
	paths?: string[];
	addedAt: number;
	/** which tools' sessions this folder held at its last sync */
	tools?: Tool[];
	lastSync?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'tool-results', 'memory', 'snapshot', 'repos', 'tool-output', 'log', 'logs', 'cache', 'plugins', 'compaction', 'terminal']);
const HOME_DIRS = ['.claude', '.codex', '.local', '.grok', '.gemini', '.cursor'];
/** Claude Code config folders: ~/.claude, plus extra accounts kept in e.g. ~/.claude-work (CLAUDE_CONFIG_DIR) */
const CLAUDE_DIR = /^\.claude([-_.].+)?$/;
const isHomeDir = (n: string) => HOME_DIRS.includes(n) || CLAUDE_DIR.test(n);

/**
 * The Claude Code config folder (one per account) a file belongs to, as a path prefix: the folder holding
 * `projects/` for transcripts, the containing folder for stats-cache.json and settings.json.
 */
export function claudeAccount(path: string): string {
	const segs = path.split('/');
	const i = segs.lastIndexOf('projects');
	return (i >= 0 ? segs.slice(0, i) : segs.slice(0, -1)).join('/');
}
const GROK_FILES: Record<string, EntryKind> = { 'chat_history.jsonl': 'grok-chat', 'summary.json': 'grok-summary', 'usage.json': 'grok-usage' };

export function classify(segs: string[]): Omit<Entry, 'file' | 'path'> | null {
	const name = segs[segs.length - 1];
	const parent = segs[segs.length - 2] ?? '';
	// Cursor: .../agent-transcripts/<id>/<id>.jsonl (checked first: its names look like Claude's)
	if (segs.includes('agent-transcripts') && name.endsWith('.jsonl')) {
		// .../agent-transcripts/<id>/subagents/<sub>.jsonl belongs to session <id>
		if (parent === 'subagents') return { kind: 'cursor-sub', sid: segs[segs.indexOf('agent-transcripts') + 1] };
		return { kind: 'cursor', sid: name.slice(0, -6) };
	}
	// Grok: .../sessions/<encoded cwd>/<id>/{chat_history.jsonl, summary.json, usage.json}
	if (GROK_FILES[name] && UUIDISH.test(parent)) return { kind: GROK_FILES[name], sid: parent };
	// Antigravity: .../antigravity/conversations/<id>.db (+ -wal) and conversation_summaries.db
	if (name === 'conversation_summaries.db') return { kind: 'ag-index' };
	if (name === 'conversation_summaries.db-wal') return { kind: 'ag-index-wal' };
	const agm = /^([0-9a-f-]{36})\.db(-wal)?$/i.exec(name);
	if (agm && parent === 'conversations') return { kind: agm[2] ? 'ag-wal' : 'ag-db', sid: agm[1] };
	// Older Antigravity conversations are encrypted .pb files: counted, not read
	if (/^[0-9a-f-]{36}\.pb$/i.test(name) && parent === 'conversations') return { kind: 'ag-pb', sid: name.slice(0, 36) };
	if (/^rollout-.*\.jsonl(\.zst)?$/.test(name)) return { kind: 'codex', sid: name.split('.')[0].slice(-36) };
	if (name === 'session_index.jsonl' && segs.includes('.codex')) return { kind: 'codex-index' };
	if (name === 'session_index.jsonl' && segs.length === 2) return { kind: 'codex-index' };
	// Running totals that outlive deleted session files
	const state = /^state_\d+\.sqlite(-wal)?$/.exec(name);
	if (state && (segs.includes('.codex') || segs.length === 2)) return { kind: state[1] ? 'codex-state-wal' : 'codex-state' };
	if (name === 'stats-cache.json' && (CLAUDE_DIR.test(parent) || segs.length === 2)) return { kind: 'claude-stats' };
	if (name === 'settings.json' && CLAUDE_DIR.test(parent)) return { kind: 'claude-settings' };
	if (name === 'opencode.db') return { kind: 'oc-db' };
	if (name === 'opencode.db-wal') return { kind: 'oc-wal' };
	if (!name.endsWith('.jsonl')) return null;
	const base = name.slice(0, -6);
	if (UUID.test(base) && !segs.slice(0, -1).some((s) => UUID.test(s))) return { kind: 'claude', sid: base };
	const parentSid = [...segs.slice(0, -1)].reverse().find((s) => UUID.test(s));
	if (parentSid && segs.includes('subagents')) return { kind: 'claude-sub', sid: parentSid };
	return null;
}

/** Which children of a directory are worth walking into. Keeps a whole-home pick fast. */
function childFilter(dirName: string, childNames: string[]): (name: string, isDir: boolean) => boolean {
	const has = (n: string) => childNames.includes(n);
	if (HOME_DIRS.some(has)) return (n, d) => d && isHomeDir(n); // a home folder
	if (has('chat_history.jsonl')) return (n, d) => !d && n in GROK_FILES; // a Grok session folder
	if (has('agent-transcripts')) return (n, d) => d && n === 'agent-transcripts'; // a Cursor project folder
	if (CLAUDE_DIR.test(dirName)) return (n, d) => !d || n === 'projects';
	switch (dirName) {
		case '.codex':
			return (n, d) => (d ? ['sessions', 'archived_sessions'].includes(n) : n === 'session_index.jsonl' || /^state_\d+\.sqlite(-wal)?$/.test(n));
		case '.local':
			return (n, d) => d && n === 'share';
		case 'share':
			return (n, d) => d && n === 'opencode';
		case 'opencode':
			return (n, d) => !d && n.startsWith('opencode.db');
		case '.grok':
			return (n, d) => d && n === 'sessions';
		case '.gemini':
			return (n, d) => d && n === 'antigravity';
		case 'antigravity':
			return (n, d) => (d ? n === 'conversations' : n.startsWith('conversation_summaries.db'));
		case 'conversations':
			return (n, d) => !d && /\.(db(-wal)?|pb)$/.test(n);
		case '.cursor':
			return (n, d) => d && n === 'projects';
	}
	return (n, d) => !d || (!SKIP_DIRS.has(n) && !n.startsWith('.agent-data-cleanup'));
}

async function walkHandle(dir: FileSystemDirectoryHandle, segs: string[], out: Entry[], depth = 0) {
	if (depth > 8) return;
	const children: [string, FileSystemHandle][] = [];
	for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) children.push([name, h]);
	const keep = childFilter(dir.name, children.map(([n]) => n));
	await Promise.all(
		children.map(async ([name, h]) => {
			const isDir = h.kind === 'directory';
			if (!keep(name, isDir)) return;
			const p = [...segs, name];
			if (isDir) return walkHandle(h as FileSystemDirectoryHandle, p, out, depth + 1);
			const c = classify(p);
			if (c) out.push({ ...c, path: p.join('/'), file: await (h as FileSystemFileHandle).getFile() });
		})
	);
}

export async function collect(root: Root): Promise<Entry[]> {
	const out: Entry[] = [];
	if (root.handle) await walkHandle(root.handle, [root.handle.name], out);
	else
		for (const [i, f] of (root.files ?? []).entries()) {
			const segs = (root.paths?.[i] || f.webkitRelativePath || f.name).split('/');
			if (segs.some((s) => s === 'node_modules' || s === '.git')) continue;
			const c = classify(segs);
			if (c) out.push({ ...c, path: segs.join('/'), file: f });
		}
	return out;
}

// Drag and drop: Chromium gives a real directory handle (can be remembered); other browsers give
// FileSystemEntry trees, which we walk with the same pruning as above.
type FsEntry = { name: string; isDirectory: boolean; isFile: boolean };
type FsDirEntry = FsEntry & { createReader(): { readEntries(cb: (e: FsEntry[]) => void, err: (e: unknown) => void): void } };
type FsFileEntry = FsEntry & { file(cb: (f: File) => void, err: (e: unknown) => void): void };

async function readAll(dir: FsDirEntry): Promise<FsEntry[]> {
	const reader = dir.createReader();
	const out: FsEntry[] = [];
	for (;;) {
		const batch = await new Promise<FsEntry[]>((res, rej) => reader.readEntries(res, rej));
		if (!batch.length) return out;
		out.push(...batch);
	}
}

async function walkEntry(dir: FsDirEntry, segs: string[], files: File[], paths: string[], depth = 0) {
	if (depth > 8) return;
	const children = await readAll(dir);
	const keep = childFilter(dir.name, children.map((c) => c.name));
	await Promise.all(
		children.map(async (c) => {
			if (!keep(c.name, c.isDirectory)) return;
			const p = [...segs, c.name];
			if (c.isDirectory) return walkEntry(c as FsDirEntry, p, files, paths, depth + 1);
			if (!classify(p)) return;
			files.push(await new Promise<File>((res, rej) => (c as FsFileEntry).file(res, rej)));
			paths.push(p.join('/'));
		})
	);
}

export type Dropped = { handle: FileSystemDirectoryHandle } | { files: File[]; paths: string[] };

/** Call synchronously from the drop event: browsers only allow reading the items during it. */
export function readDrop(dt: DataTransfer): Promise<Dropped[]> {
	const items = [...dt.items].filter((i) => i.kind === 'file');
	const handles = items.map((i) => (i as any).getAsFileSystemHandle?.() as Promise<FileSystemHandle | null> | undefined);
	const entries = items.map((i) => i.webkitGetAsEntry?.() as FsEntry | null);
	return Promise.all(
		items.map(async (_, i): Promise<Dropped | null> => {
			const h = await handles[i]?.catch(() => null);
			if (h?.kind === 'directory') return { handle: h as FileSystemDirectoryHandle };
			const e = entries[i];
			if (e?.isDirectory) {
				const files: File[] = [];
				const paths: string[] = [];
				await walkEntry(e as FsDirEntry, [e.name], files, paths);
				return { files, paths };
			}
			return null;
		})
	).then((r) => r.filter((x): x is Dropped => !!x));
}

export const supportsHandles = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function ensurePermission(h: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
	const opts = { mode: 'read' } as const;
	const anyH = h as any;
	if ((await anyH.queryPermission?.(opts)) === 'granted') return true;
	if (!ask) return false;
	return (await anyH.requestPermission?.(opts)) === 'granted';
}
