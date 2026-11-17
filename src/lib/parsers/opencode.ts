import type { Database, SqlValue } from 'sql.js';
import type { Msg, Session, Tokens } from '../types';
import { emptyTokens } from '../types';
import { clip, oneLine, snippetAround } from './common';

type Row = Record<string, SqlValue>;

function rows(db: Database, sql: string, params: SqlValue[] = []): Row[] {
	const st = db.prepare(sql);
	try {
		st.bind(params);
		const out: Row[] = [];
		while (st.step()) out.push(st.getAsObject());
		return out;
	} finally {
		st.free();
	}
}

const n = (v: SqlValue) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** One Session per OpenCode session row; child sessions (subagents) keep `parent`. */
export function opencodeSessions(db: Database, path: string): Session[] {
	const firsts = new Map<string, string>();
	for (const r of rows(
		db,
		`select p.session_id sid, json_extract(p.data,'$.text') t from part p
		 join message m on m.id = p.message_id
		 where json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text'
		 order by p.time_created desc`
	))
		firsts.set(String(r.sid), String(r.t ?? ''));

	const counts = new Map<string, [number, number]>();
	for (const r of rows(
		db,
		`select session_id sid, count(*) c, sum(json_extract(data,'$.role')='user') u from message group by session_id`
	))
		counts.set(String(r.sid), [n(r.c), n(r.u)]);

	const models = new Map<string, Record<string, Tokens>>();
	for (const r of rows(
		db,
		`select session_id sid, json_extract(data,'$.providerID')||'/'||json_extract(data,'$.modelID') m,
		        sum(json_extract(data,'$.tokens.input')) i, sum(json_extract(data,'$.tokens.output')) o,
		        sum(json_extract(data,'$.tokens.cache.read')) cr, sum(json_extract(data,'$.tokens.cache.write')) cw,
		        sum(json_extract(data,'$.tokens.reasoning')) rs
		 from message where json_extract(data,'$.role')='assistant' group by 1,2`
	)) {
		const rec = models.get(String(r.sid)) ?? {};
		rec[String(r.m)] = { input: n(r.i), output: n(r.o), cache_read: n(r.cr), cache_write: n(r.cw), reasoning: n(r.rs) };
		models.set(String(r.sid), rec);
	}

	return rows(db, 'select * from session').map((r) => {
		const id = String(r.id);
		const [msgs, turns] = counts.get(id) ?? [0, 0];
		return {
			id: 'opencode:' + id,
			source: 'opencode',
			path,
			size: null,
			parent: r.parent_id ? 'opencode:' + r.parent_id : null,
			subagents: [],
			subagent_tokens: emptyTokens(),
			title: String(r.title || '(untitled)'),
			first_prompt: oneLine(firsts.get(id), 400),
			cwd: (r.directory as string) ?? null,
			branch: null,
			start: n(r.time_created) || null,
			end: n(r.time_updated) || null,
			tokens: {
				input: n(r.tokens_input),
				output: n(r.tokens_output),
				cache_read: n(r.tokens_cache_read),
				cache_write: n(r.tokens_cache_write),
				reasoning: n(r.tokens_reasoning)
			},
			models: models.get(id) ?? {},
			cost: r.cost == null ? null : n(r.cost),
			turns,
			messages: msgs,
			client: (r.agent as string) ?? null,
			archived: !!r.time_archived
		} satisfies Session;
	});
}

export function opencodeMessages(db: Database, sid: string): Msg[] {
	const parts = new Map<string, any[]>();
	for (const r of rows(db, 'select message_id, data from part where session_id=? order by time_created, id', [sid])) {
		const list = parts.get(String(r.message_id)) ?? [];
		list.push(JSON.parse(String(r.data)));
		parts.set(String(r.message_id), list);
	}
	const out: Msg[] = [];
	for (const r of rows(db, 'select id, data, time_created from message where session_id=? order by time_created, id', [sid])) {
		const m = JSON.parse(String(r.data));
		const role = m.role === 'user' ? 'user' : 'assistant';
		const model = m.modelID ?? null;
		for (const p of parts.get(String(r.id)) ?? []) {
			const time = p.time?.start ?? n(r.time_created);
			if (p.type === 'text') out.push({ role, kind: p.synthetic ? 'meta' : 'text', text: p.text ?? '', time, model });
			else if (p.type === 'reasoning' && p.text) out.push({ role, kind: 'thinking', text: p.text, time, model });
			else if (p.type === 'tool') {
				const st = p.state ?? {};
				out.push({ role: 'assistant', kind: 'tool_call', name: p.tool, id: p.callID, text: clip(st.input), time });
				if (st.output != null || st.error)
					out.push({ role: 'tool', kind: 'tool_result', id: p.callID, error: st.status === 'error', text: clip(st.output ?? st.error), time });
			} else if (p.type === 'file') {
				const url: string = p.url ?? '';
				if ((p.mime ?? '').startsWith('image/') && url.startsWith('data:'))
					out.push({ role, kind: 'image', image: url, time });
				else out.push({ role, kind: 'meta', text: `[file] ${p.filename} (${p.mime})`, time });
			} else if (p.type === 'patch')
				out.push({ role: 'system', kind: 'meta', text: 'Patched: ' + (p.files ?? []).join(', '), time });
			else if (p.type === 'compaction') out.push({ role: 'system', kind: 'meta', text: '[context compacted]', time });
		}
		if (role === 'assistant' && m.tokens) {
			const tk = m.tokens;
			for (let i = out.length - 1; i >= 0; i--) {
				if (out[i].role === 'assistant') {
					out[i].usage = {
						input: tk.input ?? 0,
						output: tk.output ?? 0,
						reasoning: tk.reasoning ?? 0,
						cache_read: tk.cache?.read ?? 0,
						cache_write: tk.cache?.write ?? 0
					};
					break;
				}
			}
		}
	}
	return out;
}

export function opencodeSearch(db: Database, q: string) {
	const ql = q.toLowerCase();
	return rows(db, `select session_id sid, data from part where data like ? group by session_id`, [`%${q}%`]).map((r) => {
		const d = String(r.data);
		return { id: 'opencode:' + r.sid, snippet: snippetAround(d, d.toLowerCase().indexOf(ql)) };
	});
}
