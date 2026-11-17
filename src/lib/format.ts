import { addTokens, emptyTokens, totalTokens, type Session, type Tokens } from './types';

export const fmt = (n: number | null | undefined) =>
	n == null
		? '–'
		: n >= 1e9
			? (n / 1e9).toFixed(2) + 'B'
			: n >= 1e6
				? (n / 1e6).toFixed(1) + 'M'
				: n >= 1e3
					? (n / 1e3).toFixed(1) + 'k'
					: String(n);

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();

export const date = (ms: number | null | undefined) =>
	ms
		? new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
		: '';

export function ago(ms: number | null | undefined) {
	if (!ms) return '';
	const s = (Date.now() - ms) / 1000;
	if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
	if (s < 86400) return Math.floor(s / 3600) + 'h ago';
	if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
	return new Date(ms).toLocaleDateString();
}

export const folder = (p: string | null | undefined) =>
	p ? p.replace(/\\/g, '/').replace(/\/$/, '').split('/').slice(-2).join('/') : '';

/** Session tokens including any subagents it spawned. */
export const allTokens = (s: Session): Tokens => addTokens(addTokens(emptyTokens(), s.tokens), s.subagent_tokens);
export const sessionTotal = (s: Session) => totalTokens(allTokens(s));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Small, safe markdown: fenced code, inline code, bold, headings, links. Everything else stays text. */
export function md(text: string): string {
	return String(text)
		.split('```')
		.map((p, i) => {
			if (i % 2) {
				const nl = p.indexOf('\n');
				const body = nl >= 0 ? p.slice(nl + 1) : p;
				return `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
			}
			return esc(p)
				.replace(/`([^`\n]+)`/g, '<code>$1</code>')
				.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
				.replace(/^#{1,6} (.+)$/gm, '<b>$1</b>')
				.replace(/\[([^\]]+)\]\((https?:[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
		})
		.join('');
}

export const preview = (s: string | undefined, n = 140) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** A duration: "3h 20m", "45m", "12s" */
export function dur(ms: number | null | undefined): string {
	if (!ms || ms < 0) return '0m';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
