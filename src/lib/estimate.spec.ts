import { describe, expect, it } from 'vitest';
import { estimateTokens } from './estimate';
import type { Msg } from './types';

const m = (role: Msg['role'], kind: Msg['kind'], text: string, call?: boolean): Msg => ({ role, kind, text, time: null, ...(call ? { call } : {}) });

describe('estimateTokens', () => {
	it('bills each call for the context so far: new text as input, the rest as cache reads', async () => {
		const t = await estimateTokens([m('user', 'text', 'hello there'), m('assistant', 'text', 'hi'), m('user', 'text', 'and again'), m('assistant', 'text', 'ok')]);
		expect(t.output).toBeGreaterThan(0);
		expect(t.input).toBeGreaterThan(0);
		// second call re-sends the first prompt and reply
		expect(t.cache_read).toBeGreaterThan(0);
		expect(t.input + t.cache_read).toBeGreaterThan(t.input);
	});

	it('treats back-to-back tool calls as one call', async () => {
		const one = await estimateTokens([m('user', 'text', 'go'), m('assistant', 'tool_call', 'a'), m('assistant', 'tool_call', 'b')]);
		expect(one.cache_read).toBe(0);
	});

	it('uses response boundaries when the transcript marks them', async () => {
		const msgs = [m('user', 'text', 'go'), m('assistant', 'tool_call', 'a', true), m('assistant', 'tool_call', 'b', true)];
		const t = await estimateTokens(msgs);
		expect(t.cache_read).toBeGreaterThan(0); // the second response re-sent the first
	});
});
