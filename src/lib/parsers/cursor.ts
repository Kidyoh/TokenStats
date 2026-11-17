import { emptyTokens, type Msg, type Summary } from '../types';
import { clip, lines, oneLine, tryJson } from './common';

// Cursor agent transcripts: ~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl
// Lines are {role, message:{content:[text|tool_use]}} plus {type:"turn_ended"}.
// Cursor doesn't record tool output, token usage or per-message times here.

const QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const STAMP = /<timestamp>([^<]+)<\/timestamp>/;

/** "Tuesday, Oct 13, 2026, 3:02 PM (UTC+3)" -> epoch ms */
export function parseCursorStamp(s: string): number | null {
	const m = /^(?:\w+,\s*)?(.+?),?\s+(\d{1,2}:\d{2}\s*[AP]M)\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)/i.exec(s.trim());
	if (!m) return null;
	const sign = m[3].startsWith('-') ? '-' : '+';
	const hh = String(Math.abs(Number(m[3]))).padStart(2, '0');
	const v = Date.parse(`${m[1]} ${m[2]} GMT${sign}${hh}${m[4] ?? '00'}`);
	return Number.isNaN(v) ? null : v;
}

function userParts(content: any[]): { query: string | null; time: number | null; raw: string } {
	const raw = content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n');
	const q = QUERY.exec(raw);
	const st = STAMP.exec(raw);
	return { query: q ? q[1] : null, time: st ? parseCursorStamp(st[1]) : null, raw };
}

/** "d-Projects-Bots-dbj" + strings seen in the transcript -> "D:\Projects\Bots\dbj" (best effort) */
export function cursorCwd(projectDir: string, text: string): string | null {
	const key = (p: string) => p.replace(/:/g, '').replace(/[\\/]+/g, '-').toLowerCase();
	const want = projectDir.toLowerCase();
	const re = /[A-Za-z]:(?:\\\\|\\|\/)[^"'\s,}]+|\/(?:Users|home)\/[^"'\s,}]+/g;
	for (const m of text.matchAll(re)) {
		const s = m[0].replace(/\\\\/g, '\\');
		for (let end = s.length; end > 2; end--) {
			if (key(s.slice(0, end)) === want) return s.slice(0, end).replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
		}
	}
	return null;
}

/** Fallback when the transcript never mentions its folder: "d-Projects-XIV-xiv" -> "D:\Projects\XIV\xiv".
 *  Folder names containing dashes can't be told apart from separators, so this is a guess. */
export function naiveCwd(projectDir: string): string {
	const m = /^([a-zA-Z])-(.*)$/.exec(projectDir);
	if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/-/g, '\\')}`;
	return '/' + projectDir.replace(/-/g, '/');
}

export function cursorSummary(text: string, path: string, lastModified: number): Summary {
	let first: string | null = null;
	let start: number | null = null;
	let end: number | null = null;
	let turns = 0;
	let messages = 0;
	for (const line of lines(text)) {
		const o = tryJson(line);
		if (!o?.role) continue;
		messages++;
		if (o.role === 'user') {
			const p = userParts(o.message?.content ?? []);
			if (p.time) {
				start = start == null ? p.time : Math.min(start, p.time);
				end = end == null ? p.time : Math.max(end, p.time);
			}
			const q = p.query ?? p.raw;
			if (q.trim()) {
				turns++;
				first ??= q;
			}
		}
	}
	const segs = path.split('/');
	const at = segs.indexOf('agent-transcripts');
	const projectDir = at > 0 ? segs[at - 1] : '';
	return {
		title: oneLine(first) || '(no prompt)',
		first_prompt: oneLine(first, 400),
		cwd: (projectDir && (cursorCwd(projectDir, text) ?? naiveCwd(projectDir))) || null,
		branch: null,
		start: start ?? lastModified,
		end: Math.max(end ?? 0, lastModified) || null,
		tokens: emptyTokens(),
		models: {},
		cost: null,
		turns,
		messages,
		client: segs.includes('subagents') ? 'subagent' : null
	};
}

export function cursorMessages(text: string): Msg[] {
	const out: Msg[] = [];
	let time: number | null = null;
	for (const line of lines(text)) {
		const o = tryJson(line);
		if (!o?.role) continue;
		const content: any[] = Array.isArray(o.message?.content) ? o.message.content : [{ type: 'text', text: String(o.message?.content ?? '') }];
		if (o.role === 'user') {
			const p = userParts(content);
			time = p.time ?? time;
			if (p.query != null) {
				const rest = p.raw.replace(QUERY, '').replace(STAMP, '').trim();
				if (rest) out.push({ role: 'user', kind: 'meta', text: rest, time });
				out.push({ role: 'user', kind: 'text', text: p.query, time });
			} else out.push({ role: 'user', kind: 'text', text: p.raw, time });
			continue;
		}
		const first = out.length;
		for (const c of content) {
			if (c?.type === 'text' && c.text?.trim()) out.push({ role: 'assistant', kind: 'text', text: c.text, time });
			else if (c?.type === 'tool_use') out.push({ role: 'assistant', kind: 'tool_call', name: c.name, id: c.id, text: clip(c.input), time });
			else if (c?.type === 'thinking' && c.thinking) out.push({ role: 'assistant', kind: 'thinking', text: c.thinking, time });
		}
		if (out.length > first) out[first].call = true; // each assistant line is one model response
	}
	return out;
}
