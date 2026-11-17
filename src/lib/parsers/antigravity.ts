import type { Database } from 'sql.js';
import { addTokens, emptyTokens, type Msg, type Summary, type Tokens } from '../types';
import { clip, oneLine, tryJson } from './common';
import { Pb } from './protobuf';

// Antigravity: ~/.gemini/antigravity/conversations/<id>.db, one SQLite database per conversation.
// `steps` holds protobuf payloads; field numbers below were mapped by hand (no public schema):
//   step.1 = type, step.5.1.1 = unix seconds
//   type 14  user input       19.2 = text
//   type 15  model response   20.1 = text, 20.3 = thinking, 20.7[] = tool calls {1 id, 2 name, 3 args json}
//   type 132 tool result      140.2.1 = output, 140.2.6.2.5.4 = the call {1 id, 2 name}
//   type 101 notification     114.2.2 = text
//   type 17  error            24.3.2 = text
// `gen_metadata` rows: 1.19 = model, 1.4 = usage {2 input incl. cached, 3 output, 5 cached, 9 thinking}.
// Token numbers are therefore a best-effort reading.

export interface AgIndexEntry {
	title: string;
	cwd: string | null;
	modified: number | null;
}

/** conversation_summaries.db -> { conversationId: {title, cwd, modified} } */
export function antigravityIndex(db: Database): Record<string, AgIndexEntry> {
	const out: Record<string, AgIndexEntry> = {};
	const st = db.prepare('select conversation_id, title, preview, workspace_uris, last_modified_time from conversation_summaries');
	try {
		while (st.step()) {
			const [id, title, preview, uris, modified] = st.get() as string[];
			const first = (tryJson(uris) ?? [])[0] as string | undefined;
			out[id] = {
				title: (title || preview || '').trim(),
				cwd: first ? fileUriToPath(first) : null,
				modified: modified ? Date.parse(modified.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')) || null : null
			};
		}
	} finally {
		st.free();
	}
	return out;
}

export function fileUriToPath(uri: string): string {
	try {
		const p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
		return /^\/[A-Za-z]:/.test(p) ? p.slice(1).replace(/\//g, '\\').replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':') : p;
	} catch {
		return uri;
	}
}

function steps(db: Database): { type: number; pb: Pb | null }[] {
	const out: { type: number; pb: Pb | null }[] = [];
	const st = db.prepare('select step_type, step_payload from steps order by idx');
	try {
		while (st.step()) {
			const [type, payload] = st.get() as [number, Uint8Array | null];
			out.push({ type, pb: Pb.parse(payload) });
		}
	} finally {
		st.free();
	}
	return out;
}

const stepTime = (pb: Pb | null) => {
	const s = pb?.path(5, 1)?.num(1);
	return s ? s * 1000 : null;
};

function usage(db: Database): { tokens: Tokens; models: Record<string, Tokens> } {
	const tokens = emptyTokens();
	const models: Record<string, Tokens> = {};
	let st;
	try {
		st = db.prepare('select data from gen_metadata order by idx');
	} catch {
		return { tokens, models };
	}
	try {
		while (st.step()) {
			const root = Pb.parse(st.get()[0] as Uint8Array)?.msg(1);
			const u = root?.msg(4);
			if (!u) continue;
			const cached = u.num(5) ?? 0;
			const t: Tokens = {
				input: Math.max((u.num(2) ?? 0) - cached, 0),
				output: u.num(3) ?? 0,
				cache_read: cached,
				cache_write: 0,
				reasoning: u.num(9) ?? 0
			};
			addTokens(tokens, t);
			const model = root?.str(19) || 'unknown';
			addTokens((models[model] ??= emptyTokens()), t);
		}
	} finally {
		st.free();
	}
	return { tokens, models };
}

export function antigravitySummary(db: Database, meta: AgIndexEntry | undefined): Summary {
	let first: string | null = null;
	let start: number | null = null;
	let end: number | null = null;
	let turns = 0;
	let messages = 0;
	for (const { type, pb } of steps(db)) {
		const t = stepTime(pb);
		if (t) {
			start = start == null ? t : Math.min(start, t);
			end = end == null ? t : Math.max(end, t);
		}
		if (type === 14) {
			const text = pb?.msg(19)?.str(2);
			if (text?.trim()) {
				turns++;
				first ??= text;
			}
			messages++;
		} else if (type === 15 && pb?.msg(20)?.str(1)) messages++;
	}
	const { tokens, models } = usage(db);
	return {
		title: meta?.title || oneLine(first) || '(no prompt)',
		first_prompt: oneLine(first, 400),
		cwd: meta?.cwd ?? null,
		branch: null,
		start,
		end: Math.max(end ?? 0, meta?.modified ?? 0) || null,
		tokens,
		models,
		cost: null,
		turns,
		messages,
		client: null
	};
}

export function antigravityMessages(db: Database): Msg[] {
	const out: Msg[] = [];
	for (const { type, pb } of steps(db)) {
		if (!pb) continue;
		const time = stepTime(pb);
		if (type === 14) {
			const text = pb.msg(19)?.str(2);
			if (text) out.push({ role: 'user', kind: 'text', text, time });
		} else if (type === 15) {
			const r = pb.msg(20);
			if (!r) continue;
			const thinking = r.str(3);
			if (thinking?.trim()) out.push({ role: 'assistant', kind: 'thinking', text: thinking, time });
			const text = r.str(1);
			if (text?.trim()) out.push({ role: 'assistant', kind: 'text', text, time });
			for (const c of r.msgs(7)) {
				const args = c.str(3) ?? '';
				out.push({ role: 'assistant', kind: 'tool_call', id: c.str(1) ?? undefined, name: c.str(2) ?? 'tool', text: clip(tryJson(args) ?? args), time });
			}
		} else if (type === 132) {
			const r = pb.path(140, 2);
			const call = r?.path(6, 2, 5, 4);
			out.push({ role: 'tool', kind: 'tool_result', id: call?.str(1) ?? undefined, text: clip(r?.str(1) ?? ''), time });
		} else if (type === 101) {
			const n = pb.msg(114);
			const text = n?.msg(2)?.str(2) ?? n?.str(1);
			if (text) out.push({ role: 'system', kind: 'meta', text, time });
		} else if (type === 17) {
			const text = pb.path(24, 3)?.str(2);
			if (text) out.push({ role: 'system', kind: 'meta', text: 'Error: ' + text, time });
		}
	}
	return out;
}
