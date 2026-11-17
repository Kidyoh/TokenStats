import { emptyTokens, type Msg, type Summary, type Tokens } from '../types';
import { clip, isMetaPrompt, lines, ms, oneLine, stripTagBlocks, tryJson } from './common';

// Grok Build: ~/.grok/sessions/<url-encoded cwd>/<session id>/
//   summary.json        title, cwd, model, timestamps
//   chat_history.jsonl  the conversation (system/user/assistant/reasoning/tool_result)
//   usage.json          token totals (newer versions only)

function contentText(c: unknown): string {
	if (typeof c === 'string') return c;
	if (!Array.isArray(c)) return '';
	return c
		.map((x: any) => (x?.type === 'text' ? (x.text ?? '') : x?.type === 'image' || x?.type === 'image_url' ? '[image]' : ''))
		.join('\n');
}

const usageToTokens = (u: any): Tokens => ({
	input: Math.max((u?.inputTokens ?? 0) - (u?.cachedReadTokens ?? 0), 0),
	output: u?.outputTokens ?? 0,
	cache_read: u?.cachedReadTokens ?? 0,
	cache_write: u?.cacheCreationTokens ?? 0,
	reasoning: u?.reasoningTokens ?? 0
});

/** xAI reports cost in "USD ticks"; 1 USD = 1e10 ticks. */
const TICKS_PER_USD = 1e10;

export function grokSummary(summaryText: string | null, chatText: string, usageText: string | null): Summary {
	const s = (summaryText && tryJson(summaryText)) || {};
	const usage = usageText ? tryJson(usageText)?.session : null;
	let first: string | null = null;
	let turns = 0;
	let messages = 0;
	let model: string | null = s.current_model_id ?? null;
	for (const line of lines(chatText)) {
		const o = tryJson(line);
		if (!o) continue;
		if (o.type === 'user') {
			const t = contentText(o.content);
			if (o.synthetic_reason || isMetaPrompt(t)) continue;
			turns++;
			messages++;
			first ??= stripTagBlocks(t);
		} else if (o.type === 'assistant') {
			messages++;
			model ??= o.model_id ?? null;
		}
	}
	const tokens = usage ? usageToTokens(usage) : emptyTokens();
	const models: Record<string, Tokens> = {};
	if (usage?.modelUsage) for (const [m, u] of Object.entries(usage.modelUsage)) models[m] = usageToTokens(u);
	else if (model && usage) models[model] = { ...tokens };
	return {
		title: s.generated_title || s.session_summary || oneLine(first) || '(no prompt)',
		first_prompt: oneLine(first, 400),
		cwd: s.info?.cwd ?? null,
		branch: s.head_branch ?? null,
		start: ms(s.created_at),
		end: ms(s.last_active_at ?? s.updated_at),
		tokens,
		models,
		cost: typeof usage?.costUsdTicks === 'number' ? usage.costUsdTicks / TICKS_PER_USD : null,
		turns,
		messages,
		client: s.session_kind === 'subagent' ? `subagent${s.agent_name ? ' · ' + s.agent_name : ''}` : (s.agent_name ?? null)
	};
}

export function grokMessages(chatText: string): Msg[] {
	const out: Msg[] = [];
	for (const line of lines(chatText)) {
		const o = tryJson(line);
		if (!o) continue;
		switch (o.type) {
			case 'system':
				out.push({ role: 'system', kind: 'meta', text: contentText(o.content), time: null });
				break;
			case 'user': {
				const t = contentText(o.content);
				out.push({ role: 'user', kind: o.synthetic_reason || isMetaPrompt(t) ? 'meta' : 'text', text: t, time: null });
				break;
			}
			case 'reasoning': {
				const s = (o.summary ?? []).map((x: any) => x?.text ?? '').join('\n\n').trim();
				if (s) out.push({ role: 'assistant', kind: 'thinking', text: s, time: null });
				break;
			}
			case 'assistant': {
				const model = o.model_id ?? null;
				const t = contentText(o.content);
				if (t.trim()) out.push({ role: 'assistant', kind: 'text', text: t, time: null, model });
				for (const c of o.tool_calls ?? []) {
					let args = c.arguments;
					if (typeof args === 'string') args = tryJson(args) ?? args;
					out.push({ role: 'assistant', kind: 'tool_call', name: c.name, id: c.id, text: clip(args), time: null, model });
				}
				break;
			}
			case 'tool_result':
				out.push({ role: 'tool', kind: 'tool_result', id: o.tool_call_id, text: clip(contentText(o.content)), time: null });
				break;
		}
	}
	return out;
}
