<script lang="ts" module>
	import type { ModelOption } from '#lib/pricing.svelte.ts';

	export const per1m = (n: number) => '$' + (n < 1 ? n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(2).replace(/\.00$/, ''));

	const LABEL: Record<string, string> = { text: 'Text', image: 'Image', pdf: 'PDF', audio: 'Audio', video: 'Video' };
	const cap = (s: string) => LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

	/** "Text, Image, PDF → Text", or null when models.dev doesn't say */
	export function modality(m: ModelOption): string | null {
		if (!m.inputs.length && !m.outputs.length) return null;
		const list = (xs: string[]) => (xs.length ? xs : ['text']).map(cap).join(', ');
		return `${list(m.inputs)} → ${list(m.outputs)}`;
	}

	export const ctx = (n: number | null) => (n == null ? null : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M context` : `${Math.round(n / 1e3)}K context`);
</script>

<script lang="ts">
	import { searchModels } from '#lib/pricing.svelte.ts';
	import Icon from './Icon.svelte';

	let {
		models,
		value,
		preferred = [],
		label,
		onpick
	}: { models: ModelOption[]; value: string | null; preferred?: string[]; label: string; onpick: (value: string | null) => void } = $props();

	const uid = $props.id();
	// svelte-ignore state_referenced_locally
	let query = $state(value ?? '');
	let open = $state(false);
	let active = $state(0);
	let listEl = $state<HTMLUListElement>();

	const results = $derived(open ? searchModels(models, query === value ? '' : query, preferred) : []);

	$effect(() => {
		void results;
		active = 0;
	});
	$effect(() => {
		listEl?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	function pick(m: ModelOption) {
		query = m.value;
		open = false;
		onpick(m.value);
	}
	function clear() {
		query = '';
		onpick(null);
	}
	function keydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			open = true;
			const n = results.length;
			if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
		} else if (e.key === 'Enter' && open && results[active]) {
			e.preventDefault();
			pick(results[active]);
		} else if (e.key === 'Escape' && open) {
			// Close the list, not the whole dialog.
			e.preventDefault();
			e.stopPropagation();
			open = false;
			query = value ?? '';
		}
	}
	function blur(e: FocusEvent) {
		if (listEl?.contains(e.relatedTarget as Node)) return;
		open = false;
		// An unfinished search goes back to the saved choice.
		if (query.trim() && query !== value) query = value ?? '';
	}
</script>

<div class="picker">
	<div class="field">
		<Icon name="search" size={14} />
		<input
			role="combobox"
			aria-expanded={open}
			aria-controls="{uid}-list"
			aria-activedescendant={open && results[active] ? `${uid}-${active}` : undefined}
			aria-autocomplete="list"
			aria-label={label}
			placeholder="Search models, e.g. claude sonnet"
			spellcheck="false"
			autocomplete="off"
			bind:value={query}
			onfocus={(e) => (open = true, (e.currentTarget as HTMLInputElement).select())}
			oninput={() => (open = true)}
			onkeydown={keydown}
			onblur={blur}
		/>
		{#if value}<button type="button" class="btn ghost icon xs" aria-label="Clear" title="Don't price these sessions" onclick={clear}><Icon name="x" size={13} /></button>{/if}
	</div>
	{#if open}
		<ul id="{uid}-list" role="listbox" bind:this={listEl} aria-label="Models">
			{#each results as m, i (m.value)}
				{@const mod = modality(m)}
				<!-- svelte-ignore a11y_click_events_have_key_events (arrow keys and Enter on the combobox input pick options) -->
				<li
					id="{uid}-{i}"
					data-i={i}
					role="option"
					tabindex="-1"
					aria-selected={i === active}
					class:on={i === active}
					class:chosen={m.value === value}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => pick(m)}
					onmousemove={() => (active = i)}
				>
					<div class="l1">
						<span class="name">{m.name}</span>
						<span class="id mono">{m.value}</span>
					</div>
					<div class="l2">
						<span class="price">{per1m(m.input)} in · {per1m(m.output)} out{#if m.cacheRead != null}&nbsp;· {per1m(m.cacheRead)} cache{/if}</span>
						{#if mod}<span>{mod}</span>{/if}
						{#if ctx(m.context)}<span>{ctx(m.context)}</span>{/if}
						{#if m.reasoning}<span class="tag">reasoning</span>{/if}
					</div>
				</li>
			{:else}
				<li class="none" role="presentation">{query.trim() ? `No priced model matches “${query.trim()}”` : 'Type to search'}</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.picker {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.field {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 4px 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--bg);
		color: var(--faint);
	}
	.field:focus-within {
		border-color: var(--ink-2);
	}
	.field input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		outline: none;
		height: 100%;
		color: var(--ink);
		font-family: var(--mono);
		font-size: 12.5px;
	}
	.xs {
		width: 24px;
		height: 24px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 4px;
		max-height: 260px;
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		box-shadow: var(--shadow);
	}
	li {
		padding: 7px 8px;
		border-radius: 5px;
		cursor: pointer;
		display: grid;
		gap: 2px;
	}
	li.on {
		background: var(--surface-2);
	}
	li.chosen .name::after {
		content: ' ✓';
		color: var(--ok);
	}
	.l1 {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	.name {
		font-size: 13px;
		font-weight: 550;
		color: var(--ink);
		white-space: nowrap;
	}
	.id {
		font-size: 11.5px;
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.l2 {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		font-size: 11.5px;
		color: var(--muted);
	}
	.price {
		color: var(--ink-2);
	}
	.tag {
		padding: 0 5px;
		border-radius: 4px;
		background: var(--surface-3);
	}
	.none {
		cursor: default;
		color: var(--muted);
		font-size: 12.5px;
	}
</style>
