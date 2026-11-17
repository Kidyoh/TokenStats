import { describe, expect, it } from 'vitest';
import { commandName, computeStats, emptyStats, mergeStats } from './stats';
import type { Msg } from './types';

const T0 = new Date(2026, 10, 16, 9, 0).getTime(); // Monday 09:00 local
const min = 60_000;

describe('commandName', () => {
	it('names the program, with the subcommand where it matters', () => {
		expect(commandName('git status')).toBe('git status');
		expect(commandName('cd app && FOO=1 npm run test -- -u')).toBe('npm run');
		expect(commandName('sudo /usr/bin/ls -la')).toBe('ls');
		expect(commandName('python -m pytest -q')).toBe('python -m pytest');
		expect(commandName('C:\\tools\\rg.exe "x" src')).toBe('rg');
		expect(commandName('npx --yes vitest run')).toBe('npx vitest');
	});
	it('gives up on things that are not commands', () => {
		expect(commandName('')).toBeNull();
		expect(commandName('$(weird)')).toBeNull();
	});
});

describe('computeStats', () => {
	const msgs: Msg[] = [
		{ role: 'user', kind: 'text', text: 'fix it', time: T0 },
		{ role: 'assistant', kind: 'text', text: 'ok', time: T0 + 1 * min },
		{ role: 'assistant', kind: 'tool_call', name: 'Bash', id: 'a', text: JSON.stringify({ command: 'git status' }), time: T0 + 2 * min },
		{ role: 'tool', kind: 'tool_result', id: 'a', text: 'clean', time: T0 + 3 * min },
		{ role: 'assistant', kind: 'tool_call', name: 'Edit', id: 'b', text: '{}', time: T0 + 4 * min },
		{ role: 'tool', kind: 'tool_result', id: 'b', text: 'failed', error: true, time: T0 + 5 * min },
		{ role: 'user', kind: 'meta', text: '<system-reminder>x</system-reminder>', time: T0 + 6 * min },
		// a 3 hour break, then more work
		{ role: 'user', kind: 'text', text: 'again', time: T0 + 186 * min },
		{ role: 'assistant', kind: 'tool_call', name: 'exec_command', id: 'c', text: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), time: T0 + 190 * min },
		{ role: 'tool', kind: 'tool_result', id: 'c', text: 'ok', time: T0 + 192 * min }
	];
	const st = computeStats(msgs);

	it('counts tool calls, failures and time per tool', () => {
		expect(st.tools.Bash).toEqual({ n: 1, err: 0, ms: min, timed: 1 });
		expect(st.tools.Edit).toEqual({ n: 1, err: 1, ms: min, timed: 1 });
		expect(st.cmds).toEqual({ 'git status': 1, 'npm test': 1 });
	});
	it('adds up active time without the break, by day and hour', () => {
		expect(st.timed).toBe(true);
		expect(st.active).toBe(12 * min); // 6 min, then 6 min after the break
		const day = new Date(T0);
		const k = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
		expect(st.days[k]).toBe(12 * min);
		expect(st.wh[String(1 * 24 + 9)]).toBe(6 * min); // Monday 9am
		expect(st.wh[String(1 * 24 + 12)]).toBe(6 * min); // Monday 12pm
	});
	it('counts prompts and the time to the first reply', () => {
		expect(st.prompts).toBe(2);
		expect(st.resp).toEqual([5 * min, 2]); // 1 min, then 4 min
	});
	it('merges subagents without counting their time twice', () => {
		const total = mergeStats(mergeStats(emptyStats(), st), st, false);
		expect(total.tools.Bash.n).toBe(2);
		expect(total.active).toBe(st.active);
	});
});
