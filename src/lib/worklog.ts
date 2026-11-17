// "Send to Worklog" (https://worklog.pro.et): turns sessions into work-log entries and sends them
// to the user's own Worklog through its MCP endpoint. This is the only part of the site that sends
// anything over the network, and it runs only when the user clicks Send, with a key they pasted in.
//
// Only a short description of each session leaves the device: a title, a 1-3 sentence summary of the
// first prompt, the project folder's name, when it started and roughly how long it took. Never the
// conversation, tool calls, code, file paths, branch names, tokens or cost. Everything is redacted first.
import { findUsernames, redactText, redactTitle } from './redact';
import type { Msg, Session, Tool } from './types';

export const WORKLOG_URL = 'https://worklog.pro.et/api/mcp';

/** Fields of Worklog's `log_work` tool that we fill. */
export interface WorklogEntry {
	title: string;
	summary?: string;
	project?: string;
	category: 'development';
	agent: string;
	tags: string[];
	occurred_at: string;
	duration_minutes?: number;
	/** idempotency key: logging again with the same key updates the entry instead of adding one */
	external_id: string;
}

const AGENT: Record<Tool, string> = {
	claude: 'claude-code',
	codex: 'codex',
	opencode: 'opencode',
	grok: 'grok',
	antigravity: 'antigravity',
	cursor: 'cursor'
};

/** A gap between messages longer than this counts as a break, not work. */
export const IDLE_MS = 30 * 60_000;
/** Ceiling for one session when there are no message times to measure activity from. */
export const MAX_WALL_MS = 4 * 60 * 60_000;

/** Active minutes: the sum of gaps between consecutive message times, skipping breaks.
 *  Falls back to start-to-end (capped) when messages carry no times. */
export function activeMinutes(s: Pick<Session, 'start' | 'end'>, msgs: Pick<Msg, 'time'>[]): number | undefined {
	const times = msgs.map((m) => m.time).filter((t): t is number => typeof t === 'number' && t > 0).sort((a, b) => a - b);
	let ms = 0;
	if (times.length >= 2) {
		for (let i = 1; i < times.length; i++) {
			const gap = times[i] - times[i - 1];
			if (gap <= IDLE_MS) ms += gap;
		}
	} else if (s.start && s.end && s.end > s.start) {
		ms = Math.min(s.end - s.start, MAX_WALL_MS);
	} else return undefined;
	const min = Math.round(ms / 60_000);
	return min >= 1 ? min : undefined;
}

/** Last folder name of a working directory, if it says anything about the project. */
export function projectName(cwd: string | null, users: string[] = []): string | undefined {
	if (!cwd) return undefined;
	const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
	const name = parts[parts.length - 1];
	if (!name || /^[A-Za-z]:$/.test(name)) return undefined;
	const lower = name.toLowerCase();
	// A home folder ("C:\Users\jane") names the person, not a project.
	if (users.some((u) => u.toLowerCase() === lower)) return undefined;
	if (parts.length >= 2 && /^(users|home)$/i.test(parts[parts.length - 2])) return undefined;
	return name.slice(0, 80);
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const PATH_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|(?<![\w.])\/(?=[\w.-]+\/))[^\s"'`()]*/g; // <> allowed: redaction leaves <user> inside paths

/** Plain words only: no code, links or file paths (Worklog asks for none of these). */
const GAP = '\u0000';

/** Plain words only: no code, links or file paths (Worklog asks for none of these).
 *  With `dropDamaged`, sentences that lost pieces and no longer read well are left out
 *  ("My key is and see or for context."). */
export function plainText(text: string, dropDamaged = false): string {
	const marked = text
		.replace(/```[\s\S]*?(?:```|$)/g, ` ${GAP} `)
		.replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/gi, ` ${GAP} `) // injected tags like <system-reminder>…</system-reminder>
		.replace(/`[^`\n]*`/g, ` ${GAP} `)
		.replace(URL_RE, ` ${GAP} `)
		.replace(PATH_RE, ` ${GAP} `)
		.replace(/\[REDACTED [^\]]*\]|\[EMAIL\]|<user>/g, ` ${GAP} `)
		.replace(/[#>*_]+/g, ' ')
		.replace(/\s+/g, ' ');
	const sentences = marked.split(/(?<=[.!?])\s+/).filter((sen) => {
		if (!dropDamaged) return true;
		const gaps = sen.split(GAP).length - 1;
		const words = sen.split(/[\s\0]+/).filter((w) => /\w{2,}/.test(w)).length;
		return !(gaps >= 2 || (gaps && words < 5));
	});
	return sentences
		.join(' ')
		.replaceAll(GAP, ' ')
		.replace(/\s+/g, ' ')
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/(^|[.!?]\s)[,;:]\s*/g, '$1')
		.trim();
}

/** Up to `max` characters, cut at a sentence end when there is one, else at a word. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const sentence = cut.match(/^[\s\S]*[.!?](?=\s|$)/)?.[0];
	if (sentence && sentence.length >= max * 0.5) return sentence;
	return cut.replace(/\s+\S*$/, '') + '…';
}

/** The first sentence, when it is long enough to stand on its own. */
export function firstSentence(text: string): string {
	const m = text.match(/^.{15,}?[.!?](?=\s|$)/);
	return m ? m[0] : text;
}

/** Removing links, paths and secrets can leave a dangling tail ("…five times. Key, see"); drop it. */
export function dropFragment(text: string): string {
	const m = text.match(/^([\s\S]*[.!?])\s+([^.!?]*)$/);
	if (m && m[2].split(/\s+/).filter((w) => /\w{2,}/.test(w)).length < 4) return m[1];
	return text.replace(/[\s,;:–-]+$/, '');
}

/** Build the entry for one session. Messages are used for active time and username detection. */
export function toEntry(s: Session, msgs: Msg[]): WorklogEntry | null {
	if (!s.start) return null;
	const users = findUsernames([s.cwd, s.path, s.first_prompt, ...msgs.slice(0, 50).map((m) => m.text)]);
	const prompt = dropFragment(plainText(redactText(s.first_prompt, users).text, true));
	const rawTitle = dropFragment(plainText(redactTitle(s, users))) || prompt;
	// Most tools title a session with its first prompt; its first sentence makes a better title.
	const title = clip(firstSentence(rawTitle), 120).replace(/(?<!\.)\.$/, '');
	if (!title) return null;

	// The rest of the prompt, without the part already used as the title.
	const head = title.replace(/…$/, '');
	const rest = prompt.startsWith(head) && !title.endsWith('…') ? prompt.slice(head.length).replace(/^[.!?\s]+/, '') : prompt;
	let summary: string | undefined = clip(rest, 300);
	// A prompt that just repeats the title, or says nothing ("fix this"), adds nothing.
	if (summary.length < 25 || head.startsWith(summary.replace(/…$/, ''))) summary = undefined;

	const models = Object.keys(s.models ?? {}).filter((m) => m && m !== '<synthetic>');
	const tags = [AGENT[s.source], ...models.slice(0, 3)];

	const project = projectName(s.cwd, users);
	const minutes = activeMinutes(s, msgs);
	return {
		title,
		...(summary ? { summary } : {}),
		...(project ? { project } : {}),
		category: 'development',
		agent: AGENT[s.source],
		tags: [...new Set(tags)],
		occurred_at: new Date(s.start).toISOString(),
		...(minutes ? { duration_minutes: minutes } : {}),
		external_id: `session-browser:${s.id}`
	};
}

// ------------------------------------------------------------------ client
// Worklog speaks MCP over plain HTTP (JSON-RPC). It allows calls from any website (CORS),
// so the browser can reach it directly. The key goes in a header, never in the URL.

export class WorklogError extends Error {
	constructor(
		message: string,
		readonly status = 0
	) {
		super(message);
	}
}

let nextId = 1;

async function rpc(key: string, method: string, params: object | undefined, session?: string | null, fetcher: typeof fetch = fetch) {
	const res = await fetcher(WORKLOG_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${key}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'Mcp-Protocol-Version': '2025-06-18',
			...(session ? { 'Mcp-Session-Id': session } : {})
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) })
	}).catch(() => {
		throw new WorklogError("Couldn't reach Worklog. Check your connection.");
	});
	if (res.status === 401 || res.status === 403) throw new WorklogError('Worklog rejected this key. Check it, or create a new one in Worklog.', res.status);
	if (!res.ok) throw new WorklogError(`Worklog answered ${res.status}.`, res.status);
	const text = await res.text();
	// Streamable HTTP may answer as server-sent events; the JSON-RPC reply is in a data: line.
	const body = (res.headers.get('content-type') ?? '').includes('text/event-stream')
		? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? '{}'
		: text;
	let json: any;
	try {
		json = JSON.parse(body);
	} catch {
		throw new WorklogError('Worklog sent a reply this page could not read.');
	}
	if (json.error) throw new WorklogError(json.error.message ?? 'Worklog returned an error.');
	return { result: json.result, session: res.headers.get('Mcp-Session-Id') ?? session ?? null };
}

export interface WorklogClient {
	call(tool: string, args: object): Promise<string>;
}

/** Open a session with Worklog. Throws WorklogError if the key doesn't work. */
export async function connect(key: string, fetcher: typeof fetch = fetch): Promise<WorklogClient> {
	key = key.trim();
	if (!/^wl_[A-Za-z0-9_-]{10,}$/.test(key)) throw new WorklogError('That doesn’t look like a Worklog key. Keys start with wl_.');
	const init = await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session-browser', version: '1' } }, null, fetcher);
	const session = init.session;
	return {
		async call(tool, args) {
			const { result } = await rpc(key, 'tools/call', { name: tool, arguments: args }, session, fetcher);
			const text = (result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');
			if (result?.isError) throw new WorklogError(text || `${tool} failed.`);
			return text;
		}
	};
}

// ------------------------------------------------------------ key storage
const KEY = 'sb-worklog-key';
export function savedKey(): string {
	try {
		return localStorage.getItem(KEY) ?? '';
	} catch {
		return '';
	}
}
export function rememberKey(key: string | null) {
	try {
		if (key) localStorage.setItem(KEY, key);
		else localStorage.removeItem(KEY);
	} catch {
		/* storage blocked: the key just isn't remembered */
	}
}
