import { emptyTokens, type Msg, type Summary, type Tokens } from '../types';
import { clip, isMetaPrompt, lines, ms, oneLine, stripTagBlocks, tryJson } from './common';

function contentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const out: string[] = [];
	for (const c of content) {
		if (!c || typeof c !== 'object') continue;
		if (['input_text', 'output_text', 'text'].includes(c.type)) out.push(c.text ?? '');
		else if (['input_image', 'image'].includes(c.type)) out.push('[image]');
	}
	return out.join('\n');
}

function totalsToTokens(t: any): Tokens {
	const cached = t.cached_input_tokens ?? 0;
	return {
		input: Math.max((t.input_tokens ?? 0) - cached, 0),
		output: t.output_tokens ?? 0,
		cache_read: cached,
		cache_write: t.cache_write_input_tokens ?? 0,
		reasoning: t.reasoning_output_tokens ?? 0
	};
}

export function codexSummary(text: string, path = ''): Summary {
	let meta: any = {};
	let model: string | null = null;
	let first: string | null = null;
	let title: string | null = null;
	let start: number | null = null;
	let end: number | null = null;
	let total: any = null;
	let nUser = 0;
	let nMsgs = 0;

	for (const line of lines(text)) {
		const o = tryJson(line);
		if (!o) continue;
		const ts = ms(o.timestamp);
		if (ts) {
			start = start == null ? ts : Math.min(start, ts);
			end = end == null ? ts : Math.max(end, ts);
		}
		const p = o.payload ?? {};
		if (o.type === 'session_meta') meta = p;
		else if (o.type === 'turn_context') model = p.model ?? model;
		else if (o.type === 'event_msg' && p.type === 'token_count') {
			if (p.info?.total_token_usage) total = p.info.total_token_usage;
		} else if (o.type === 'event_msg' && p.type === 'thread_name_updated') title = p.thread_name ?? title;
		else if (o.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
			const t = contentText(p.content);
			if (p.role === 'user') {
				if (isMetaPrompt(t)) continue;
				nUser++;
				first ??= stripTagBlocks(t);
			}
			nMsgs++;
		}
	}
	const tokens = total ? totalsToTokens(total) : emptyTokens();
	return {
		title: title || oneLine(first) || '(no prompt)',
		first_prompt: oneLine(first, 400),
		cwd: meta.cwd ?? null,
		branch: meta.git?.branch ?? null,
		start,
		end,
		tokens,
		models: model ? { [model]: { ...tokens } } : {},
		cost: null,
		turns: nUser,
		messages: nMsgs,
		client: meta.originator ?? null,
		archived: path.endsWith('.zst') || path.includes('archived_sessions')
	};
}

const CALLS = ['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call'];
const OUTPUTS = ['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_output'];

export function codexMessages(text: string): Msg[] {
	const out: Msg[] = [];
	for (const line of lines(text)) {
		const o = tryJson(line);
		if (!o) continue;
		const time = ms(o.timestamp);
		const p = o.payload ?? {};
		if (o.type === 'turn_context' && p.model) {
			out.push({ role: 'system', kind: 'meta', text: `Turn context · model ${p.model} · cwd ${p.cwd}`, time });
			continue;
		}
		if (o.type === 'event_msg' && p.type === 'token_count') {
			const last = p.info?.last_token_usage;
			if (last) {
				for (let i = out.length - 1; i >= 0; i--) {
					if (out[i].role === 'assistant') {
						const t = totalsToTokens(last);
						out[i].usage = { input: t.input, output: t.output, cache_read: t.cache_read, reasoning: t.reasoning };
						break;
					}
				}
			}
			continue;
		}
		if (o.type !== 'response_item') continue;
		if (p.type === 'message') {
			const t = contentText(p.content);
			if (p.role === 'developer') out.push({ role: 'system', kind: 'meta', text: t, time });
			else if (p.role === 'user' || p.role === 'assistant')
				out.push({ role: p.role, kind: p.role === 'user' && isMetaPrompt(t) ? 'meta' : 'text', text: t, time });
		} else if (p.type === 'reasoning') {
			const s = (p.summary ?? [])
				.map((x: any) => x?.text ?? '')
				.join('\n\n')
				.trim();
			if (s) out.push({ role: 'assistant', kind: 'thinking', text: s, time });
		} else if (CALLS.includes(p.type)) {
			let args = p.arguments ?? p.input ?? p.action;
			if (typeof args === 'string') {
				try {
					args = JSON.parse(args);
				} catch {
					/* keep as string */
				}
			}
			out.push({ role: 'assistant', kind: 'tool_call', name: p.name ?? p.type, id: p.call_id, text: clip(args), time });
		} else if (OUTPUTS.includes(p.type)) {
			let res = p.output;
			if (Array.isArray(res)) res = contentText(res);
			else if (res && typeof res === 'object') res = res.content ?? res;
			out.push({ role: 'tool', kind: 'tool_result', text: clip(res), id: p.call_id, time });
		}
	}
	return out;
}

/** ~/.codex/session_index.jsonl -> { sessionId: threadName } */
export function codexThreadNames(text: string): Record<string, string> {
	const names: Record<string, string> = {};
	for (const line of lines(text)) {
		const o = tryJson(line);
		if (o?.id && o.thread_name) names[o.id] = o.thread_name;
	}
	return names;
}

/** rollout-2026-11-06T03-06-40-<uuid>.jsonl[.zst] -> uuid */
export const codexIdFromName = (name: string) => name.split('.')[0].slice(-36);
