// Exports are built in the browser and saved as a download. Nothing is sent anywhere (Send to Worklog lives in worklog.ts).
import { findUsernames, redactMessages, redactSession } from './redact';
import { TOOLS, totalTokens, type Msg, type Session } from './types';

export type ExportMode = 'normal' | 'training';
export type NormalFormat = 'markdown' | 'json';

export interface ExportOptions {
	mode: ExportMode;
	format: NormalFormat; // normal mode only
	redact: boolean; // always on for training
	includeThinking: boolean;
	includeTools: boolean;
	/** training: cap on each tool result, in characters */
	maxToolChars: number;
}

export const defaultOptions: ExportOptions = {
	mode: 'normal',
	format: 'markdown',
	redact: true,
	includeThinking: false,
	includeTools: true,
	maxToolChars: 4000
};

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

function prepare(s: Session, msgs: Msg[], o: ExportOptions) {
	const redact = o.mode === 'training' || o.redact;
	let list = msgs;
	let session = s;
	if (redact) {
		const users = findUsernames([s.cwd, s.path, ...msgs.map((m) => m.text)]);
		session = redactSession(s, users);
		list = redactMessages(msgs, [s.cwd, s.path]).msgs;
	}
	list = list.filter(
		(m) =>
			(o.includeThinking || m.kind !== 'thinking') &&
			(o.includeTools || (m.kind !== 'tool_call' && m.kind !== 'tool_result')) &&
			(o.mode === 'normal' || m.kind !== 'meta')
	);
	return { session, msgs: list };
}

// ---------------------------------------------------------------- normal: JSON
export function toJson(s: Session, msgs: Msg[], o: ExportOptions) {
	const { session, msgs: list } = prepare(s, msgs, o);
	return {
		tool: TOOLS[s.source],
		id: s.id,
		title: session.title,
		cwd: session.cwd,
		branch: s.branch,
		started_at: iso(s.start),
		ended_at: iso(s.end),
		models: Object.keys(s.models ?? {}),
		tokens: { ...s.tokens, total: totalTokens(s.tokens) },
		cost_usd: s.cost,
		redacted: o.redact,
		messages: list.map((m) => ({
			role: m.role,
			kind: m.kind,
			...(m.name ? { name: m.name } : {}),
			...(m.id ? { id: m.id } : {}),
			...(m.error ? { error: true } : {}),
			text: m.text ?? null,
			time: iso(m.time),
			...(m.model ? { model: m.model } : {}),
			...(m.usage ? { usage: m.usage } : {})
		}))
	};
}

// ------------------------------------------------------------ normal: Markdown
const fence = (t: string, lang = '') => {
	const ticks = '`'.repeat(Math.max(3, ...[...(t.matchAll(/`+/g) ?? [])].map((m) => m[0].length + 1)));
	return `${ticks}${lang}\n${t}\n${ticks}`;
};

export function toMarkdown(s: Session, msgs: Msg[], o: ExportOptions): string {
	const { session, msgs: list } = prepare(s, msgs, o);
	const out: string[] = [`# ${session.title}`, ''];
	const meta = [
		`- **Tool:** ${TOOLS[s.source]}`,
		session.cwd && `- **Folder:** \`${session.cwd}\``,
		s.start && `- **When:** ${new Date(s.start).toLocaleString()} – ${s.end ? new Date(s.end).toLocaleString() : ''}`,
		Object.keys(s.models ?? {}).length && `- **Models:** ${Object.keys(s.models).join(', ')}`,
		totalTokens(s.tokens) && `- **Tokens:** ${totalTokens(s.tokens).toLocaleString()} (in ${s.tokens.input.toLocaleString()}, out ${s.tokens.output.toLocaleString()}, cache read ${s.tokens.cache_read.toLocaleString()})`,
		o.redact && `- Sensitive info removed`
	].filter(Boolean);
	out.push(...(meta as string[]), '');
	const names = new Map(list.filter((m) => m.kind === 'tool_call' && m.id).map((m) => [m.id!, m.name]));
	for (const m of list) {
		if (m.kind === 'text') out.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '', m.text ?? '', '');
		else if (m.kind === 'thinking') out.push('<details><summary>Thinking</summary>', '', m.text ?? '', '', '</details>', '');
		else if (m.kind === 'tool_call') out.push(`<details><summary>Tool call: <code>${m.name}</code></summary>`, '', fence(m.text ?? '', 'json'), '', '</details>', '');
		else if (m.kind === 'tool_result')
			out.push(`<details><summary>Result${m.id && names.get(m.id) ? ` of <code>${names.get(m.id)}</code>` : ''}${m.error ? ' (error)' : ''}</summary>`, '', fence(m.text ?? ''), '', '</details>', '');
		else if (m.kind === 'meta') out.push(`<details><summary>${m.role} context</summary>`, '', fence(m.text ?? ''), '', '</details>', '');
		else if (m.kind === 'image') out.push('*[image]*', '');
	}
	return out.join('\n');
}

// ------------------------------------------------------------- training JSONL
// One JSON object per conversation in the widely used chat fine-tuning shape:
// {"messages":[{role:"user"},{role:"assistant", tool_calls:[...]},{role:"tool", tool_call_id}...]}

interface TrainMsg {
	role: 'user' | 'assistant' | 'tool';
	content: string | null;
	reasoning?: string;
	tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

const argString = (text: string | undefined) => {
	const t = (text ?? '').trim();
	try {
		return JSON.stringify(JSON.parse(t));
	} catch {
		return JSON.stringify({ input: t });
	}
};

export function toTraining(s: Session, msgs: Msg[], o: ExportOptions): object | null {
	const { session, msgs: list } = prepare(s, msgs, { ...o, mode: 'training' });
	const resultIds = new Set(list.filter((m) => m.kind === 'tool_result' && m.id).map((m) => m.id!));
	const callIds = new Set<string>();
	const out: TrainMsg[] = [];
	const last = () => out[out.length - 1];
	const assistant = (): TrainMsg => {
		const l = last();
		if (l?.role === 'assistant' && !l.tool_calls?.length) return l;
		const m: TrainMsg = { role: 'assistant', content: null };
		out.push(m);
		return m;
	};

	for (const m of list) {
		if (m.kind === 'text' && m.role === 'user') {
			const l = last();
			if (l?.role === 'user') l.content = `${l.content}\n\n${m.text}`;
			else out.push({ role: 'user', content: m.text ?? '' });
		} else if (m.kind === 'text' && m.role === 'assistant') {
			const a = assistant();
			a.content = a.content ? `${a.content}\n\n${m.text}` : (m.text ?? '');
		} else if (m.kind === 'thinking' && o.includeThinking) {
			const a = assistant();
			a.reasoning = a.reasoning ? `${a.reasoning}\n\n${m.text}` : m.text;
		} else if (m.kind === 'tool_call' && m.id && resultIds.has(m.id)) {
			// Only calls with a recorded result: a call without its output teaches nothing useful.
			const l = last();
			const a = l?.role === 'assistant' ? l : (out.push({ role: 'assistant', content: null }), last());
			(a.tool_calls ??= []).push({ id: m.id, type: 'function', function: { name: m.name ?? 'tool', arguments: argString(m.text) } });
			callIds.add(m.id);
		} else if (m.kind === 'tool_result' && m.id && callIds.has(m.id)) {
			const t = m.text ?? '';
			out.push({ role: 'tool', tool_call_id: m.id, content: t.length > o.maxToolChars ? t.slice(0, o.maxToolChars) + '\n…[truncated]' : t });
		}
	}

	// Trim to a clean shape: starts with a user turn, ends with an assistant turn that isn't mid-tool-call.
	while (out.length && out[0].role !== 'user') out.shift();
	while (out.length && (out[out.length - 1].role !== 'assistant' || out[out.length - 1].tool_calls?.length)) out.pop();
	if (!out.some((m) => m.role === 'assistant')) return null;

	return {
		messages: out,
		metadata: { source: TOOLS[s.source], models: Object.keys(s.models ?? {}), title: session.title }
	};
}

// --------------------------------------------------------------- file output
export function fileName(base: string, ext: string) {
	const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session';
	return `${slug}.${ext}`;
}

export function download(name: string, content: string, type: string) {
	const url = URL.createObjectURL(new Blob([content], { type }));
	const a = Object.assign(document.createElement('a'), { href: url, download: name });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Build the export for one or many sessions. `load` fetches a session's messages. */
export async function buildExport(
	sessions: Session[],
	load: (id: string) => Promise<Msg[]>,
	o: ExportOptions,
	onProgress?: (done: number, total: number) => void
): Promise<{ name: string; content: string; type: string; count: number; skipped: number }> {
	const single = sessions.length === 1;
	const base = single ? sessions[0].title : `sessions-${new Date().toISOString().slice(0, 10)}`;
	const parts: string[] = [];
	const json: object[] = [];
	let skipped = 0;
	for (const [i, s] of sessions.entries()) {
		try {
			const msgs = await load(s.id);
			if (o.mode === 'training') {
				const t = toTraining(s, msgs, o);
				if (t) parts.push(JSON.stringify(t));
				else skipped++;
			} else if (o.format === 'json') json.push(toJson(s, msgs, o));
			else parts.push(toMarkdown(s, msgs, o));
		} catch {
			skipped++;
		}
		onProgress?.(i + 1, sessions.length);
	}
	if (o.mode === 'training') return { name: fileName(base, 'jsonl'), content: parts.join('\n') + (parts.length ? '\n' : ''), type: 'application/jsonl', count: parts.length, skipped };
	if (o.format === 'json')
		return { name: fileName(base, 'json'), content: JSON.stringify(single ? json[0] : json, null, 2), type: 'application/json', count: json.length, skipped };
	return { name: fileName(base, 'md'), content: parts.join('\n\n---\n\n'), type: 'text/markdown', count: parts.length, skipped };
}
