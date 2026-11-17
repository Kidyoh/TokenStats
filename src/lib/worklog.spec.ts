import { describe, expect, it } from 'vitest';
import { emptyTokens, type Msg, type Session } from './types';
import { activeMinutes, clip, connect, dropFragment, firstSentence, plainText, projectName, toEntry, WORKLOG_URL, WorklogError } from './worklog';

const T0 = Date.UTC(2026, 10, 16, 9, 0);
const min = 60_000;

const session = (over: Partial<Session> = {}): Session => ({
	id: 'claude:abc',
	source: 'claude',
	path: 'C:\\Users\\jane\\.claude\\projects\\x\\abc.jsonl',
	size: 1,
	parent: null,
	subagents: [],
	subagent_tokens: emptyTokens(),
	title: 'Add retry with backoff to the webhook sender',
	first_prompt:
		'Add retry with backoff to the webhook sender. Deliveries fail when the receiver is briefly down, so retry up to five times. My key is sk-proj-' +
		'q'.repeat(30) +
		' and see C:\\Users\\jane\\code\\api\\src\\hooks.ts or https://github.com/acme/api/issues/17 for context.',
	cwd: 'C:\\Users\\jane\\code\\api',
	branch: 'feature/PAY-42',
	start: T0,
	end: T0 + 600 * min,
	tokens: emptyTokens(),
	models: { 'claude-opus-4-5': emptyTokens() },
	cost: 1.2,
	turns: 3,
	messages: 6,
	client: null,
	...over
});

const at = (...mins: number[]): Msg[] => mins.map((m) => ({ role: 'user', kind: 'text', text: 'x', time: T0 + m * min }));

describe('activeMinutes', () => {
	it('adds gaps between messages and skips breaks over 30 minutes', () => {
		expect(activeMinutes(session(), at(0, 10, 20, 200, 205))).toBe(25);
	});
	it('falls back to start-to-end, capped at 4 hours, without message times', () => {
		expect(activeMinutes(session({ end: T0 + 45 * min }), [])).toBe(45);
		expect(activeMinutes(session(), [])).toBe(240);
		expect(activeMinutes(session({ end: null }), [])).toBeUndefined();
	});
});

describe('projectName', () => {
	it('keeps only the last folder name', () => {
		expect(projectName('C:\\Users\\jane\\code\\api')).toBe('api');
		expect(projectName('/home/jane/work/billing/')).toBe('billing');
	});
	it('drops home folders and drive roots', () => {
		expect(projectName('C:\\Users\\jane')).toBeUndefined();
		expect(projectName('/home/jane')).toBeUndefined();
		expect(projectName('D:\\')).toBeUndefined();
		expect(projectName('D:\\stuff\\jane', ['jane'])).toBeUndefined();
	});
});

describe('plainText / clip', () => {
	it('removes code, links, paths and injected tags', () => {
		const t = plainText('Fix the bug in `parse()` <system-reminder>secret ctx</system-reminder> see https://x.y/z and /usr/local/bin/tool\n```js\nconst a=1\n```\ndone');
		expect(t).toBe('Fix the bug in see and done');
	});
	it('can leave out sentences that lost too much', () => {
		const t = 'Retry five times. My key is [REDACTED API KEY] and see C:\\x\\y.ts for context. Log each failure.';
		expect(plainText(t, true)).toBe('Retry five times. Log each failure.');
		expect(plainText('Fix the bug in `parse()` before the release goes out.', true)).toBe('Fix the bug in before the release goes out.');
	});
	it('drops a dangling tail left by removed text', () => {
		expect(dropFragment('Retry up to five times. Key, see')).toBe('Retry up to five times.');
		expect(dropFragment('Retry up to five times. Then log every failed attempt clearly')).toBe('Retry up to five times. Then log every failed attempt clearly');
		expect(dropFragment('Fix the export, see')).toBe('Fix the export, see');
	});
	it('takes the first sentence as a title', () => {
		expect(firstSentence('Add retries to the sender. Then more.')).toBe('Add retries to the sender.');
		expect(firstSentence('Hi. Add retries to the sender.')).toBe('Hi. Add retries to the sender.');
	});
	it('cuts at a sentence end when it can', () => {
		expect(clip('One two three. Four five six seven eight nine.', 26)).toBe('One two three.');
		expect(clip('alpha beta gamma delta', 12)).toBe('alpha beta…');
	});
});

describe('toEntry', () => {
	it('maps a session to a redacted log_work entry', () => {
		const e = toEntry(session(), at(0, 10, 20, 200, 205))!;
		expect(e).toMatchObject({
			title: 'Add retry with backoff to the webhook sender',
			project: 'api',
			category: 'development',
			agent: 'claude-code',
			tags: ['claude-code', 'claude-opus-4-5'],
			occurred_at: new Date(T0).toISOString(),
			duration_minutes: 25,
			external_id: 'session-browser:claude:abc'
		});
		const all = JSON.stringify(e);
		for (const leak of ['sk-proj', 'jane', 'github.com', 'hooks.ts', 'PAY-42', 'feature/', 'REDACTED', '1.2']) expect(all).not.toContain(leak);
		expect(e.summary).toBe('Deliveries fail when the receiver is briefly down, so retry up to five times.');
		expect(e.summary!.length).toBeLessThanOrEqual(300);
	});
	it('leaves out a summary that says nothing new', () => {
		expect(toEntry(session({ title: 'fix this', first_prompt: 'fix this' }), [])!.summary).toBeUndefined();
	});
	it('skips sessions without a start time', () => {
		expect(toEntry(session({ start: null }), [])).toBeNull();
	});
});

describe('connect', () => {
	const KEY = 'wl_' + 'a'.repeat(30);
	type Call = { url: string; init: RequestInit };

	function fake(replies: ((body: any) => Response)[]) {
		const calls: Call[] = [];
		const f = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return replies[calls.length - 1](JSON.parse(String(init.body)));
		}) as unknown as typeof fetch;
		return { f, calls };
	}
	const json = (b: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json', ...headers } });

	it('sends the key in a header, keeps the MCP session, and reads SSE replies', async () => {
		const { f, calls } = fake([
			(b) => json({ jsonrpc: '2.0', id: b.id, result: {} }, { 'mcp-session-id': 's1' }),
			(b) =>
				new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: 'Logged' }] } })}\n\n`, {
					headers: { 'content-type': 'text/event-stream' }
				})
		]);
		const c = await connect(KEY, f);
		expect(await c.call('log_work', { title: 't' })).toBe('Logged');
		for (const { url } of calls) expect(url).toBe(WORKLOG_URL);
		const h = calls[1].init.headers as Record<string, string>;
		expect(h.Authorization).toBe(`Bearer ${KEY}`);
		expect(h['Mcp-Session-Id']).toBe('s1');
		expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ method: 'tools/call', params: { name: 'log_work', arguments: { title: 't' } } });
	});

	it('rejects bad keys before and after sending', async () => {
		await expect(connect('nope', fake([]).f)).rejects.toThrow(/start with wl_/);
		const { f } = fake([() => new Response('', { status: 401 })]);
		await expect(connect(KEY, f)).rejects.toBeInstanceOf(WorklogError);
	});

	it('surfaces tool errors', async () => {
		const { f } = fake([
			(b) => json({ jsonrpc: '2.0', id: b.id, result: {} }),
			(b) => json({ jsonrpc: '2.0', id: b.id, result: { isError: true, content: [{ type: 'text', text: 'title is required' }] } })
		]);
		const c = await connect(KEY, f);
		await expect(c.call('log_work', {})).rejects.toThrow('title is required');
	});
});
