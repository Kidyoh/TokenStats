<script lang="ts">
	import { allTokens, fmt, sessionTotal } from '#lib/format.ts';
	import { assumedModel, costOf, findPrice, priceSession, pricing, usd } from '#lib/pricing.svelte.ts';
	import { addTokens, emptyTokens, TOOL_IDS, TOOLS, totalTokens, type Session, type Tokens, type Tool } from '#lib/types.ts';
	import Icon from './Icon.svelte';
	import ShareDialog from './ShareDialog.svelte';
	import type { CardData } from '#lib/sharecard.ts';
	import type { CoverageNote, HistoryEntry } from '#lib/history.ts';

	let {
		sessions,
		history = [],
		notes = [],
		rangeDays = null,
		onopen
	}: { sessions: Session[]; history?: HistoryEntry[]; notes?: CoverageNote[]; rangeDays?: number | null; onopen: (id: string) => void } = $props();

	// Estimated cost per session from models.dev list prices
	const prices = $derived(new Map(sessions.map((s) => [s.id, priceSession(s)])));
	const histPrices = $derived(history.map((h) => priceSession({ ...h, subagents: [] })));
	const unpriced = $derived([...new Set([...prices.values(), ...histPrices].flatMap((p) => p.unpriced))]);
	const grandUsd = $derived([...prices.values(), ...histPrices].reduce((a, p) => a + p.usd, 0));

	const byTool = $derived.by(() => {
		const by = new Map<Tool, { n: number; t: Tokens; usd: number; est: number; real: number; hist: number; origins: Set<string> }>();
		const get = (t: Tool) => by.get(t) ?? { n: 0, t: emptyTokens(), usd: 0, est: 0, real: 0, hist: 0, origins: new Set<string>() };
		for (const s of sessions) {
			const b = get(s.source);
			b.n++;
			if (s.estimated) b.est++;
			else if (sessionTotal(s)) b.real++;
			addTokens(b.t, allTokens(s));
			b.usd += prices.get(s.id)?.usd ?? 0;
			by.set(s.source, b);
		}
		history.forEach((h, i) => {
			const b = get(h.source);
			addTokens(b.t, h.tokens);
			b.hist += totalTokens(h.tokens);
			b.real++;
			b.origins.add(h.origin);
			b.usd += histPrices[i]?.usd ?? 0;
			by.set(h.source, b);
		});
		return TOOL_IDS.filter((k) => by.has(k)).map((k) => ({ tool: k, ...by.get(k)! }));
	});
	/** tokens recovered from the agents' own totals, whose session files are gone */
	const histTotal = $derived(history.reduce((a, h) => a + totalTokens(h.tokens), 0));
	/** periods whose usage can't be counted at all */
	const gaps = $derived(notes.filter((n) => n.kind === 'gap'));
	/** tokens counted from transcript text because the tool recorded none */
	const estTotal = $derived(sessions.reduce((a, s) => a + (s.estimated ? sessionTotal(s) : 0), 0));
	const grand = $derived(byTool.reduce((a, b) => a + totalTokens(b.t), 0));
	const grandT = $derived(byTool.reduce((a, b) => addTokens(a, b.t), emptyTokens()));
	const maxTool = $derived(Math.max(1, ...byTool.map((b) => totalTokens(b.t))));
	const top = $derived([...sessions].sort((a, b) => sessionTotal(b) - sessionTotal(a)).slice(0, 12));

	const models = $derived.by(() => {
		// Rows are per model; for a tool with a model chosen in Settings, its rows are kept apart
		// and priced at that model instead (`as`).
		const m = new Map<string, { src: Tool; name: string; n: number; t: Tokens; as: string | null }>();
		const tally = (src: Tool, models: Record<string, Tokens>) => {
			const override = assumedModel(src);
			const as = override && findPrice(override, src) ? override : null;
			for (const [name, t] of Object.entries(models)) {
				const key = as ? `${src}|${name}` : name;
				const x = m.get(key) ?? { src, name, n: 0, t: emptyTokens(), as };
				addTokens(x.t, t);
				m.set(key, x);
			}
		};
		for (const h of history) tally(h.source, h.models);
		for (const s of sessions) {
			const seen = new Set<string>();
			const override = assumedModel(s.source);
			const as = override && findPrice(override, s.source) ? override : null;
			const add = (name: string, t: Tokens) => {
				const key = as ? `${s.source}|${name}` : name;
				const x = m.get(key) ?? { src: s.source, name, n: 0, t: emptyTokens(), as };
				if (!seen.has(key)) (x.n++, seen.add(key));
				addTokens(x.t, t);
				m.set(key, x);
			};
			const named = (models: Record<string, Tokens>) => Object.values(models ?? {}).some((t) => totalTokens(t) > 0);
			// Tokens with no recorded model only have a price when a model is chosen in Settings.
			if (as && !named(s.models) && totalTokens(s.tokens)) add('no model recorded', s.tokens);
			if (as) for (const sub of s.subagents) if (!named(sub.models) && totalTokens(sub.tokens)) add('no model recorded', sub.tokens);
			for (const [name, t] of Object.entries(s.models ?? {})) add(name, t);
			if (s.source === 'claude') for (const sub of s.subagents) for (const [name, t] of Object.entries(sub.models ?? {})) add(name, t);
		}
		return [...m]
			.filter(([, x]) => totalTokens(x.t) > 0)
			.sort((a, b) => totalTokens(b[1].t) - totalTokens(a[1].t))
			.map(([key, x]) => [key, { ...x, price: findPrice(x.as ?? x.name, x.src) }] as const);
	});

	// The chart covers the chosen range; for all time, from the first session (30 days to a year).
	const DAYS = $derived.by(() => {
		if (rangeDays) return rangeDays;
		const first = Math.min(...sessions.map((s) => s.end ?? s.start ?? Date.now()), ...history.map((h) => h.from));
		return Math.max(30, Math.min(365, Math.ceil((Date.now() - first) / 864e5) + 1));
	});
	const chart = $derived.by(() => {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const start = today.getTime() - (DAYS - 1) * 864e5;
		const buckets = Array.from({ length: DAYS }, (_, i) => ({ day: start + i * 864e5, v: {} as Partial<Record<Tool, number>>, total: 0 }));
		for (const s of sessions) {
			const d = new Date(s.end ?? s.start ?? 0);
			d.setHours(0, 0, 0, 0);
			const i = Math.round((d.getTime() - start) / 864e5);
			if (i < 0 || i >= DAYS) continue;
			const v = sessionTotal(s);
			buckets[i].v[s.source] = (buckets[i].v[s.source] ?? 0) + v;
			buckets[i].total += v;
		}
		// Recovered usage: on its day, or spread evenly when only the period is known.
		for (const h of history) {
			const first = Math.round((h.from - start) / 864e5);
			const days = Math.round((h.to - h.from) / 864e5) + 1;
			const v = totalTokens(h.tokens) / days;
			for (let i = Math.max(0, first); i < Math.min(DAYS, first + days); i++) {
				buckets[i].v[h.source] = (buckets[i].v[h.source] ?? 0) + v;
				buckets[i].total += v;
			}
		}
		return { buckets, max: Math.max(1, ...buckets.map((b) => b.total)), start };
	});

	let tip = $state<{ x: number; y: number; text: string } | null>(null);

	let sharing = $state(false);
	/** Opens the share card (the button lives in the page bar). */
	export function share() {
		sharing = true;
	}
	const card = $derived.by((): CardData => {
		const active = sessions.reduce((a, s) => a + (s.stats?.active ?? 0), 0);
		const calls = sessions.reduce(
			(a, s) => a + [s.stats, ...s.subagents.map((x) => x.stats)].reduce((b, st) => b + Object.values(st?.tools ?? {}).reduce((c, t) => c + t.n, 0), 0),
			0
		);
		return {
			rangeLabel: (!rangeDays ? 'All time' : rangeDays === 365 ? 'Last 12 months' : `Last ${rangeDays} days`) + (gaps.length ? ' · incomplete' : ''),
			sessions: sessions.length,
			tokens: grand,
			cost: grandUsd,
			hours: active ? active / 3600e3 : null,
			toolCalls: calls || null,
			perTool: byTool.map((b) => ({ tool: b.tool, tokens: totalTokens(b.t), sessions: b.n })).sort((a, b) => b.tokens - a.tokens),
			days: chart.buckets.map((b) => ({ day: b.day, v: b.v })),
			models: models.map(([, x]) => ({ name: x.name, tokens: totalTokens(x.t) }))
		};
	});
</script>

<header class="top">
	<div>
		<div class="eyebrow">{sessions.length} sessions</div>
		<div class="totals">
			<div class="big">{fmt(grand)} <span>tokens</span>{#if gaps.length}<span class="partial" title="Some usage in this range couldn't be counted. See the notes below.">incomplete</span>{/if}</div>
			<div class="big cost" title="Estimated at list prices from models.dev">{usd(grandUsd)} <span>estimated</span></div>
		</div>
		<div class="split">
			{fmt(grandT.input)} in · {fmt(grandT.output)} out · {fmt(grandT.cache_read)} cache read{#if grandT.cache_write}&nbsp;· {fmt(grandT.cache_write)} cache write{/if}{#if estTotal}&nbsp;· <span title="Counted from transcript text for sessions whose tool didn't record usage">incl. ~{fmt(estTotal)} estimated</span>{/if}{#if histTotal}&nbsp;· <span title="From the agents' own running totals, for sessions whose files were deleted">incl. {fmt(histTotal)} from older records</span>{/if}
		</div>
	</div>
</header>

{#if notes.length}
	<ul class="coverage" aria-label="What these totals include">
		{#each notes as n, i (i)}
			<li class={n.kind}>
				<span class="dot {n.source}"></span>
				<span><b>{TOOLS[n.source]}</b>{n.kind === 'gap' ? ' · missing usage' : n.kind === 'missing' ? ' · no usage data' : n.kind === 'tip' ? ' · keep more history' : ''}. {n.text}</span>
			</li>
		{/each}
	</ul>
{/if}

<div class="tools">
	{#each byTool as b (b.tool)}
		<div class="tool-row">
			<span class="name"><span class="dot {b.tool}"></span>{TOOLS[b.tool]}</span>
			<span class="bar">{#if totalTokens(b.t)}<i style="width:{(totalTokens(b.t) / maxTool) * 100}%;background:var(--{b.tool})"></i>{/if}</span>
			<span class="num">{totalTokens(b.t) ? (b.est && !b.real ? '~' : '') + fmt(totalTokens(b.t)) : '—'}</span>
			<span class="usd" title={totalTokens(b.t) && !b.usd ? 'No model recorded, so no price' : undefined}>{totalTokens(b.t) ? (b.usd ? usd(b.usd) : '—') : ''}</span>
			<span class="sub"
				>{b.n} {b.n === 1 ? 'session' : 'sessions'}{!totalTokens(b.t) ? ' · no token data' : b.est && !b.real ? ' · estimated' : b.est ? ` · ${b.est} estimated` : ''}{#if b.hist}<span title="Recovered from {[...b.origins].join(', ')}"
						>&nbsp;· +{fmt(b.hist)} older</span
					>{/if}</span
			>
		</div>
	{/each}
</div>

<h3 class="section-title">{rangeDays === 365 ? 'Last 12 months' : `Last ${DAYS} days`}</h3>
<div class="chart">
	<div class="bars" role="img" aria-label="Tokens per day by tool" style:gap={DAYS > 120 ? '0px' : DAYS > 60 ? '1px' : '3px'}>
		{#each chart.buckets as b (b.day)}
			<div
				class="col"
				role="presentation"
				onmousemove={(e) =>
					(tip = {
						x: e.clientX,
						y: e.clientY,
						text: [new Date(b.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), ...TOOL_IDS.filter((k) => b.v[k]).map((k) => `${TOOLS[k]}  ${fmt(b.v[k]!)}`)].join('\n') || ''
					})}
				onmouseleave={() => (tip = null)}
			>
				{#each TOOL_IDS as k (k)}
					{#if b.v[k]}<i style="height:{(b.v[k]! / chart.max) * 100}%;background:var(--{k})"></i>{/if}
				{/each}
			</div>
		{/each}
	</div>
	<div class="axis">
		<span>{new Date(chart.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
		<span>peak {fmt(chart.max)} / day</span>
		<span>Today</span>
	</div>
</div>

<h3 class="section-title">Largest sessions</h3>
<div class="table-wrap">
	<table class="table">
		<thead><tr><th>Session</th><th>Date</th><th>In</th><th>Out</th><th>Cached</th><th>Total</th><th>Cost</th></tr></thead>
		<tbody>
			{#each top as s (s.id)}
				{@const t = allTokens(s)}
				<tr class="click" onclick={() => onopen(s.id)}>
					<td class="ttl"><span class="dot {s.source}"></span>&nbsp; {s.title}</td>
					<td class="muted">{s.end ? new Date(s.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</td>
					<td>{fmt(t.input + t.cache_write)}</td>
					<td>{fmt(t.output)}</td>
					<td>{fmt(t.cache_read)}</td>
					<td><b>{s.estimated ? '~' : ''}{fmt(totalTokens(t))}</b></td>
					<td>{usd(prices.get(s.id)?.usd ?? 0)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

{#if models.length}
	<h3 class="section-title">Models</h3>
	<div class="table-wrap">
		<table class="table">
			<thead><tr><th>Model</th><th>Sessions</th><th>In</th><th>Out</th><th>Cached</th><th>Total</th><th>Cost</th></tr></thead>
			<tbody>
				{#each models as [key, x] (key)}
					<tr>
						<td><span class="dot {x.src}"></span>&nbsp; {x.name}{#if x.as}&nbsp;<span class="muted" title="{TOOLS[x.src]} sessions are priced at the model chosen in Settings">· {TOOLS[x.src]}, priced as {x.as.split('/').pop()}</span>{/if}</td>
						<td class="muted">{x.n || '—'}</td>
						<td>{fmt(x.t.input + x.t.cache_write)}</td>
						<td>{fmt(x.t.output)}</td>
						<td>{fmt(x.t.cache_read)}</td>
						<td><b>{fmt(totalTokens(x.t))}</b></td>
						<td title={x.price ? `${x.price.provider}/${x.price.id}: $${x.price.input} in · $${x.price.output} out per 1M` : 'No price on models.dev'}>{x.price ? usd(costOf(x.t, x.price, x.src)) : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<p class="pricing-note">
	Costs are estimates at public list prices from <a href="https://models.dev" target="_blank" rel="noopener noreferrer">models.dev</a>{pricing.updated ? ` (${pricing.live ? 'fetched' : 'bundled'} ${pricing.updated})` : ''}.
	Subscriptions, free tiers, discounts and long-context surcharges aren't reflected.
	{#if unpriced.length}No price found for {unpriced.slice(0, 6).join(', ')}{unpriced.length > 6 ? ` and ${unpriced.length - 6} more` : ''}.{/if}
</p>

{#if sharing}
	<ShareDialog data={card} onclose={() => (sharing = false)} />
{/if}

{#if tip?.text}
	<div class="tip" style="left:{Math.min(tip.x + 14, innerWidth - 190)}px;top:{tip.y + 14}px">{tip.text}</div>
{/if}

<style>
	.top {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
	}
	.eyebrow {
		color: var(--muted);
		font-size: 13px;
	}
	.big {
		font-size: 40px;
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1.1;
		margin: 4px 0;
		font-variant-numeric: tabular-nums;
	}
	.totals {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 36px;
		align-items: baseline;
	}
	.cost {
		color: var(--ink-2);
	}
	.usd {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--ink-2);
	}
	.partial {
		margin-left: 10px;
		font-size: 12px !important;
		font-weight: 600 !important;
		color: var(--warn) !important;
		border: 1px solid currentColor;
		border-radius: 999px;
		padding: 1px 8px;
		vertical-align: middle;
	}
	.coverage {
		list-style: none;
		margin: 16px 0 0;
		padding: 0;
		display: grid;
		gap: 6px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--muted);
	}
	.coverage li {
		display: flex;
		gap: 8px;
		align-items: baseline;
		padding: 8px 10px;
		border-radius: var(--r-sm);
		background: var(--surface-2);
	}
	.coverage li.gap,
	.coverage li.missing {
		color: var(--ink-2);
	}
	.coverage b {
		color: var(--ink);
		font-weight: 600;
	}
	.pricing-note {
		margin: 28px 0 0;
		font-size: 12px;
		color: var(--faint);
		line-height: 1.6;
	}
	.big span {
		font-size: 18px;
		color: var(--muted);
		font-weight: 500;
		letter-spacing: 0;
	}
	.split {
		color: var(--muted);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
	}
	.tools {
		margin-top: 28px;
		display: grid;
		gap: 10px;
	}
	.tool-row {
		display: grid;
		grid-template-columns: 120px minmax(0, 1fr) 60px 72px 170px;
		align-items: center;
		gap: 14px;
		font-size: 13px;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 500;
	}
	.bar {
		height: 6px;
		background: var(--surface-2);
		border-radius: 999px;
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		border-radius: 999px;
		min-width: 2px;
	}
	.num {
		text-align: right;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.sub {
		color: var(--muted);
		font-size: 12.5px;
	}
	.chart {
		padding-top: 4px;
	}
	.bars {
		display: flex;
		align-items: flex-end;
		gap: 3px;
		height: 140px;
	}
	.col {
		flex: 1;
		height: 100%;
		display: flex;
		flex-direction: column-reverse;
		gap: 1px;
		min-width: 0;
		border-radius: 2px;
	}
	.col i {
		display: block;
		border-radius: 2px;
	}
	.col:hover {
		background: var(--surface-2);
	}
	.axis {
		display: flex;
		justify-content: space-between;
		color: var(--faint);
		font-size: 11.5px;
		padding-top: 8px;
		border-top: 1px solid var(--line-soft);
		margin-top: 2px;
	}
	.tip {
		position: fixed;
		pointer-events: none;
		background: var(--ink);
		color: var(--bg);
		padding: 7px 10px;
		border-radius: var(--r-sm);
		font-size: 12px;
		z-index: 9;
		white-space: pre;
		box-shadow: var(--shadow-lg);
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 720px) {
		.tool-row {
			grid-template-columns: 100px minmax(0, 1fr) 52px 60px;
		}
		.sub {
			display: none;
		}
		.big {
			font-size: 32px;
		}
	}
</style>
