<script lang="ts">
	import { prefs, savePrefs } from '#lib/prefs.svelte.ts';
	import { findPrice, modelList, PREFERRED, pricing } from '#lib/pricing.svelte.ts';
	import { app } from '#lib/store.svelte.ts';
	import { TOOL_IDS, TOOLS, totalTokens, type Session, type Tool } from '#lib/types.ts';
	import Icon from './Icon.svelte';
	import ModelPicker, { ctx, modality, per1m } from './ModelPicker.svelte';

	let { onclose }: { onclose: () => void } = $props();

	let dialog: HTMLDialogElement;
	$effect(() => {
		dialog.showModal();
	});

	const named = (s: { models: Session['models'] }) => Object.values(s.models ?? {}).some((t) => totalTokens(t) > 0);
	// Every tool with sessions, with how many don't record a model. Cursor never records one, so it's always listed.
	const tools = $derived.by(() => {
		const all = new Map<Tool, { n: number; missing: number }>();
		for (const s of app.sessions) {
			const x = all.get(s.source) ?? { n: 0, missing: 0 };
			x.n++;
			if ((totalTokens(s.tokens) > 0 && !named(s)) || s.subagents.some((y) => totalTokens(y.tokens) > 0 && !named(y))) x.missing++;
			all.set(s.source, x);
		}
		if (!all.has('cursor')) all.set('cursor', { n: 0, missing: 0 });
		return TOOL_IDS.filter((t) => all.has(t) || prefs.priceAs[t]).map((t) => ({ tool: t, ...(all.get(t) ?? { n: 0, missing: 0 }) }));
	});

	const models = $derived(modelList());
	const byValue = $derived(new Map(models.map((m) => [m.value, m])));

	function pick(t: Tool, v: string | null) {
		const next = { ...prefs.priceAs };
		if (v) next[t] = v;
		else delete next[t];
		prefs.priceAs = next;
		savePrefs();
	}
</script>

<dialog bind:this={dialog} onclose={onclose} onclick={(e) => e.target === dialog && dialog.close()}>
	<div class="box">
		<header>
			<div>
				<h3>Settings</h3>
				<p>Saved in this browser.</p>
			</div>
			<button class="btn ghost icon" aria-label="Close" onclick={() => dialog.close()}><Icon name="x" /></button>
		</header>

		<section>
			<h4>Price sessions as a model</h4>
			<p class="lead">
				Pick a model for a tool and all of its sessions are priced at that model's
				<a href="https://models.dev" target="_blank" rel="noopener noreferrer">models.dev</a> list price, in place of the models they recorded. Useful when you paid
				a different rate, or when a tool (like Cursor) doesn't record its model. Clear it to go back to each session's own models.
			</p>

			<ul class="rows">
				{#each tools as { tool, n, missing } (tool)}
					{@const chosen = prefs.priceAs[tool]}
					{@const p = chosen ? findPrice(chosen, tool) : null}
					{@const info = chosen ? byValue.get(chosen) : null}
					<li>
						<div class="who">
							<span class="dot {tool}"></span>
							<div>
								<div class="tname">{TOOLS[tool]}</div>
								<div class="muted small">
									{#if tool === 'cursor' && !n}Never records a model
									{:else}{n} {n === 1 ? 'session' : 'sessions'}{#if missing}, {missing === n ? 'none record a model' : `${missing} without a model`}{/if}{/if}
								</div>
							</div>
						</div>
						<div class="pick">
							<ModelPicker {models} value={chosen ?? null} preferred={PREFERRED[tool]} label="Model to price {TOOLS[tool]} sessions at" onpick={(v) => pick(tool, v)} />
							<div class="small" class:muted={!p}>
								{#if p}
									<Icon name="check" size={12} />
									<span>
										{info?.name ?? p.id}: {per1m(p.input)} in · {per1m(p.output)} out · {per1m(p.cacheRead)} cache read, per 1M tokens{#if info && modality(info)}&nbsp;· {modality(info)}{/if}{#if info && ctx(info.context)}&nbsp;· {ctx(info.context)}{/if}
									</span>
								{:else if chosen}
									No price found for {chosen}
								{:else}
									{tool === 'cursor' || missing === n ? 'Not priced' : 'Using each session’s own models'}
								{/if}
							</div>
						</div>
					</li>
				{/each}
			</ul>
			<p class="foot muted small">Prices {pricing.live ? 'fetched from' : 'bundled from'} models.dev{pricing.updated ? ` on ${pricing.updated}` : ''}.</p>
		</section>
	</div>
</dialog>

<style>
	dialog {
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--ink);
		max-width: min(620px, calc(100vw - 32px));
		width: 100%;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.35);
		backdrop-filter: blur(2px);
	}
	.box {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow-lg);
		padding: 20px;
		display: grid;
		gap: 16px;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 12px;
	}
	h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
	}
	header p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
	h4 {
		margin: 0 0 4px;
		font-size: 13.5px;
		font-weight: 600;
	}
	.lead {
		margin: 0 0 12px;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.5;
	}
	.lead a {
		color: var(--ink-2);
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r);
	}
	.rows li {
		display: grid;
		grid-template-columns: 170px minmax(0, 1fr);
		gap: 14px;
		align-items: start;
		padding: 12px;
	}
	.rows li + li {
		border-top: 1px solid var(--line-soft);
	}
	.who {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}
	.who .dot {
		margin-top: 6px;
	}
	.tname {
		font-weight: 600;
		font-size: 13.5px;
	}
	.small {
		font-size: 12px;
	}
	.pick {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.pick .small {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--ok);
	}
	.pick .small.muted {
		color: var(--muted);
	}
	.foot {
		margin: 10px 0 0;
	}
	@media (max-width: 560px) {
		.rows li {
			grid-template-columns: minmax(0, 1fr);
			gap: 8px;
		}
	}
</style>
