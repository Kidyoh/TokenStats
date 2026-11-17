// "Remove sensitive info": strips secrets and personal details from what's shown and exported.
// Pattern-based, so it's a strong safety net rather than a guarantee. Runs on this device only.
import type { Msg, Session } from './types';

const R = (label: string) => `[REDACTED ${label}]`;

type Rule = { re: RegExp; to: string | ((...m: string[]) => string); label: string };

const KEY_WORDS = String.raw`(?:secret|token(?!s)|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credential|session[_-]?key|webhook[_-]?secret|database[_-]?url|db[_-]?url|connection[_-]?string|dsn)`;

const RULES: Rule[] = [
	// Private keys and certificates' keys
	{ re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, to: R('PRIVATE KEY'), label: 'Private key' },
	// Provider keys with recognisable shapes
	{ re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, to: R('ANTHROPIC KEY'), label: 'Anthropic key' },
	{ re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, to: R('API KEY'), label: 'OpenAI-style key' },
	{ re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g, to: R('GITHUB TOKEN'), label: 'GitHub token' },
	{ re: /\bglpat-[A-Za-z0-9_-]{20,}/g, to: R('GITLAB TOKEN'), label: 'GitLab token' },
	{ re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, to: R('SLACK TOKEN'), label: 'Slack token' },
	{ re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, to: R('AWS KEY'), label: 'AWS key' },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, to: R('GOOGLE KEY'), label: 'Google key' },
	{ re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, to: R('STRIPE KEY'), label: 'Stripe key' },
	{ re: /\bwhsec_[A-Za-z0-9]{20,}/g, to: R('WEBHOOK SECRET'), label: 'Webhook secret' },
	{ re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, to: R('TELEGRAM BOT TOKEN'), label: 'Telegram bot token' },
	{ re: /\bnpm_[A-Za-z0-9]{36}\b/g, to: R('NPM TOKEN'), label: 'npm token' },
	{ re: /\bhf_[A-Za-z0-9]{30,}\b/g, to: R('HUGGINGFACE TOKEN'), label: 'Hugging Face token' },
	{ re: /\b(?:xai|gsk|pplx|fw|r8)_?-?[A-Za-z0-9]{40,}\b/g, to: R('API KEY'), label: 'API key' },
	{ re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: R('JWT'), label: 'JWT' },
	{ re: /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{20,}/g, to: (_m, a, b) => `${a}${b}${R('CREDENTIAL')}`, label: 'Auth header' },
	// user:password@host in URLs and connection strings
	{ re: /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@'"]+):([^@\s/'"]+)@/gi, to: (_m, a) => `${a}:${R('PASSWORD')}@`, label: 'Password in URL' },
	// KEY=value lines (.env, shell exports, config)
	{
		re: new RegExp(String.raw`^(\s*(?:export\s+|set\s+|\$env:)?[A-Za-z0-9_.-]*${KEY_WORDS}[A-Za-z0-9_.-]*\s*[=:]\s*)(["']?)([^\s"'#]{4,})\2`, 'gim'),
		to: (_m, a, q) => `${a}${q}${R('VALUE')}${q}`,
		label: 'Secret setting'
	},
	// "apiKey": "value" / password: 'value' in JSON, YAML, code
	{
		re: new RegExp(String.raw`(["']?)([A-Za-z0-9_-]*${KEY_WORDS}[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(["'])([^"'\n]{4,})\4`, 'gi'),
		to: (_m, q1, k, sep, q2) => `${q1}${k}${q1}${sep}${q2}${R('VALUE')}${q2}`,
		label: 'Secret setting'
	},
	// Email addresses (keeps git@host and noreply addresses)
	{
		re: /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
		to: (m, local, domain) => (/^(git|noreply|no-reply)$/i.test(local) || /noreply/i.test(domain) ? m : '[EMAIL]'),
		label: 'Email'
	},
	// Usernames in home-folder paths: C:\Users\name, /Users/name, /home/name, Claude's C--Users-name
	{ re: /([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))(?!Public\b|Default\b|<user>)([^\\/\s"'`<>:|*?]+)/g, to: (_m, a) => `${a}<user>`, label: 'Username' },
	{ re: /(\/(?:Users|home)\/)(?!Shared\b|<user>)([^/\s"'`<>]+)/g, to: (_m, a) => `${a}<user>`, label: 'Username' },
	{ re: /\b([A-Za-z]--Users-)(?!<user>)([^-\s/\\]+)/g, to: (_m, a) => `${a}<user>`, label: 'Username' },
	// A key cut off at the end of a shortened string (titles, previews) no longer matches the full shapes above.
	{ re: /(?:\bsk-|\bgh[pousr]_|\bgithub_pat_|\bxox[abprs]-|\bAKIA|\bAIza|\b(?:sk|rk)_live_|\b\d{8,10}:AA|\beyJ[A-Za-z0-9_-]{4,}\.)[A-Za-z0-9_.-]*…?$/, to: R('KEY'), label: 'Partial key' }
];

// Usernames, learned from home-folder paths, so they can also be hidden where they appear on their own
// (e.g. the owner column of `ls -l`).
const HOME_USER = [
	/[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([^\\/\s"'`<>:|*?]+)/gi,
	/\/(?:Users|home)\/([^/\s"'`<>]+)/g,
	/\b[A-Za-z]--Users-([^-\s/\\]+)/g
];
const NOT_A_NAME = new Set(['public', 'default', 'shared', 'all users', 'user', 'users', '<user>', 'admin', 'administrator', 'guest', 'runner', 'node', 'app', 'ubuntu', 'root']);

export function findUsernames(texts: (string | null | undefined)[]): string[] {
	const names = new Set<string>();
	for (const t of texts)
		for (const re of HOME_USER)
			for (const m of (t ?? '').matchAll(re)) {
				const n = m[1];
				if (n.length >= 3 && !NOT_A_NAME.has(n.toLowerCase())) names.add(n);
			}
	return [...names];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Called once for every piece of text that redaction removes. */
export type Collect = (type: string, original: string) => void;

export function redactText(
	text: string | undefined | null,
	usernames: string[] = [],
	collect?: Collect
): { text: string; count: number } {
	let out = text ?? '';
	let count = 0;
	const rules = usernames.length
		? [...RULES, { re: new RegExp(`(?<![A-Za-z0-9_])(?:${usernames.map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'gi'), to: '<user>', label: 'Username' } as Rule]
		: RULES;
	for (const { re, to, label } of rules) {
		out = out.replace(re, (...args) => {
			const m = args[0] as string;
			const replaced = typeof to === 'string' ? to : to(...(args.slice(0, -2) as string[]));
			if (replaced !== m) {
				count++;
				collect?.(label, m);
			}
			return replaced;
		});
	}
	return { text: out, count };
}

// Files whose contents are secret by nature. Example/template env files are fine to show.
const SENSITIVE_FILE =
	/(?:^|[\\/\s"'`=(])(\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)*|\.dev\.vars|\.npmrc|\.pypirc|\.netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks)|credentials(?:\.json)?|service[-_]account[\w-]*\.json|secrets?\.(?:json|ya?ml|toml|env)|auth\.json|\.git-credentials)(?=$|[\s"'`\\/,;)}:])/i;

export const sensitiveFileIn = (s: string | undefined) => SENSITIVE_FILE.exec(s ?? '')?.[1] ?? null;

export interface RedactedItem {
	type: string;
	/** the text that was removed (kept only in memory, on this device) */
	original: string;
	/** index into the message list */
	msg: number;
}

export interface Redacted {
	msgs: Msg[];
	count: number;
	items: RedactedItem[];
}

/** Redact a whole conversation. Results of tool calls that touched a sensitive file are dropped entirely.
 *  `extra` is other text from the session (e.g. its folder) to learn usernames from. */
export function redactMessages(msgs: Msg[], extra: (string | null | undefined)[] = []): Redacted {
	const items: RedactedItem[] = [];
	const users = findUsernames([...extra, ...msgs.map((m) => m.text)]);
	const sensitiveCalls = new Map<string, string>();
	const out = msgs.map((m, i) => {
		const collect: Collect = (type, original) => items.push({ type, original, msg: i });
		if (m.kind === 'image') {
			collect('Image', '[attached image]');
			return { ...m, image: null, text: '[image removed]' };
		}
		if (m.kind === 'tool_call') {
			const file = sensitiveFileIn(m.text);
			if (file) {
				if (m.id) sensitiveCalls.set(m.id, file);
				// Keep what the call was, hide anything it was going to write.
				const r = redactText(m.text, users, collect);
				const hidden = r.text.replace(/("(?:content|contents|new_string|newString|old_string|oldString|CodeContent|ReplacementContent|text|patch|input)"\s*:\s*)("(?:[^"\\]|\\.)*")/g, (_x, a, value) => {
					collect(`Contents of ${file}`, value.slice(1, -1));
					return `${a}"[REDACTED contents of ${file}]"`;
				});
				return { ...m, text: hidden };
			}
		}
		if (m.kind === 'tool_result' && m.id && sensitiveCalls.has(m.id)) {
			collect(`Contents of ${sensitiveCalls.get(m.id)}`, m.text ?? '');
			return { ...m, text: `[REDACTED contents of ${sensitiveCalls.get(m.id)}]` };
		}
		const r = redactText(m.text, users, collect);
		return r.count ? { ...m, text: r.text } : m;
	});
	return { msgs: out, count: items.length, items };
}

type Titled = Pick<Session, 'title' | 'cwd' | 'first_prompt' | 'path'>;

/** Titles are often the first prompt cut to 160 characters, and the cut can fall inside a secret.
 *  Redact the longer prompt first, then shorten it again. */
export function redactTitle(s: Pick<Session, 'title' | 'first_prompt'>, users: string[] = []): string {
	if (s.first_prompt && s.title && s.first_prompt.startsWith(s.title) && s.first_prompt.length > s.title.length)
		return redactText(s.first_prompt, users).text.slice(0, s.title.length);
	return redactText(s.title, users).text;
}

export function redactSession<T extends Titled>(s: T, users: string[] = findUsernames([s.cwd, s.path])): T {
	return {
		...s,
		title: redactTitle(s, users),
		first_prompt: redactText(s.first_prompt, users).text,
		cwd: s.cwd ? redactText(s.cwd, users).text : s.cwd,
		path: redactText(s.path, users).text
	};
}
