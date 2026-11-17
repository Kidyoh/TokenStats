<script lang="ts">
	import { dur, fmt, num } from '#lib/format.ts';
	import { emptyStats, mergeStats, type ToolStat } from '#lib/stats.ts';
	import { categorize, CATEGORY_ICON, humanize, type ToolCategory } from '#lib/toolinfo.ts';
	import { TOOL_IDS, TOOLS, type Session, type Tool } from '#lib/types.ts';
	import Icon from './Icon.svelte';

	let { sessions }: { sessions: Session[] } = $props();

	const CATS: { id: ToolCategory; label: string }[] = [
		{ id: 'shell', label: 'Shell' },
		{ id: 'edit', label: 'Edit' },
		{ id: 'read', label: 'Read' },
		{ id: 'search', label: 'Search' },
		{ id: 'web', label: 'Web' },
		{ id: 'agent', label: 'Agents' },
		{ id: 'plan', label: 'Planning' },
		{ id: 'mcp', label: 'MCP' },
		{ id: 'other', label: 'Other' }
	];
	const CAT_COLOR: Record<ToolCategory, string> = {
		shell: 'var(--claude)',
		edit: 'var(--codex)',
		read: 'var(--opencode)',
		search: 'var(--grok)',
		web: 'var(--antigravity)',
		agent: 'var(--cursor)',
		plan: 'var(--ink-2)',
		mcp: 'var(--muted)',
		other: 'var(--faint)'
	};

	type Row = ToolStat & { name: string; label: string; server?: string; cat: ToolCategory; sessions: number; apps: Set<Tool> };

	const withStats = $derived(sessions.filter((s) => s.stats));
	const missing = $derived(sessions.length - withStats.length);

	const data = $derived.by(() => {
		const rows = new Map<string, Row>();
		const cmds: Record<string, number> = {};
		for (const s of withStats) {
			// The session's own calls plus its subagents' (their time isn't counted twice here: only calls).
			const st = mergeStats(emptyStats(), s.stats);
			for (const sub of s.subagents) mergeStats(st, sub.stats, false);
			for (const [name, t] of Object.entries(st.tools)) {
				let r = rows.get(name);
				if (!r) {
					const h = humanize(name);
					r = { name, label: h.label, server: h.server, cat: categorize(name), n: 0, err: 0, ms: 0, timed: 0, sessions: 0, apps: new Set() };
					rows.set(name, r);
				}
				r.n += t.n;
				r.err += t.err;
				r.ms += t.ms;
				r.timed += t.timed;
				r.sessions++;
				r.apps.add(s.source);
			}
			for (const [k, n] of Object.entries(st.cmds)) cmds[k] = (cmds[k] ?? 0) + n;
		}
		const list = [...rows.values()];
		const calls = list.reduce((a, r) => a + r.n, 0);
		const errors = list.reduce((a, r) => a + r.err, 0);
		const byCat = CATS.map((c) => ({ ...c, n: list.filter((r) => r.cat === c.id).reduce((a, r) => a + r.n, 0) })).filter((c) => c.n);
		const servers = new Map<string, { calls: number; tools: number }>();
		for (const r of list)
			if (r.server) {
				const x = servers.get(r.server) ?? { calls: 0, tools: 0 };
				x.calls += r.n;
				x.tools++;
				servers.set(r.server, x);
			}
		const sessionsUsing = withStats.filter((s) => Object.keys(s.stats!.tools).length || s.subagents.some((x) => x.stats && Object.keys(x.stats.tools).length)).length;
		return {
			list,
			calls,
			errors,
			byCat,
			sessionsUsing,
			cmds: Object.entries(cmds).sort((a, b) => b[1] - a[1]),
			servers: [...servers].sort((a, b) => b[1].calls - a[1].calls)
		};
	});

	let q = $state('');
	let cat = $state<ToolCategory | null>(null);
	let sort = $state<'n' | 'sessions' | 'err' | 'avg'>('n');
	let limit = $state(60);
	let cmdLimit = $state(20);

	const avg = (r: ToolStat) => (r.timed ? r.ms / r.timed : 0);
	const shown = $derived.by(() => {
		const ql = q.trim().toLowerCase();
		const key: Record<typeof sort, (r: Row) => number> = { n: (r) => r.n, sessions: (r) => r.sessions, err: (r) => r.err / r.n, avg };
		return data.list
			.filter((r) => (!cat || r.cat === cat) && (!ql || `${r.name} ${r.label} ${r.server ?? ''}`.toLowerCase().includes(ql)))
			.sort((a, b) => key[sort](b) - key[sort](a) || b.n - a.n);
	});
	const maxN = $derived(Math.max(1, ...shown.map((r) => r.n)));
	const maxCmd = $derived(Math.max(1, ...data.cmds.map((c) => c[1])));
	const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
	const rate = (a: number, b: number) => {
		const p = pct(a, b);
		return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p < 10 ? p.toFixed(1) + '%' : Math.round(p) + '%';
	};
</script>

{#if !data.calls}
	<div class="empty">
		{#if missing && !withStats.length}
			Tool statistics are worked out when sessions are read. <b>Sync</b> to read them.
		{:else}
			No tool calls in these sessions.
		{/if}
	</div>
{:else}
	<header class="top">
		<div class="eyebrow">{num(data.sessionsUsing)} sessions used tools</div>
		<div class="totals">
			<div class="big">{fmt(data.calls)} <span>tool calls</span></div>
			<div class="big soft">{num(data.list.length)} <span>different tools</span></div>
		</div>
		<div class="split">
			{rate(data.errors, data.calls)} failed · {(data.calls / Math.max(1, data.sessionsUsing)).toFixed(1)} calls per session{#if data.cmds.length}&nbsp;· {num(data.cmds.length)} shell programs{/if}{#if missing}&nbsp;· {missing} sessions not read yet, <b>Sync</b> to include them{/if}
		</div>
	</header>

	<h3 class="section-title">By kind</h3>
	<div class="stack" role="img" aria-label="Tool calls by kind">
		{#each data.byCat as c (c.id)}
			<i style="width:{pct(c.n, data.calls)}%;background:{CAT_COLOR[c.id]}" title="{c.label}: {num(c.n)} calls"></i>
		{/each}
	</div>
	<div class="legend">
		{#each data.byCat as c (c.id)}
			<button class="lg" class:on={cat === c.id} class:dim={cat && cat !== c.id} onclick={() => (cat = cat === c.id ? null : c.id)}>
				<span class="sw" style="background:{CAT_COLOR[c.id]}"></span>
				<Icon name={CATEGORY_ICON[c.id]} size={13} />
				{c.label}
				<b>{fmt(c.n)}</b>
				<span class="muted">{rate(c.n, data.calls)}</span>
			</button>
		{/each}
	</div>

	<h3 class="section-title">All tools</h3>
	<div class="filters">
		<label class="search">
			<Icon name="search" size={14} />
			<input bind:value={q} placeholder="Filter tools…" aria-label="Filter tools" autocomplete="off" />
		</label>
		{#if cat}<button class="chip on" onclick={() => (cat = null)}>{CATS.find((c) => c.id === cat)?.label} <Icon name="x" size={12} /></button>{/if}
		<select bind:value={sort} aria-label="Sort tools">
			<option value="n">Most calls</option>
			<option value="sessions">Most sessions</option>
			<option value="err">Highest failure rate</option>
			<option value="avg">Slowest</option>
		</select>
	</div>
	<div class="table-wrap">
		<table class="table">
			<thead>
				<tr><th>Tool</th><th class="barcol">Calls</th><th>Sessions</th><th>Used in</th><th>Failed</th><th>Avg time</th></tr>
			</thead>
			<tbody>
				{#each shown.slice(0, limit) as r (r.name)}
					<tr>
						<td title={r.name}>
							<div class="tool">
								<span class="ico"><Icon name={CATEGORY_ICON[r.cat]} size={13} /></span>
								<span class="lbl">{r.label}</span>
								{#if r.server}<span class="server">{r.server}</span>{/if}
							</div>
						</td>
						<td class="barcol">
							<div class="barcell">
								<span class="cell-bar"><i style="width:{pct(r.n, maxN)}%;background:{CAT_COLOR[r.cat]}"></i></span>
								<b>{num(r.n)}</b>
							</div>
						</td>
						<td>{num(r.sessions)}</td>
						<td><div class="apps">{#each TOOL_IDS.filter((t) => r.apps.has(t)) as t (t)}<span class="dot {t}" title={TOOLS[t]}></span>{/each}</div></td>
						<td class:bad={r.err / r.n > 0.1}>{r.err ? rate(r.err, r.n) : '—'}</td>
						<td class="muted">{r.timed ? dur(avg(r)) : '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="muted">No tools match.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if shown.length > limit}
		<button class="btn ghost more" onclick={() => (limit += 200)}>Show {Math.min(200, shown.length - limit)} more of {shown.length - limit}</button>
	{/if}

	<div class="cols">
		{#if data.cmds.length}
			<section>
				<h3 class="section-title">Shell commands</h3>
				<ol class="ranks">
					{#each data.cmds.slice(0, cmdLimit) as [c, n], i (c)}
						<li>
							<span class="rk">{i + 1}</span>
							<code>{c}</code>
							<span class="cell-bar"><i style="width:{pct(n, maxCmd)}%;background:var(--claude)"></i></span>
							<span class="n">{num(n)}</span>
						</li>
					{/each}
				</ol>
				{#if data.cmds.length > cmdLimit}<button class="btn ghost more" onclick={() => (cmdLimit += 50)}>Show more</button>{/if}
			</section>
		{/if}
		{#if data.servers.length}
			<section>
				<h3 class="section-title">MCP servers</h3>
				<ol class="ranks">
					{#each data.servers as [name, x], i (name)}
						<li>
							<span class="rk">{i + 1}</span>
							<code>{name}</code>
							<span class="muted small">{x.tools} {x.tools === 1 ? 'tool' : 'tools'}</span>
							<span class="n">{num(x.calls)}</span>
						</li>
					{/each}
				</ol>
			</section>
		{/if}
	</div>
	<p class="note">Times are from each call to its result, where the tool recorded both. Cursor doesn't record tool output, so its calls show no failures or times.</p>
{/if}

<style>
	.eyebrow {
		color: var(--muted);
		font-size: 13px;
	}
	.totals {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 36px;
		align-items: baseline;
	}
	.big {
		font-size: 40px;
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1.1;
		margin: 4px 0;
		font-variant-numeric: tabular-nums;
	}
	.big span {
		font-size: 15px;
		font-weight: 500;
		color: var(--muted);
		letter-spacing: 0;
	}
	.big.soft {
		color: var(--ink-2);
	}
	.split {
		color: var(--muted);
		font-size: 13px;
	}
	.stack {
		display: flex;
		height: 14px;
		border-radius: 7px;
		overflow: hidden;
		gap: 2px;
	}
	.stack i {
		display: block;
		min-width: 3px;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 12px;
	}
	.lg {
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border: 1px solid var(--line);
		border-radius: 999px;
		font-size: 12.5px;
		cursor: pointer;
		color: var(--ink-2);
	}
	.lg b {
		color: var(--ink);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.lg.on {
		border-color: var(--ink);
	}
	.lg.dim {
		opacity: 0.5;
	}
	.lg:focus-visible {
		outline: 2px solid var(--focus);
	}
	.sw {
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}
	.filters {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-bottom: 8px;
		flex-wrap: wrap;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 180px;
		height: 32px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		color: var(--faint);
	}
	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--ink);
		font-size: 13px;
	}
	.search:focus-within {
		border-color: var(--ink-2);
	}
	select {
		height: 32px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		font-size: 13px;
	}
	.chip {
		all: unset;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		border-radius: 999px;
		background: var(--surface-2);
		font-size: 12.5px;
		cursor: pointer;
	}
	.table-wrap {
		overflow-x: auto;
	}
	.tool {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 320px;
	}
	.lbl {
		overflow: hidden;
		text-overflow: ellipsis;
		font-weight: 500;
	}
	.ico {
		width: 22px;
		height: 22px;
		border-radius: 6px;
		display: grid;
		place-items: center;
		background: var(--surface-2);
		color: var(--ink-2);
		flex: none;
	}
	.server {
		font-size: 11px;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0 6px;
		flex: none;
	}
	.table .barcol {
		width: 34%;
	}
	.barcell {
		display: flex;
		align-items: center;
		gap: 10px;
		justify-content: flex-end;
	}
	.cell-bar {
		flex: 1;
		height: 6px;
		border-radius: 3px;
		background: var(--surface-2);
		overflow: hidden;
		min-width: 40px;
	}
	.cell-bar i {
		display: block;
		height: 100%;
		border-radius: 3px;
	}
	.apps {
		display: flex;
		gap: 4px;
		justify-content: flex-end;
	}
	td.bad {
		color: var(--danger);
	}
	.more {
		margin-top: 8px;
	}
	.cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 0 32px;
	}
	.ranks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.ranks li {
		display: grid;
		grid-template-columns: 22px minmax(0, max-content) minmax(40px, 1fr) auto;
		gap: 10px;
		align-items: center;
		font-size: 13px;
		padding: 4px 0;
	}
	.rk {
		color: var(--faint);
		font-variant-numeric: tabular-nums;
		font-size: 12px;
	}
	.ranks code {
		font-family: var(--mono);
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.n {
		font-variant-numeric: tabular-nums;
		font-weight: 550;
	}
	.small {
		font-size: 12px;
	}
	.note {
		margin: 32px 0 0;
		color: var(--faint);
		font-size: 12px;
	}
</style>
