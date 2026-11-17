import { describe, expect, it } from 'vitest';
import { redactMessages, redactText, sensitiveFileIn } from './redact';

// Fake values shaped like real credentials. None of these are live.
const fake = {
	telegram: '1234567890:AA' + 'x'.repeat(33),
	openai: 'sk-proj-' + 'a1B2'.repeat(10),
	github: 'ghp_' + 'Z9'.repeat(18),
	aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
	jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl'
};

describe('redactText', () => {
	it('removes provider tokens', () => {
		for (const v of Object.values(fake)) {
			const r = redactText(`token here: ${v} end`);
			expect(r.text).not.toContain(v);
			expect(r.count).toBeGreaterThan(0);
		}
	});
	it('removes env-style values but keeps names', () => {
		const r = redactText('DATABASE_URL=postgres://app:hunter2@db:5432/x\nSTRIPE_SECRET_KEY="abcd1234efgh"\nPORT=3000');
		expect(r.text).toContain('DATABASE_URL=');
		expect(r.text).not.toContain('hunter2');
		expect(r.text).not.toContain('abcd1234efgh');
		expect(r.text).toContain('PORT=3000');
	});
	it('removes JSON secrets but not token counts', () => {
		const r = redactText('{"apiKey": "abcd-1234-xyz", "max_tokens": "4096", "input_tokens": 12}');
		expect(r.text).not.toContain('abcd-1234-xyz');
		expect(r.text).toContain('"max_tokens": "4096"');
	});
	it('removes emails and home-folder usernames', () => {
		const r = redactText('mail jane.doe@example.com, path C:\\Users\\jane\\code and /home/jane/x and C--Users-jane-proj, git@github.com:a/b');
		expect(r.text).not.toMatch(/jane/);
		expect(r.text).toContain('git@github.com');
	});
	it('leaves ordinary text alone', () => {
		const t = 'Run npm test, then open src/routes/+page.svelte and fix the token counter.';
		expect(redactText(t)).toEqual({ text: t, count: 0 });
	});
});

describe('redactMessages', () => {
	it('drops the output of tools that read sensitive files', () => {
		const { msgs, count } = redactMessages([
			{ role: 'assistant', kind: 'tool_call', id: 'a', name: 'Read', text: '{"file_path": "D:/app/.env"}', time: null },
			{ role: 'tool', kind: 'tool_result', id: 'a', text: 'SOMETHING=whatever-value', time: null },
			{ role: 'assistant', kind: 'tool_call', id: 'b', name: 'Read', text: '{"file_path": "D:/app/.env.example"}', time: null },
			{ role: 'tool', kind: 'tool_result', id: 'b', text: 'PORT=3000', time: null }
		]);
		expect(msgs[1].text).toBe('[REDACTED contents of .env]');
		expect(msgs[3].text).toBe('PORT=3000');
		expect(count).toBeGreaterThan(0);
	});
	it('hides content written to sensitive files', () => {
		const { msgs } = redactMessages([
			{ role: 'assistant', kind: 'tool_call', id: 'w', name: 'Write', text: '{"file_path": ".env", "content": "A=1\\nB=2"}', time: null }
		]);
		expect(msgs[0].text).not.toContain('A=1');
		expect(sensitiveFileIn('cat ~/.ssh/id_ed25519')).toBe('id_ed25519');
	});
});

describe('leaks found in real data', () => {
	it('hides a username that appears on its own once it was seen in a home path', async () => {
		const { redactMessages: rm } = await import('./redact');
		const { msgs } = rm(
			[{ role: 'tool', kind: 'tool_result', id: 'x', text: 'drwxr-xr-x 1 jdoe42 197609 0 Oct 1 src', time: null }],
			[String.raw`C:\Users\jdoe42\code`]
		);
		expect(msgs[0].text).not.toContain('jdoe42');
	});
	it('redacts a title whose 160-character cut falls inside a token', async () => {
		const { redactTitle } = await import('./redact');
		const prompt = 'use this bot token ' + '1234567890:AA' + 'y'.repeat(33) + ' please';
		const title = prompt.slice(0, 30); // ends in the middle of the token
		expect(redactTitle({ title, first_prompt: prompt })).not.toMatch(/1234567890/);
	});
});
