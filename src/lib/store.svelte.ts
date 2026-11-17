import type { AgIndexEntry } from './parsers/antigravity';
import { codexThreadNames } from './parsers/codex';
import { idb } from './idb';
import { collect, ensurePermission, type Entry, type Root } from './sources';
import { addTokens, emptyTokens, TOOL_IDS, type Msg, type SearchHit, type Session, type Summary, type Tool } from './types';
import { Pool } from './worker/pool';
import type { Unit } from './worker/protocol';

const PARSER_VERSION = 5; // 5: summaries carry tool and time stats
const LRU_KEY = 'sb-recent-conversations';
/** How many recently opened conversations to keep for reading before the next sync */
const RECENT_LIMIT = 25;

/** The conversation can't be read until the folders are synced again (and it isn't cached). */
export class NeedsSync extends Error {
	constructor() {
		super('Sync to read this conversation');
		this.name = 'NeedsSync';
	}
}

export type Found = Record<Tool, number> & { total: number };

const ENTRY_TOOL: Partial<Record<Entry['kind'], Tool>> = {
	claude: 'claude',
	codex: 'codex',
	'oc-db': 'opencode',
	'grok-chat': 'grok',
	cursor: 'cursor',
	'ag-db': 'antigravity'
};

function countFound(entries: Entry[]): Found {
	const f: Found = { claude: 0, codex: 0, opencode: 0, grok: 0, antigravity: 0, cursor: 0, total: 0 };
	for (const e of entries) {
		const t = ENTRY_TOOL[e.kind];
		if (t) {
			f[t]++;
			f.total++;
		}
	}
	return f;
}

interface Located {
	session: Session;
	unit?: Unit; // absent for OpenCode (lives in one shared db)
	subs: Map<string, Unit>;
}

const fileKey = (f: File | null | undefined) => (f ? `${f.size}:${f.lastModified}` : '-');
const unitKey = (u: Unit) =>
	`${PARSER_VERSION}|${u.tool}|${u.path}|${fileKey(u.files.main)}|${fileKey(u.files.summary)}|${fileKey(u.files.usage)}|${fileKey(u.files.wal)}|${u.agMeta?.title ?? ''}`;

/** Group loose files into one unit per session. */
function toUnits(entries: Entry[], agIndex: Record<string, AgIndexEntry>) {
	const units: { id: string; unit: Unit; parent?: string }[] = [];
	const grok = new Map<string, { main?: File; summary?: File; usage?: File; path?: string }>();
	const agWal = new Map(entries.filter((e) => e.kind === 'ag-wal').map((e) => [e.sid!, e.file]));
	for (const e of entries) {
		const one = (tool: Unit['tool']) => ({ tool, path: e.path, files: { main: e.file } });
		switch (e.kind) {
			case 'claude':
				units.push({ id: `claude:${e.sid}`, unit: one('claude') });
				break;
			case 'claude-sub':
				units.push({ id: `claude-sub:${e.sid}:${e.path.split('/').pop()}`, unit: one('claude'), parent: `claude:${e.sid}` });
				break;
			case 'codex':
				units.push({ id: `codex:${e.sid}`, unit: one('codex') });
				break;
			case 'cursor':
				units.push({ id: `cursor:${e.sid}`, unit: one('cursor') });
				break;
			case 'cursor-sub':
				units.push({ id: `cursor-sub:${e.sid}:${e.path.split('/').pop()}`, unit: one('cursor'), parent: `cursor:${e.sid}` });
				break;
			case 'ag-db':
				units.push({
					id: `antigravity:${e.sid}`,
					unit: { tool: 'antigravity', path: e.path, files: { main: e.file, wal: agWal.get(e.sid!) ?? null }, agMeta: agIndex[e.sid!] }
				});
				break;
			case 'grok-chat':
			case 'grok-summary':
			case 'grok-usage': {
				const g = grok.get(e.sid!) ?? {};
				if (e.kind === 'grok-chat') {
					g.main = e.file;
					g.path = e.path;
				} else g[e.kind === 'grok-summary' ? 'summary' : 'usage'] = e.file;
				grok.set(e.sid!, g);
				break;
			}
		}
	}
	for (const [sid, g] of grok)
		if (g.main) units.push({ id: `grok:${sid}`, unit: { tool: 'grok', path: g.path!, files: { main: g.main, summary: g.summary ?? null, usage: g.usage ?? null } } });
	return units;
}

class App {
	roots = $state.raw<Root[]>([]);
	/** roots remembered from an earlier visit that need a click to re-grant access */
	pendingRoots = $state.raw<Root[]>([]);
	sessions = $state.raw<Session[]>([]);
	phase = $state<'idle' | 'scanning' | 'ready'>('idle');
	progress = $state({ done: 0, total: 0, label: '' });
	errors = $state<string[]>([]);
	ready = $state(false);

	#pool: Pool | null = null;
	#index = new Map<string, Located>();
	#ocSlot = 0;

	get pool() {
		return (this.#pool ??= new Pool());
	}

	/** When the sessions on screen were last read from the folders */
	lastSync = $state<number | null>(null);
	/** True once this visit has read the folders (conversations can then be opened directly) */
	live = $state(false);

	async init() {
		// Show the last sync right away; reading folders again needs access the browser may want re-granted.
		const snap = await idb.get<{ sessions: Session[]; at: number }>('snapshot', 'last');
		if (snap?.sessions?.length) {
			this.sessions = snap.sessions;
			this.lastSync = snap.at;
		}
		const saved = await idb.all<Root>('roots');
		const granted: Root[] = [];
		const pending: Root[] = [];
		for (const r of saved) {
			// Folders picked without a handle (browsers without folder access) can't be reopened: they wait for a new pick.
			if (r.handle && (await ensurePermission(r.handle, false))) granted.push(r);
			else pending.push(r);
		}
		this.roots = granted;
		this.pendingRoots = pending;
		this.ready = true;
		// Everything still accessible (e.g. "Allow on every visit"): refresh quietly.
		if (granted.length && !pending.some((r) => r.handle)) await this.scan();
	}

	/**
	 * Re-grant access to every remembered folder and re-read them. Call it straight from a click:
	 * browsers only show the permission prompts during a user gesture, so the requests start before any await.
	 */
	sync(): Promise<void> {
		const waiting = this.pendingRoots.filter((r) => r.handle);
		const asks = waiting.map((r) =>
			((r.handle as any).requestPermission?.({ mode: 'read' }) as Promise<PermissionState> | undefined)?.catch(() => 'denied') ?? Promise.resolve('denied')
		);
		return (async () => {
			const answers = await Promise.all(asks);
			const ok = waiting.filter((_, i) => answers[i] === 'granted');
			if (ok.length) {
				this.pendingRoots = this.pendingRoots.filter((r) => !ok.includes(r));
				this.roots = [...this.roots, ...ok];
			}
			if (this.roots.length) await this.scan();
		})();
	}

	/** Adds a picked folder if it holds any sessions. Returns what was found so the UI can explain a wrong pick. */
	async addHandle(handle: FileSystemDirectoryHandle): Promise<Found> {
		for (const r of [...this.roots, ...this.pendingRoots]) {
			if (r.handle && (await r.handle.isSameEntry(handle))) {
				await this.reconnect(r);
				return countFound(await collect(r));
			}
		}
		const root: Root = { id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now() };
		const found = countFound(await collect(root));
		if (!found.total) return found;
		await idb.set('roots', root.id, root);
		this.roots = [...this.roots, root];
		await this.scan();
		return found;
	}

	async addFiles(files: File[], paths?: string[]): Promise<Found> {
		const first = files.length ? (paths?.[0] || files[0].webkitRelativePath || files[0].name).split('/')[0] : '';
		const root: Root = { id: crypto.randomUUID(), name: first, files, paths, addedAt: Date.now() };
		const found = countFound(await collect(root));
		if (!found.total) return found;
		// Picking the same folder again replaces the remembered one that was waiting for this.
		const stale = this.pendingRoots.filter((r) => !r.handle && r.name === first);
		for (const r of stale) await idb.del('roots', r.id);
		this.pendingRoots = this.pendingRoots.filter((r) => !stale.includes(r));
		this.roots = [...this.roots, root];
		await this.scan();
		return found;
	}

	async reconnect(root: Root) {
		if (!root.handle || !(await ensurePermission(root.handle, true))) return;
		this.pendingRoots = this.pendingRoots.filter((r) => r.id !== root.id);
		if (!this.roots.some((r) => r.id === root.id)) this.roots = [...this.roots, root];
		await this.scan();
	}

	/** Forget a folder and everything cached from it: its parsed summaries and saved conversations.
	 *  Its sessions leave the list; choosing the folder again reads them afresh. */
	async removeRoot(root: Root) {
		await idb.del('roots', root.id);
		this.roots = this.roots.filter((r) => r.id !== root.id);
		this.pendingRoots = this.pendingRoots.filter((r) => r.id !== root.id);

		// Session paths start with the picked folder's name ("…/.claude/projects/x/y.jsonl" → ".claude").
		const inRoot = (path: string | null | undefined) => (path ?? '').split('/')[0] === root.name;
		const gone = this.sessions.filter((s) => inRoot(s.path));
		const ids = new Set(gone.flatMap((s) => [s.id, ...s.subagents.map((x) => x.id)]));
		for (const id of ids) await idb.del('messages', id);
		try {
			const lru: string[] = JSON.parse(localStorage.getItem(LRU_KEY) ?? '[]');
			localStorage.setItem(LRU_KEY, JSON.stringify(lru.filter((id) => !ids.has(id))));
		} catch {
			/* storage blocked or corrupt */
		}
		for (const k of await idb.keys('summaries')) if (typeof k === 'string' && inRoot(k.split('|')[2])) await idb.del('summaries', k);
		this.sessions = this.sessions.filter((s) => !ids.has(s.id));
		for (const id of ids) this.#index.delete(id);

		if (this.roots.length) await this.scan();
		else {
			// Nothing left to read: keep only sessions from folders still waiting for access.
			await idb.set('snapshot', 'last', { sessions: $state.snapshot(this.sessions), at: this.lastSync ?? Date.now() });
			if (!this.sessions.length) {
				await idb.del('snapshot', 'last');
				this.lastSync = null;
				this.live = false;
			}
		}
	}

	async forgetEverything() {
		for (const s of ['roots', 'summaries', 'snapshot', 'messages'] as const) await idb.clear(s);
		try {
			localStorage.removeItem(LRU_KEY);
		} catch {
			/* storage blocked */
		}
		this.roots = [];
		this.pendingRoots = [];
		this.sessions = [];
		this.lastSync = null;
		this.live = false;
		this.#index.clear();
		this.phase = 'idle';
	}

	#running: Promise<void> | null = null;
	#again = false;

	/** Read every folder. A call during a scan (e.g. a folder added meanwhile) runs once more after it, so nothing is missed. */
	scan(): Promise<void> {
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		const run = async () => {
			do {
				this.#again = false;
				await this.#scanOnce();
			} while (this.#again);
		};
		return (this.#running = run().finally(() => (this.#running = null)));
	}

	async #scanOnce() {
		this.phase = 'scanning';
		this.errors = [];
		this.progress = { done: 0, total: 0, label: 'Looking for session files…' };
		try {
			const entries: Entry[] = [];
			const liveTools = new Set<Tool>();
			for (const root of this.roots) {
				try {
					const found = await collect(root);
					entries.push(...found);
					const counts = countFound(found);
					root.tools = TOOL_IDS.filter((t) => counts[t] > 0);
					root.tools.forEach((t) => liveTools.add(t));
					root.lastSync = Date.now();
					// Remember the folder: with its handle where the browser allows it, otherwise just its name and tools.
					await idb.set('roots', root.id, root.handle ? root : { ...root, files: undefined, paths: undefined });
				} catch (e) {
					this.errors.push(`${root.name}: ${(e as Error).message}`);
				}
			}
			this.roots = [...this.roots]; // tools/lastSync changed on the objects
			const previous = this.sessions;
			await this.#build(entries);
			// Folders still waiting for access: keep their sessions from the last sync rather than dropping them.
			const waitingTools = new Set(this.pendingRoots.flatMap((r) => r.tools ?? []));
			const keep = previous.filter((s) => waitingTools.has(s.source) && !liveTools.has(s.source) && !this.#index.has(s.id));
			if (keep.length) this.sessions = [...this.sessions, ...keep];
			this.lastSync = Date.now();
			this.live = true;
			await idb.set('snapshot', 'last', { sessions: $state.snapshot(this.sessions), at: this.lastSync });
		} finally {
			this.phase = 'ready';
		}
	}

	async #build(entries: Entry[]) {
		// Antigravity titles live in a separate summaries database.
		let agIndex: Record<string, AgIndexEntry> = {};
		const agIdx = entries.find((e) => e.kind === 'ag-index');
		if (agIdx) {
			const wal = entries.find((e) => e.kind === 'ag-index-wal' && e.path === agIdx.path + '-wal');
			agIndex = await this.pool.run<Record<string, AgIndexEntry>>({ op: 'ag-index', db: agIdx.file, wal: wal?.file ?? null }).catch(() => ({}));
		}

		const units = toUnits(entries, agIndex);
		const dbs = entries.filter((e) => e.kind === 'oc-db');
		this.progress = { done: 0, total: units.length + dbs.length, label: 'Reading sessions…' };

		const summaries = new Map<string, Summary>();
		const queue = [...units].sort((a, b) => b.unit.files.main.size - a.unit.files.main.size); // big files first
		const worker = async () => {
			for (let u = queue.shift(); u; u = queue.shift()) {
				const key = unitKey(u.unit);
				let s = await idb.get<Summary>('summaries', key);
				if (!s) {
					try {
						s = await this.pool.run<Summary>({ op: 'summarize', unit: u.unit });
						await idb.set('summaries', key, s);
					} catch (err) {
						this.errors.push(`${u.unit.path}: ${(err as Error).message}`);
					}
				}
				if (s) summaries.set(u.id, s);
				this.progress.done++;
			}
		};
		await Promise.all(Array.from({ length: this.pool.size * 2 }, worker));

		const names: Record<string, string> = {};
		for (const e of entries.filter((x) => x.kind === 'codex-index')) Object.assign(names, codexThreadNames(await e.file.text()));

		const index = new Map<string, Located>();
		for (const u of units) {
			const s = summaries.get(u.id);
			if (!s || u.parent) continue;
			const prev = index.get(u.id);
			if (prev?.unit && prev.unit.files.main.lastModified >= u.unit.files.main.lastModified) continue; // picked twice
			const sid = u.id.slice(u.id.indexOf(':') + 1);
			const title = u.unit.tool === 'codex' && names[sid] ? names[sid] : s.title;
			index.set(u.id, {
				unit: u.unit,
				subs: new Map(),
				session: { ...s, title, id: u.id, source: u.unit.tool, path: u.unit.path, size: u.unit.files.main.size, parent: null, subagents: [], subagent_tokens: emptyTokens() }
			});
		}
		for (const u of units) {
			const s = summaries.get(u.id);
			const p = u.parent && index.get(u.parent);
			if (!s || !p || p.subs.has(u.id)) continue;
			p.subs.set(u.id, u.unit);
			p.session.subagents.push({ id: u.id, title: s.title, tokens: s.tokens, models: s.models, estimated: s.estimated, stats: s.stats });
			addTokens(p.session.subagent_tokens, s.tokens);
		}

		// OpenCode: newest db wins if several were picked.
		const db = dbs.sort((a, b) => b.file.lastModified - a.file.lastModified)[0];
		if (db) {
			const wal = entries.find((x) => x.kind === 'oc-wal' && x.path === db.path + '-wal');
			try {
				this.progress.label = 'Opening OpenCode database…';
				const list = await this.pool.run<Session[]>({ op: 'opencode-load', db: db.file, wal: wal?.file ?? null, path: db.path }, this.#ocSlot);
				for (const s of list) index.set(s.id, { session: s, subs: new Map() });
				for (const s of list) {
					const p = s.parent && index.get(s.parent);
					if (!p) continue;
					p.session.subagents.push({ id: s.id, title: s.title, tokens: s.tokens, models: s.models, stats: s.stats });
					addTokens(p.session.subagent_tokens, s.tokens);
				}
			} catch (err) {
				this.errors.push(`${db.path}: ${(err as Error).message}`);
			}
			this.progress.done++;
		}

		this.#index = index;
		this.sessions = [...index.values()].map((l) => l.session);
	}

	session(id: string): Session | undefined {
		const l = this.#index.get(id);
		if (l) return l.session;
		const fromList = this.sessions.find((s) => s.id === id); // e.g. shown from the last sync
		if (fromList) return fromList;
		for (const p of [...this.#index.values(), ...this.sessions.map((session) => ({ session, subs: new Map<string, Unit>() }))]) {
			const sub = p.session.subagents.find((s) => s.id === id);
			if (sub && /^(claude|cursor)-sub:/.test(id))
				return {
					...p.session,
					...sub,
					title: 'Subagent · ' + sub.title,
					parent: p.session.id,
					subagents: [],
					subagent_tokens: emptyTokens(),
					path: p.subs.get(id)?.path ?? p.session.path,
					turns: 0,
					messages: 0,
					cost: null
				};
		}
		return undefined;
	}

	/** A conversation: read from the folders when this visit has access, else from the recent-conversations cache. */
	async messages(id: string): Promise<Msg[]> {
		try {
			const msgs = await this.#readMessages(id);
			void this.#remember(id, msgs);
			return msgs;
		} catch (e) {
			const cached = await idb.get<Msg[]>('messages', id);
			if (cached) return cached;
			if (e instanceof NeedsSync) throw e;
			throw this.live ? e : new NeedsSync();
		}
	}

	async #remember(id: string, msgs: Msg[]) {
		let lru: string[] = [];
		try {
			lru = JSON.parse(localStorage.getItem(LRU_KEY) ?? '[]');
		} catch {
			/* storage blocked or corrupt */
		}
		lru = [id, ...lru.filter((x) => x !== id)];
		for (const old of lru.splice(RECENT_LIMIT)) await idb.del('messages', old);
		await idb.set('messages', id, msgs);
		try {
			localStorage.setItem(LRU_KEY, JSON.stringify(lru));
		} catch {
			/* storage blocked */
		}
	}

	async #readMessages(id: string): Promise<Msg[]> {
		if (id.startsWith('opencode:')) {
			if (!this.live || !this.sessions.some((s) => s.id === id && this.#index.has(id))) throw new NeedsSync();
			return this.pool.run<Msg[]>({ op: 'opencode-messages', sid: id.slice(9) }, this.#ocSlot);
		}
		if (/^(claude|cursor)-sub:/.test(id)) {
			for (const p of this.#index.values()) {
				const u = p.subs.get(id);
				if (u) return this.pool.run<Msg[]>({ op: 'messages', unit: u });
			}
			throw new NeedsSync();
		}
		const u = this.#index.get(id)?.unit;
		if (!u) throw new NeedsSync();
		return this.pool.run<Msg[]>({ op: 'messages', unit: u });
	}

	async search(q: string): Promise<SearchHit[]> {
		const units = [...this.#index.values()].filter((l) => l.unit).map((l) => ({ id: l.session.id, unit: l.unit! }));
		const n = this.pool.size;
		const chunks = Array.from({ length: n }, (_, i) => units.filter((_, j) => j % n === i));
		const results = await Promise.all([
			...chunks.map((c, i) => this.pool.run<SearchHit[]>({ op: 'search', q, units: c }, i)),
			this.pool.run<SearchHit[]>({ op: 'opencode-search', q }, this.#ocSlot)
		]);
		return results.flat();
	}
}

export const app = new App();
