// Turns raw tool calls from any of the tools into something readable:
// a category (icon), a short label and summary, and structured input for the detail view.
import type { Msg } from './types';

export type ToolCategory = 'shell' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'plan' | 'mcp' | 'other';

export const CATEGORY_ICON: Record<ToolCategory, string> = {
	shell: 'terminal',
	read: 'file',
	edit: 'edit',
	search: 'search',
	web: 'globe',
	agent: 'agent',
	plan: 'list',
	mcp: 'tool',
	other: 'tool'
};

export interface DiffHunk {
	file?: string;
	old: string;
	new: string;
}

export interface ToolInfo {
	category: ToolCategory;
	label: string;
	server?: string;
	summary: string;
	command?: string;
	code?: string;
	diffs: DiffHunk[];
	patch?: string;
	params: [string, string][];
	raw: string;
}

const CMD_KEYS = ['command', 'cmd', 'CommandLine', 'commandLine', 'script'];
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'AbsolutePath', 'TargetFile', 'notebook_path', 'file', 'filename', 'DirectoryPath', 'target_directory', 'SearchDirectory', 'directory', 'dir'];
const QUERY_KEYS = ['pattern', 'Pattern', 'query', 'Query', 'glob_pattern', 'regex', 'search', 'q', 'url', 'Url', 'URL'];
const DESC_KEYS = ['description', 'Description', 'prompt', 'task', 'toolSummary', 'title', 'subject'];

export function categorize(name: string): ToolCategory {
	const n = name.toLowerCase();
	if (n.startsWith('mcp__') || n.startsWith('mcp_')) return 'mcp';
	if (/web|fetch|url|browser|navigate|http|curl/.test(n)) return 'web';
	if (/bash|shell|exec|run_command|command|powershell|terminal|process|^run$/.test(n)) return 'shell';
	if (/todo|plan|manage_task|checklist/.test(n)) return 'plan';
	if (/^task$|agent|subagent|delegate|spawn/.test(n)) return 'agent';
	if (/write|edit|replace|patch|create_file|str_replace|insert|delete_file|rename|move_file|apply/.test(n)) return 'edit';
	if (/grep|glob|search|find|list|^ls$|codebase|lsp|symbol/.test(n)) return 'search';
	if (/read|view|cat|open|get_file|notebook/.test(n)) return 'read';
	return 'other';
}

export function humanize(name: string): { label: string; server?: string } {
	const m = /^mcp__(.+?)__(.+)$/.exec(name);
	if (m) return { label: m[2].replace(/_/g, ' '), server: m[1].replace(/^[0-9a-f-]{20,}$/i, 'mcp') };
	return { label: name };
}

const pick = (o: Record<string, unknown>, keys: string[]) => {
	for (const k of keys) if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
	return undefined;
};

const short = (s: string, n = 140) => {
	const line = s.trim().split('\n')[0];
	return line.length > n ? line.slice(0, n) + '…' : line + (s.trim().includes('\n') ? ' …' : '');
};

function str(v: unknown): string {
	if (typeof v === 'string') return v;
	return JSON.stringify(v, null, 2);
}

export function toolInfo(m: Msg): ToolInfo {
	const name = m.name ?? 'tool';
	const raw = m.text ?? '';
	const { label, server } = humanize(name);
	let category = categorize(name);
	let input: unknown;
	try {
		input = JSON.parse(raw);
	} catch {
		input = raw;
	}
	const info: ToolInfo = { category, label, server, summary: '', diffs: [], params: [], raw };

	if (typeof input === 'string') {
		// e.g. Codex's `exec` tool takes JavaScript, apply_patch takes a patch
		if (/^\*\*\* Begin Patch/m.test(input)) {
			info.category = 'edit';
			info.patch = input;
			info.summary = [...input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((x) => x[1]).join(', ');
		} else {
			info.code = input;
			info.summary = short(input);
		}
		return info;
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		info.summary = short(str(input));
		return info;
	}
	const o = input as Record<string, unknown>;

	const cmd = pick(o, CMD_KEYS) ?? (Array.isArray(o.command) ? (o.command as string[]).join(' ') : undefined);
	const path = pick(o, PATH_KEYS);
	const query = pick(o, QUERY_KEYS);
	const desc = pick(o, DESC_KEYS);

	if (cmd && category !== 'web') {
		info.category = category === 'other' || category === 'mcp' ? 'shell' : category;
		info.command = cmd;
	}

	// Edits: Claude (old_string/new_string, edits[]), OpenCode (oldString/newString), Antigravity (TargetContent/ReplacementContent)
	const pairs: [string, string][] = [
		['old_string', 'new_string'],
		['oldString', 'newString'],
		['TargetContent', 'ReplacementContent'],
		['old_str', 'new_str']
	];
	for (const [a, b] of pairs)
		if (typeof o[a] === 'string' || typeof o[b] === 'string') info.diffs.push({ file: path, old: String(o[a] ?? ''), new: String(o[b] ?? '') });
	for (const list of [o.edits, o.ReplacementChunks, o.chunks])
		if (Array.isArray(list))
			for (const e of list as Record<string, unknown>[]) {
				const old = e.old_string ?? e.oldString ?? e.TargetContent;
				const nw = e.new_string ?? e.newString ?? e.ReplacementContent;
				if (old != null || nw != null) info.diffs.push({ file: path, old: String(old ?? ''), new: String(nw ?? '') });
			}
	const content = o.content ?? o.contents ?? o.CodeContent ?? o.file_text;
	if (typeof content === 'string' && path && info.category === 'edit') info.diffs.push({ file: path, old: '', new: content });
	if (typeof o.patch === 'string' || typeof o.input === 'string' && /^\*\*\* Begin Patch/m.test(o.input as string)) info.patch = String(o.patch ?? o.input);
	if (info.diffs.length || info.patch) info.category = 'edit';

	info.summary = short(cmd ?? (path && query ? `${query} in ${path}` : (path ?? query ?? desc ?? '')));
	if (!info.summary) {
		const first = Object.values(o).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
		info.summary = first ? short(first) : '';
	}

	const shown = new Set<string>([...(cmd ? CMD_KEYS : []), ...pairs.flat(), 'edits', ...(info.diffs.some((d) => !d.old) ? ['content', 'contents', 'CodeContent', 'file_text'] : [])]);
	if (info.patch) shown.add('patch').add('input');
	if (info.diffs.some((d) => d.file)) PATH_KEYS.forEach((k) => shown.add(k)); // already shown above the diff
	info.params = Object.entries(o)
		.filter(([k, v]) => !shown.has(k) && v != null && v !== '')
		.map(([k, v]) => [k, str(v)]);
	return info;
}

/** Pairs each tool result with its call (by id), for rendering one card per step. */
export interface Step {
	call: Msg | null;
	result: Msg | null;
}

export type Block =
	| { type: 'message'; msg: Msg }
	| { type: 'activity'; items: ({ type: 'step'; step: Step } | { type: 'thinking'; msg: Msg })[] };

export function toBlocks(msgs: Msg[], show: { tools: boolean; thinking: boolean; meta: boolean }): Block[] {
	const results = new Map<string, Msg>();
	for (const m of msgs) if (m.kind === 'tool_result' && m.id) results.set(m.id, m);
	const used = new Set<Msg>();
	const blocks: Block[] = [];
	const activity = () => {
		const last = blocks[blocks.length - 1];
		if (last?.type === 'activity') return last;
		const b: Block = { type: 'activity', items: [] };
		blocks.push(b);
		return b;
	};
	for (const m of msgs) {
		if (m.kind === 'tool_call') {
			if (!show.tools) continue;
			const result = m.id ? (results.get(m.id) ?? null) : null;
			if (result) used.add(result);
			activity().items.push({ type: 'step', step: { call: m, result } });
		} else if (m.kind === 'tool_result') {
			if (!show.tools || used.has(m)) continue;
			activity().items.push({ type: 'step', step: { call: null, result: m } });
		} else if (m.kind === 'thinking') {
			if (show.thinking) activity().items.push({ type: 'thinking', msg: m });
		} else if (m.kind === 'meta') {
			if (show.meta) blocks.push({ type: 'message', msg: m });
		} else blocks.push({ type: 'message', msg: m });
	}
	return blocks;
}
