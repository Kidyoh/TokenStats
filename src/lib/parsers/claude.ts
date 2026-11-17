import { addTokens, emptyTokens, type Msg, type Summary, type Tokens } from '../types';
import { clip, isMetaPrompt, lines, ms, oneLine, stripTagBlocks, tryJson } from './common';

// Record types that are large and never needed for summaries or reading.
const SKIP = [
	'"type":"api-request',
	'"type":"file-history',
	'"type":"attachment"',
	'"type":"queue-operation'
];
const skip = (line: string) => {
	const head = line.slice(0, 120);
	return SKIP.some((s) => head.includes(s));
};

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((c) => c && c.type === 'text')
		.map((c) => c.text ?? '')
		.join('\n');
}

const usageTokens = (u: any): Partial<Tokens> => ({
	input: u.input_tokens ?? 0,
	output: u.output_tokens ?? 0,
	cache_read: u.cache_read_input_tokens ?? 0,
	cache_write: u.cache_creation_input_tokens ?? 0
});

export function claudeSummary(text: string): Summary {
	let custom: string | null = null;
	let first: string | null = null;
	let cwd: string | null = null;
	let branch: string | null = null;
	let entrypoint: string | null = null;
	let start: number | null = null;
	let end: number | null = null;
	let cost: number | null = null;
	let nUser = 0;
	let nAsst = 0;
	// Streaming writes one line per content block with the same message id; keep one usage per id.
	const usageById = new Map<string, [string, any]>();

	for (const line of lines(text)) {
		if (skip(line)) continue;
		const o = tryJson(line);
		if (!o) continue;
		const ts = ms(o.timestamp);
		if (ts) {
			start = start == null ? ts : Math.min(start, ts);
			end = end == null ? ts : Math.max(end, ts);
		}
		switch (o.type) {
			case 'custom-title':
				custom = o.customTitle ?? custom;
				break;
			case 'cost-state':
				cost = typeof o.totalCostUSD === 'number' ? o.totalCostUSD : cost;
				break;
			case 'user': {
				cwd ??= o.cwd ?? null;
				branch ??= o.gitBranch ?? null;
				entrypoint ??= o.entrypoint ?? null;
				const c = o.message?.content;
				if (Array.isArray(c) && c.length && c.every((x: any) => x?.type === 'tool_result')) break;
				const t = textOf(c);
				if (t && !isMetaPrompt(t) && !o.isMeta) {
					nUser++;
					first ??= stripTagBlocks(t);
				}
				break;
			}
			case 'assistant': {
				const m = o.message ?? {};
				if (m.model && m.model !== '<synthetic>' && m.usage) usageById.set(m.id ?? o.uuid, [m.model, m.usage]);
				nAsst++;
				break;
			}
		}
	}

	const tokens = emptyTokens();
	const models: Record<string, Tokens> = {};
	for (const [model, u] of usageById.values()) {
		const d = usageTokens(u);
		addTokens(tokens, d);
		addTokens((models[model] ??= emptyTokens()), d);
	}
	return {
		title: custom || oneLine(first) || '(no prompt)',
		first_prompt: oneLine(first, 400),
		cwd,
		branch,
		start,
		end,
		tokens,
		models,
		cost,
		turns: nUser,
		messages: nUser + nAsst,
		client: entrypoint
	};
}

export function claudeMessages(text: string): Msg[] {
	const out: Msg[] = [];
	for (const line of lines(text)) {
		if (skip(line)) continue;
		const o = tryJson(line);
		if (!o) continue;
		const time = ms(o.timestamp);
		if (o.type === 'user') {
			let c = o.message?.content;
			if (typeof c === 'string') c = [{ type: 'text', text: c }];
			for (const b of c ?? []) {
				if (!b || typeof b !== 'object') continue;
				if (b.type === 'text') {
					const t = b.text ?? '';
					out.push({ role: 'user', kind: isMetaPrompt(t) || o.isMeta ? 'meta' : 'text', text: t, time });
				} else if (b.type === 'tool_result') {
					let rc = b.content;
					if (Array.isArray(rc))
						rc = rc
							.map((x: any) => (x?.type === 'image' ? '[image]' : (x?.text ?? '')))
							.join('\n');
					out.push({ role: 'tool', kind: 'tool_result', text: clip(rc), id: b.tool_use_id, error: !!b.is_error, time });
				} else if (b.type === 'image') {
					const src = b.source ?? {};
					const image = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : null;
					out.push({ role: 'user', kind: 'image', image, time });
				}
			}
		} else if (o.type === 'assistant') {
			const m = o.message ?? {};
			const model = m.model ?? null;
			let last: Msg | null = null;
			for (const b of m.content ?? []) {
				if (b.type === 'text') last = { role: 'assistant', kind: 'text', text: b.text ?? '', time, model };
				else if (b.type === 'thinking' && b.thinking)
					last = { role: 'assistant', kind: 'thinking', text: b.thinking, time, model };
				else if (b.type === 'tool_use')
					last = { role: 'assistant', kind: 'tool_call', name: b.name, id: b.id, text: clip(b.input), time, model };
				else continue;
				out.push(last);
			}
			if (last && m.usage && model !== '<synthetic>') last.usage = usageTokens(m.usage);
		} else if (o.type === 'system' && o.content) {
			out.push({ role: 'system', kind: 'meta', text: String(o.content), time });
		} else if (o.type === 'summary' && o.summary) {
			out.push({ role: 'system', kind: 'meta', text: 'Summary: ' + o.summary, time });
		}
	}
	return out;
}

/** Lines worth searching (skips raw API request dumps, which repeat the system prompt). */
export const claudeSearchable = (line: string) => !line.slice(0, 120).includes('"type":"api-request');
