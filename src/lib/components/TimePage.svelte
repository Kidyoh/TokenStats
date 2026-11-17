<script lang="ts">
	import { dur, folder, num } from '#lib/format.ts';
	import { dayKey } from '#lib/stats.ts';
	import { TOOL_IDS, TOOLS, type Session, type Tool } from '#lib/types.ts';

	let { sessions, onopen }: { sessions: Session[]; onopen: (id: string) => void } = $props();

	const H = 3600e3;
	const timed = $derived(sessions.filter((s) => s.stats?.timed && s.stats.active > 0));
	const untimed = $derived(sessions.length - timed.length);
	const noTimes = $derived(TOOL_IDS.filter((t) => sessions.some((s) => s.source === t) && !timed.some((s) => s.source === t)));

	const data = $derived.by(() => {
		let active = 0;
		let respMs = 0;
		let respN = 0;
		let prompts = 0;
		const wh = new Array(168).fill(0);
		const days = new Map<string, Partial<Record<Tool, number>>>();
		const byTool = new Map<Tool, number>();
		const byProject = new Map<string, { ms: number; n: number }>();
		for (const s of timed) {
			const st = s.stats!;
			active += st.active;
			respMs += st.resp[0];
			respN += st.resp[1];
			prompts += st.prompts;
			for (const [k, v] of Object.entries(st.wh)) wh[+k] += v;
			for (const [d, v] of Object.entries(st.days)) {
				const x = days.get(d) ?? {};
				x[s.source] = (x[s.source] ?? 0) + v;
				days.set(d, x);
			}
			byTool.set(s.source, (byTool.get(s.source) ?? 0) + st.active);
			const p = folder(s.cwd) || '(no folder)';
			const x = byProject.get(p) ?? { ms: 0, n: 0 };
			x.ms += st.active;
			x.n++;
			byProject.set(p, x);
		}
		const dayTotal = (x: Partial<Record<Tool, number>>) => Object.values(x).reduce((a, v) => a + (v ?? 0), 0);
		const dayList = [...days].map(([d, v]) => ({ d, v, total: dayTotal(v) })).sort((a, b) => a.d.localeCompare(b.d));

		// Longest run of consecutive active days, and the current one
		let best = 0;
		let run = 0;
		let prev: number | null = null;
		for (const { d } of dayList) {
			const t = new Date(d + 'T00:00:00').getTime();
			run = prev != null && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1;
			best = Math.max(best, run);
			prev = t;
		}
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const set = new Set(dayList.map((x) => x.d));
		// Count back from today, or from yesterday when nothing has happened yet today.
		let current = 0;
		let t = new Date(today);
		if (!set.has(dayKey(t))) t.setDate(t.getDate() - 1);
		while (set.has(dayKey(t))) {
			current++;
			t.setDate(t.getDate() - 1);
		}

		return {
			active,
			resp: respN ? respMs / respN : 0,
			prompts,
			wh,
			whMax: Math.max(1, ...wh),
			dayList,
			byTool: TOOL_IDS.filter((t) => byTool.get(t)).map((t) => ({ t, ms: byTool.get(t)! })),
			byProject: [...byProject].sort((a, b) => b[1].ms - a[1].ms),
			best,
			current,
			longest: [...timed].sort((a, b) => b.stats!.active - a.stats!.active).slice(0, 10),
			busiest: [...dayList].sort((a, b) => b.total - a.total).slice(0, 7)
		};
	});

	// Daily chart: from the first active day to today, at most a year
	const chart = $derived.by(() => {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const first = data.dayList[0] ? new Date(data.dayList[0].d + 'T00:00:00').getTime() : today.getTime();
		const n = Math.max(14, Math.min(365, Math.round((today.getTime() - first) / 864e5) + 1));
		const map = new Map(data.dayList.map((x) => [x.d, x]));
		const cols = Array.from({ length: n }, (_, i) => {
			const day = new Date(today.getTime() - (n - 1 - i) * 864e5);
			return { day: day.getTime(), x: map.get(dayKey(day)) };
		});
		return { cols, max: Math.max(1, ...cols.map((c) => c.x?.total ?? 0)), n };
	});

	const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	// Monday first
	const ORDER = [1, 2, 3, 4, 5, 6, 0];
	const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);
	const peak = $derived.by(() => {
		const i = data.wh.indexOf(Math.max(...data.wh));
		return { day: WEEKDAYS[Math.floor(i / 24)], hour: i % 24 };
	});
	const byHour = $derived(Array.from({ length: 24 }, (_, h) => ORDER.reduce((a, d) => a + data.wh[d * 24 + h], 0)));
	const byDay = $derived(ORDER.map((d) => ({ d, ms: data.wh.slice(d * 24, d * 24 + 24).reduce((a, v) => a + v, 0) })));
	const maxHour = $derived(Math.max(1, ...byHour));
	const maxDay = $derived(Math.max(1, ...byDay.map((x) => x.ms)));
	const maxProject = $derived(Math.max(1, ...data.byProject.map((p) => p[1].ms)));
	const short = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	const longDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
	const hours = (ms: number) => (ms >= 10 * H ? Math.round(ms / H).toLocaleString() : (ms / H).toFixed(1));
</script>

{#if !timed.length}
	<div class="empty">
		{#if sessions.some((s) => !s.stats)}
			Time statistics are worked out when sessions are read. <b>Sync</b> to read them.
		{:else}
			None of these sessions recorded message times.
		{/if}
	</div>
{:else}
	<header>
		<div class="eyebrow">{num(timed.length)} sessions with times</div>
		<div class="totals">
			<div class="big">{hours(data.active)} <span>hours active</span></div>
			<div class="big soft">{num(data.dayList.length)} <span>active days</span></div>
		</div>
		<div class="split">
			{dur(data.active / timed.length)} per session · {dur(data.active / Math.max(1, data.dayList.length))} per active day{#if data.resp}&nbsp;· first reply in {dur(data.resp)} on average{/if}
		</div>
	</header>

	<div class="cards">
		<div class="card"><span class="k">Longest streak</span><b>{data.best} {data.best === 1 ? 'day' : 'days'}</b></div>
		<div class="card"><span class="k">Current streak</span><b>{data.current} {data.current === 1 ? 'day' : 'days'}</b></div>
		<div class="card"><span class="k">Busiest hour</span><b>{peak.day} {hourLabel(peak.hour)}</b></div>
		<div class="card"><span class="k">Prompts</span><b>{num(data.prompts)}</b></div>
	</div>

	<h3 class="section-title">Active time per day</h3>
	<div class="chart">
		<div class="bars" style:gap={chart.n > 120 ? '0px' : chart.n > 60 ? '1px' : '3px'}>
			{#each chart.cols as c (c.day)}
				<div class="col" title="{short(c.day)}: {c.x ? dur(c.x.total) : 'no activity'}">
					{#if c.x}
						{#each TOOL_IDS as t (t)}
							{#if c.x.v[t]}<i style="height:{(c.x.v[t]! / chart.max) * 100}%;background:var(--{t})"></i>{/if}
						{/each}
					{/if}
				</div>
			{/each}
		</div>
		<div class="axis">
			<span>{short(chart.cols[0].day)}</span>
			<span>peak {dur(chart.max)} / day</span>
			<span>Today</span>
		</div>
	</div>

	<h3 class="section-title">When you work</h3>
	<div class="heat-wrap">
		<div class="heat" role="img" aria-label="Active time by weekday and hour">
			<span></span>
			{#each Array(24) as _, h (h)}<span class="hl">{h % 3 === 0 ? hourLabel(h) : ''}</span>{/each}
			{#each ORDER as d (d)}
				<span class="dl">{WEEKDAYS[d]}</span>
				{#each Array(24) as _, h (h)}
					{@const v = data.wh[d * 24 + h]}
					<i style="--a:{v ? 0.12 + 0.88 * Math.sqrt(v / data.whMax) : 0}" title="{WEEKDAYS[d]} {hourLabel(h)}: {dur(v)}"></i>
				{/each}
			{/each}
		</div>
	</div>
	<div class="dist">
		<div>
			<div class="dist-t">By hour</div>
			<div class="mini">
				{#each byHour as v, h (h)}<i style="height:{(v / maxHour) * 100}%" title="{hourLabel(h)}: {dur(v)}"></i>{/each}
			</div>
			<div class="axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
		</div>
		<div>
			<div class="dist-t">By weekday</div>
			<ul class="wd">
				{#each byDay as x (x.d)}
					<li><span>{WEEKDAYS[x.d]}</span><span class="cell-bar"><i style="width:{(x.ms / maxDay) * 100}%"></i></span><span class="n">{dur(x.ms)}</span></li>
				{/each}
			</ul>
		</div>
	</div>

	<div class="cols">
		<section>
			<h3 class="section-title">By project</h3>
			<ul class="wd">
				{#each data.byProject.slice(0, 12) as [p, x] (p)}
					<li class="proj"><span class="pn" title={p}>{p}</span><span class="cell-bar"><i style="width:{(x.ms / maxProject) * 100}%"></i></span><span class="n">{dur(x.ms)}</span></li>
				{/each}
			</ul>
		</section>
		<section>
			<h3 class="section-title">By tool</h3>
			<ul class="wd">
				{#each data.byTool as x (x.t)}
					<li class="proj">
						<span class="pn"><span class="dot {x.t}"></span>&nbsp; {TOOLS[x.t]}</span>
						<span class="cell-bar"><i style="width:{(x.ms / data.active) * 100}%;background:var(--{x.t})"></i></span>
						<span class="n">{dur(x.ms)}</span>
					</li>
				{/each}
			</ul>
			<h3 class="section-title">Busiest days</h3>
			<ul class="wd">
				{#each data.busiest as x (x.d)}
					<li class="proj"><span class="pn">{longDay(x.d)}</span><span></span><span class="n">{dur(x.total)}</span></li>
				{/each}
			</ul>
		</section>
	</div>

	<h3 class="section-title">Longest sessions by active time</h3>
	<div class="table-wrap">
		<table class="table">
			<thead><tr><th>Session</th><th>Date</th><th>Prompts</th><th>Active</th><th>Start to end</th></tr></thead>
			<tbody>
				{#each data.longest as s (s.id)}
					<tr class="click" onclick={() => onopen(s.id)}>
						<td class="ttl"><span class="dot {s.source}"></span>&nbsp; {s.title}</td>
						<td class="muted">{s.start ? short(s.start) : ''}</td>
						<td>{num(s.stats!.prompts)}</td>
						<td><b>{dur(s.stats!.active)}</b></td>
						<td class="muted">{s.start && s.end ? dur(s.end - s.start) : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<p class="note">
		Active time adds up the gaps between messages and leaves out breaks longer than 30 minutes, so a session left open overnight counts only the time you were working.
		{#if untimed}{num(untimed)} {untimed === 1 ? 'session has' : 'sessions have'} no message times{noTimes.length ? ` (${noTimes.map((t) => TOOLS[t]).join(', ')} doesn't record them)` : ''} and {untimed === 1 ? 'isn’t' : 'aren’t'} counted.{/if}
	</p>
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
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
		margin-top: 24px;
	}
	.card {
		border: 1px solid var(--line);
		border-radius: var(--r);
		padding: 12px 14px;
		display: grid;
		gap: 4px;
	}
	.card .k {
		color: var(--muted);
		font-size: 12px;
	}
	.card b {
		font-size: 18px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.bars {
		display: flex;
		align-items: flex-end;
		height: 140px;
	}
	.col {
		flex: 1;
		height: 100%;
		display: flex;
		flex-direction: column-reverse;
		gap: 1px;
		min-width: 0;
	}
	.col i {
		display: block;
		border-radius: 2px;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		color: var(--faint);
		font-size: 11.5px;
		margin-top: 6px;
	}
	.heat-wrap {
		overflow-x: auto;
	}
	.heat {
		display: grid;
		grid-template-columns: 34px repeat(24, minmax(14px, 1fr));
		gap: 3px;
		min-width: 460px;
	}
	.heat i {
		aspect-ratio: 1;
		border-radius: 3px;
		background: color-mix(in srgb, var(--ok) calc(var(--a) * 100%), var(--surface-2));
	}
	.hl,
	.dl {
		font-size: 10.5px;
		color: var(--faint);
		align-self: center;
	}
	.dl {
		font-size: 11.5px;
	}
	.dist {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 16px 32px;
		margin-top: 24px;
	}
	.dist-t {
		font-size: 12px;
		color: var(--muted);
		margin-bottom: 8px;
	}
	.mini {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 72px;
	}
	.mini i {
		flex: 1;
		background: var(--ok);
		opacity: 0.75;
		border-radius: 2px 2px 0 0;
		min-height: 1px;
	}
	.wd {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.wd li {
		display: grid;
		grid-template-columns: 36px minmax(40px, 1fr) 64px;
		gap: 10px;
		align-items: center;
		font-size: 12.5px;
	}
	.wd li.proj {
		grid-template-columns: minmax(80px, 160px) minmax(40px, 1fr) 64px;
	}
	.pn {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cell-bar {
		height: 6px;
		border-radius: 3px;
		background: var(--surface-2);
		overflow: hidden;
	}
	.cell-bar i {
		display: block;
		height: 100%;
		border-radius: 3px;
		background: var(--ok);
	}
	.n {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--ink-2);
	}
	.cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 0 32px;
	}
	.table-wrap {
		overflow-x: auto;
	}
	.note {
		margin: 32px 0 0;
		color: var(--faint);
		font-size: 12px;
		line-height: 1.5;
	}
</style>
