export const MAX_TOOL_TEXT = 20000;

/** ISO string or epoch seconds/ms -> epoch ms */
export function ms(ts: unknown): number | null {
	if (ts == null) return null;
	if (typeof ts === 'number') return Math.trunc(ts > 1e11 ? ts : ts * 1000);
	if (typeof ts === 'string') {
		const v = Date.parse(ts);
		return Number.isNaN(v) ? null : v;
	}
	return null;
}

export function clip(s: unknown, n = MAX_TOOL_TEXT): string {
	if (s == null) return '';
	const str = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
	return str.length <= n
		? str
		: str.slice(0, n) + `\n\n… [${(str.length - n).toLocaleString()} more characters truncated]`;
}

export function oneLine(s: string | null | undefined, n = 160): string {
	return (s ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, n);
}

const TAG_BLOCK = /^\s*<([A-Za-z_][\w-]*)[^>]*>[\s\S]*?<\/\1>\s*/;

/** Drop leading <tag>...</tag> wrappers that clients inject before the real prompt. */
export function stripTagBlocks(t: string | null | undefined): string {
	let s = t ?? '';
	for (;;) {
		const m = TAG_BLOCK.exec(s);
		if (!m) return s.trim();
		s = s.slice(m[0].length);
	}
}

const META_PREFIXES = [
	'<system-reminder>',
	'<command-',
	'<local-command',
	'Caveat:',
	'<environment_context>',
	'# AGENTS.md',
	'<user_instructions>',
	'<permissions',
	'<ide_'
];

/** Text the client injected (context, reminders) rather than something the person typed. */
export function isMetaPrompt(text: string): boolean {
	const t = text.trimStart();
	if (t.startsWith('<') && !stripTagBlocks(t)) return true;
	// Client-injected blocks like <recommended_plugins>…</environment_context> (snake_case tags at both ends)
	if (/^<[a-z]+(?:_[a-z]+)+[\s>]/.test(t) && /<\/[a-z]+(?:_[a-z]+)*>\s*$/.test(t)) return true;
	return META_PREFIXES.some((p) => t.startsWith(p));
}

/** Split text into lines without keeping a huge array of copies around longer than needed. */
export function* lines(text: string): Generator<string> {
	let i = 0;
	while (i < text.length) {
		let j = text.indexOf('\n', i);
		if (j < 0) j = text.length;
		const line = text.slice(i, j);
		if (line.trim()) yield line;
		i = j + 1;
	}
}

export function tryJson(line: string): any {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

export function snippetAround(text: string, i: number) {
	return text.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ');
}
