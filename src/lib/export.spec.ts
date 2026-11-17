import { describe, expect, it } from 'vitest';
import { defaultOptions, toMarkdown, toTraining } from './export';
import { emptyTokens, type Msg, type Session } from './types';

const session: Session = {
	id: 'claude:x',
	source: 'claude',
	path: 'p',
	size: 1,
	parent: null,
	subagents: [],
	subagent_tokens: emptyTokens(),
	title: 'Fix login',
	first_prompt: 'fix login',
	cwd: 'C:\\Users\\jane\\app',
	branch: null,
	start: 0,
	end: 0,
	tokens: emptyTokens(),
	models: { 'claude-x': emptyTokens() },
	cost: null,
	turns: 1,
	messages: 4,
	client: null
};

const msgs: Msg[] = [
	{ role: 'user', kind: 'meta', text: '<system-reminder>ctx</system-reminder>', time: null },
	{ role: 'user', kind: 'text', text: 'fix login, my key is sk-proj-' + 'q'.repeat(30), time: null },
	{ role: 'assistant', kind: 'thinking', text: 'hmm', time: null },
	{ role: 'assistant', kind: 'text', text: 'Looking.', time: null },
	{ role: 'assistant', kind: 'tool_call', id: 't1', name: 'Read', text: '{"file_path":"src/login.ts"}', time: null },
	{ role: 'tool', kind: 'tool_result', id: 't1', text: 'export const x = 1', time: null },
	{ role: 'assistant', kind: 'tool_call', id: 'orphan', name: 'Bash', text: '{"command":"ls"}', time: null },
	{ role: 'assistant', kind: 'text', text: 'Fixed.', time: null }
];

describe('training export', () => {
	it('produces clean, redacted chat messages', () => {
		const t = toTraining(session, msgs, { ...defaultOptions, mode: 'training' }) as any;
		const roles = t.messages.map((m: any) => m.role);
		expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
		expect(t.messages[0].content).not.toContain('sk-proj-');
		expect(t.messages[1].tool_calls[0].function).toEqual({ name: 'Read', arguments: '{"file_path":"src/login.ts"}' });
		expect(t.messages[2].tool_call_id).toBe('t1');
		expect(JSON.stringify(t)).not.toContain('orphan');
		expect(JSON.stringify(t)).not.toContain('system-reminder');
		expect(JSON.stringify(t)).not.toContain('hmm');
	});
	it('keeps thinking when asked', () => {
		const t = toTraining(session, msgs, { ...defaultOptions, mode: 'training', includeThinking: true }) as any;
		expect(t.messages[1].reasoning).toBe('hmm');
	});
	it('skips conversations with no assistant reply', () => {
		expect(toTraining(session, [msgs[1]], { ...defaultOptions, mode: 'training' })).toBeNull();
	});
});

describe('markdown export', () => {
	it('redacts when asked and keeps it readable', () => {
		const md = toMarkdown(session, msgs, { ...defaultOptions, redact: true });
		expect(md).toContain('# Fix login');
		expect(md).toContain('## You');
		expect(md).not.toContain('jane');
		expect(md).not.toContain('sk-proj-');
	});
});
