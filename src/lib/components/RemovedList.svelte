<script lang="ts">
	import type { RedactedItem } from '#lib/redact.ts';
	import Icon from './Icon.svelte';

	let { items, onjump, onclose }: { items: RedactedItem[]; onjump: (msg: number) => void; onclose: () => void } = $props();

	interface Group {
		key: string;
		type: string;
		original: string;
		msgs: number[];
	}

	// Same value removed in several places = one row with a count.
	const groups = $derived.by(() => {
		const map = new Map<string, Group>();
		for (const it of items) {
			const key = it.type + '\u0000' + it.original;
			const g = map.get(key) ?? { key, type: it.type, original: it.original, msgs: [] };
			if (!g.msgs.includes(it.msg)) g.msgs.push(it.msg);
			map.set(key, g);
		}
		return [...map.values()];
	});
	const types = $derived.by(() => {
		const c = new Map<string, number>();
		for (const g of groups) c.set(g.type, (c.get(g.type) ?? 0) + 1);
		return [...c].sort((a, b) => b[1] - a[1]);
	});

	let filter = $state<string | null>(null);
	let revealAll = $state(false);
	let revealed = $state(new Set<string>());
	let cursor = $state<Record<string, number>>({});
	const LIMIT = 200;
	let limit = $state(LIMIT);

	const shown = $derived(filter ? groups.filter((g) => g.type === filter) : groups);

	const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
	function mask(s: string) {
		const t = oneLine(s);
		if (t.length <= 4) return '•'.repeat(Math.max(t.length, 3));
		return t.slice(0, 4) + '•'.repeat(Math.min(14, t.length - 4)) + (t.length > 24 ? `  ${t.length} chars` : '');
	}
	const full = (s: string) => {
		const t = oneLine(s);
		return t.length > 400 ? t.slice(0, 400) + '…' : t;
	};

	function toggleReveal(key: string) {
		const n = new Set(revealed);
		n.has(key) ? n.delete(key) : n.add(key);
		revealed = n;
	}

	function goto(g: Group) {
		const i = cursor[g.key] ?? 0;
		onjump(g.msgs[i % g.msgs.length]);
		cursor[g.key] = i + 1;
	}
</script>

<section class="removed" aria-label="Removed sensitive items">
	<header>
		<div class="title">
			<Icon name="shield" size={15} />
			<b>Removed from this session</b>
			<span class="muted">{items.length} {items.length === 1 ? 'item' : 'items'}{groups.length !== items.length ? ` · ${groups.length} unique` : ''}</span>
		</div>
		<div class="tools">
			<label class="switch"><input type="checkbox" bind:checked={revealAll} /> Show values</label>
			<button class="btn ghost icon" aria-label="Close list" onclick={onclose}><Icon name="x" size={15} /></button>
		</div>
	</header>

	{#if types.length > 1}
		<div class="types" role="group" aria-label="Filter by type">
			<button class:on={!filter} onclick={() => (filter = null)}>All <span>{groups.length}</span></button>
			{#each types as [t, n] (t)}
				<button class:on={filter === t} onclick={() => (filter = filter === t ? null : t)}>{t} <span>{n}</span></button>
			{/each}
		</div>
	{/if}

	<p class="note">Values stay on this device and only appear here. Exports with this option on never include them.</p>

	<ul>
		{#each shown.slice(0, limit) as g (g.key)}
			{@const open = revealAll || revealed.has(g.key)}
			<li>
				<span class="type">{g.type}</span>
				<span class="value mono" class:masked={!open} title={open ? oneLine(g.original).slice(0, 2000) : ''}>{open ? full(g.original) : mask(g.original)}</span>
				{#if g.msgs.length > 1}<span class="count" title="Appears in {g.msgs.length} places">×{g.msgs.length}</span>{/if}
				<span class="acts">
					{#if !revealAll}
						<button class="link" onclick={() => toggleReveal(g.key)}>{open ? 'Hide' : 'Show'}</button>
					{/if}
					<button class="link" onclick={() => goto(g)} title={g.msgs.length > 1 ? 'Each click goes to the next place' : ''}>
						Go to{g.msgs.length > 1 ? ` ${((cursor[g.key] ?? 0) % g.msgs.length) + 1}/${g.msgs.length}` : ''}
					</button>
				</span>
			</li>
		{/each}
	</ul>
	{#if shown.length > limit}
		<button class="btn more" onclick={() => (limit += LIMIT)}>Show more · {shown.length - limit} left</button>
	{/if}
</section>

<style>
	.removed {
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
		padding: 12px 14px;
		display: grid;
		gap: 10px;
		margin-top: 4px;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
	}
	.title :global(svg) {
		color: var(--ok);
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.types {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.types button {
		all: unset;
		font-size: 12px;
		padding: 2px 9px;
		border-radius: 999px;
		cursor: pointer;
		color: var(--muted);
		border: 1px solid var(--line);
	}
	.types button span {
		color: var(--faint);
		margin-left: 2px;
	}
	.types button.on {
		background: var(--ink);
		color: var(--bg);
		border-color: var(--ink);
	}
	.types button.on span {
		color: color-mix(in srgb, var(--bg) 60%, transparent);
	}
	.types button:focus-visible {
		outline: 2px solid var(--focus);
	}
	.note {
		margin: 0;
		font-size: 12px;
		color: var(--faint);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 340px;
		overflow: auto;
		border-top: 1px solid var(--line-soft);
	}
	li {
		display: grid;
		grid-template-columns: 150px minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 12px;
		padding: 7px 0;
		border-bottom: 1px solid var(--line-soft);
		font-size: 12.5px;
	}
	li:last-child {
		border-bottom: 0;
	}
	.type {
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.value {
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.value.masked {
		color: var(--muted);
		letter-spacing: 0.02em;
	}
	.count {
		font-size: 11.5px;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
	.acts {
		display: flex;
		gap: 12px;
		white-space: nowrap;
	}
	.link {
		all: unset;
		cursor: pointer;
		font-size: 12px;
		color: var(--ink-2);
		text-decoration: underline;
		text-decoration-color: var(--faint);
		text-underline-offset: 2px;
	}
	.link:focus-visible {
		outline: 2px solid var(--focus);
	}
	.more {
		justify-self: center;
	}
	@media (max-width: 640px) {
		li {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 2px 10px;
		}
		.type {
			grid-column: 1 / -1;
		}
		.count {
			display: none;
		}
	}
</style>
