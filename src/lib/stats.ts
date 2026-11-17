// Per-session statistics for the Tools and Time pages, worked out once when a session is read
// (in the parse worker) and cached with its summary.
import type { Msg } from './types';

/** A gap between messages longer than this counts as a break, not work. */
export const IDLE_MS = 30 * 60_000;

export interface ToolStat {
	/** calls */
	n: number;
	/** calls whose result was an error */
	err: number;
	/** total time between call and result, over the calls where both have times */
	ms: number;
	/** calls with a measured time */
	timed: number;
}

export interface SessionStats {
	/** by raw tool name */
	tools: Record<string, ToolStat>;
	/** shell commands by program ("git status", "npm test", "ls") */
	cmds: Record<string, number>;
	/** active time in ms: gaps between messages, leaving out breaks over 30 minutes */
	active: number;
	/** whether the transcript records message times at all */
	timed: boolean;
	/** active ms by local weekday*24 + hour (0 = Sunday 00:00), sparse */
	wh: Record<string, number>;
	/** active ms by local day "YYYY-MM-DD", sparse */
	days: Record<string, number>;
	/** prompts typed by the person (injected context left out) */
	prompts: number;
	/** time from a prompt to the first reply: [total ms, count] */
	resp: [number, number];
}

export const emptyStats = (): SessionStats => ({ tools: {}, cmds: {}, active: 0, timed: false, wh: {}, days: {}, prompts: 0, resp: [0, 0] });

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const CMD_KEYS = ['command', 'cmd', 'CommandLine', 'commandLine', 'script'];
/** Programs where the subcommand says more than the program ("git status", not "git"). */
const WITH_SUB = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'docker', 'gh', 'kubectl', 'pip', 'uv', 'poetry', 'deno', 'dotnet', 'make', 'brew', 'apt', 'winget', 'vercel', 'supabase', 'flutter', 'dart', 'terraform', 'az', 'aws', 'gcloud']);
const WRAPPERS = new Set(['sudo', 'time', 'env', 'nohup', 'exec', 'command', 'call', '&', '.']);

/** The program a shell command runs, e.g. `cd app && FOO=1 npm run test -- -u` → "npm run". */
export function commandName(command: string): string | null {
	// The last meaningful part of a chain is usually the point; `cd` and `export` are setup.
	const parts = command
		.split(/&&|\|\||;|\n/)
		.map((p) => p.trim())
		.filter(Boolean);
	const main = parts.find((p) => !/^(cd|pushd|popd|set|export|source|\$env:|Set-Location)\b/i.test(p)) ?? parts[0];
	if (!main) return null;
	const words = main.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
	while (words.length && WRAPPERS.has(words[0].toLowerCase())) words.shift();
	if (!words.length) return null;
	let prog = words[0].replace(/^["'(]+|["')]+$/g, '');
	prog = prog.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
	if (!prog || !/^[\w.+-]+$/.test(prog)) return null;
	if (prog === 'python' || prog === 'python3' || prog === 'py') {
		if (words[1] === '-m' && words[2]) return `${prog} -m ${words[2]}`;
		return prog;
	}
	const sub = words.slice(1).find((w) => !w.startsWith('-'));
	if (WITH_SUB.has(prog) && sub && /^[\w:.-]+$/.test(sub)) return `${prog} ${sub.toLowerCase()}`;
	return prog;
}

function commandOf(m: Msg): string | null {
	try {
		const o = JSON.parse(m.text ?? '');
		if (o && typeof o === 'object') for (const k of CMD_KEYS) if (typeof o[k] === 'string') return o[k];
		if (Array.isArray(o?.command)) return o.command.join(' '); // Codex: ["bash", "-lc", "…"]
	} catch {
		/* not JSON */
	}
	return null;
}

const isShell = (name: string) => /bash|shell|exec|run_command|command|powershell|terminal|^run$/i.test(name) && !/^mcp_/i.test(name);

export function computeStats(msgs: Msg[]): SessionStats {
	const st = emptyStats();
	const calls = new Map<string, { name: string; time: number | null }>();

	for (const m of msgs) {
		if (m.kind === 'tool_call') {
			const name = m.name || 'tool';
			const t = (st.tools[name] ??= { n: 0, err: 0, ms: 0, timed: 0 });
			t.n++;
			if (m.id) calls.set(m.id, { name, time: m.time });
			if (isShell(name)) {
				let cmd = commandOf(m);
				// Codex wraps commands as ["bash", "-lc", "<script>"]
				const wrapped = cmd && /^(bash|sh|zsh|pwsh|powershell)(\.exe)?\s+(-lc|-c|-Command)\s+/i.exec(cmd);
				if (wrapped && cmd) cmd = cmd.slice(wrapped[0].length).replace(/^["']|["']$/g, '');
				const prog = cmd ? commandName(cmd) : null;
				if (prog) st.cmds[prog] = (st.cmds[prog] ?? 0) + 1;
			}
		} else if (m.kind === 'tool_result' && m.id) {
			const c = calls.get(m.id);
			if (!c) continue;
			const t = st.tools[c.name];
			if (m.error) t.err++;
			if (c.time && m.time && m.time >= c.time && m.time - c.time <= IDLE_MS) {
				t.ms += m.time - c.time;
				t.timed++;
			}
		} else if (m.kind === 'text' && m.role === 'user') st.prompts++;
	}

	// Active time, and when it happened
	const times = msgs.map((m) => m.time).filter((t): t is number => typeof t === 'number' && t > 0).sort((a, b) => a - b);
	st.timed = times.length >= 2;
	for (let i = 1; i < times.length; i++) {
		const gap = times[i] - times[i - 1];
		if (gap <= 0 || gap > IDLE_MS) continue;
		st.active += gap;
		const d = new Date(times[i - 1]);
		const k = String(d.getDay() * 24 + d.getHours());
		st.wh[k] = (st.wh[k] ?? 0) + gap;
		const day = dayKey(d);
		st.days[day] = (st.days[day] ?? 0) + gap;
	}

	// Response time: from each prompt to the first assistant message after it
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.kind !== 'text' || m.role !== 'user' || !m.time) continue;
		const reply = msgs.slice(i + 1).find((x) => x.role === 'assistant' && x.time);
		if (reply?.time && reply.time >= m.time && reply.time - m.time <= IDLE_MS) {
			st.resp[0] += reply.time - m.time;
			st.resp[1]++;
		}
	}
	return st;
}

/** Add `b` into `a`. Subagents run alongside their parent, so for them pass `time: false`
 *  to count their tool calls without counting the same minutes twice. */
export function mergeStats(a: SessionStats, b: SessionStats | undefined, time = true): SessionStats {
	if (!b) return a;
	for (const [k, t] of Object.entries(b.tools)) {
		const x = (a.tools[k] ??= { n: 0, err: 0, ms: 0, timed: 0 });
		x.n += t.n;
		x.err += t.err;
		x.ms += t.ms;
		x.timed += t.timed;
	}
	for (const [k, n] of Object.entries(b.cmds)) a.cmds[k] = (a.cmds[k] ?? 0) + n;
	if (!time) return a;
	for (const [k, n] of Object.entries(b.wh)) a.wh[k] = (a.wh[k] ?? 0) + n;
	for (const [k, n] of Object.entries(b.days)) a.days[k] = (a.days[k] ?? 0) + n;
	a.active += b.active;
	a.timed ||= b.timed;
	a.prompts += b.prompts;
	a.resp = [a.resp[0] + b.resp[0], a.resp[1] + b.resp[1]];
	return a;
}
