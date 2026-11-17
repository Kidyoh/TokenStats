<script lang="ts">
	import { buildExport, defaultOptions, download, type ExportOptions } from '#lib/export.ts';
	import { prefs } from '#lib/prefs.svelte.ts';
	import { app } from '#lib/store.svelte.ts';
	import type { Session } from '#lib/types.ts';
	import Icon from './Icon.svelte';

	let { current, list, onclose }: { current: Session | null; list: Session[]; onclose: () => void } = $props();

	let dialog: HTMLDialogElement;
	let o = $state<ExportOptions>({ ...defaultOptions, redact: prefs.redact });
	// The dialog is created fresh each time it opens, so the initial scope only needs the first value.
	// svelte-ignore state_referenced_locally
	let scope = $state<'one' | 'all'>(current ? 'one' : 'all');
	let busy = $state(false);
	let progress = $state({ done: 0, total: 0 });
	let result = $state<string | null>(null);

	$effect(() => {
		dialog.showModal();
	});

	const targets = $derived(scope === 'one' && current ? [current] : list);

	async function run() {
		busy = true;
		result = null;
		try {
			const r = await buildExport(targets, (id) => app.messages(id), o, (done, total) => (progress = { done, total }));
			if (!r.count) {
				result = o.mode === 'training' ? 'Nothing to export: no conversation had both a prompt and a reply.' : 'Nothing to export.';
				return;
			}
			download(r.name, r.content, r.type);
			result = `Saved ${r.name} · ${r.count} ${r.count === 1 ? 'session' : 'sessions'}${r.skipped ? ` · ${r.skipped} skipped` : ''}`;
		} catch (e) {
			result = 'Export failed: ' + (e as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<dialog bind:this={dialog} onclose={onclose} onclick={(e) => e.target === dialog && dialog.close()}>
	<form method="dialog" class="box" onsubmit={(e) => (e.preventDefault(), run())}>
		<header>
			<h3>Export</h3>
			<button type="button" class="btn ghost icon" aria-label="Close" onclick={() => dialog.close()}><Icon name="x" /></button>
		</header>

		<div class="modes" role="radiogroup" aria-label="Export mode">
			<label class="mode" class:on={o.mode === 'normal'}>
				<input type="radio" bind:group={o.mode} value="normal" />
				<b>Normal</b>
				<span>A readable transcript (Markdown) or the full data (JSON), for keeping or sharing.</span>
			</label>
			<label class="mode" class:on={o.mode === 'training'}>
				<input type="radio" bind:group={o.mode} value="training" />
				<b>AI training data</b>
				<span>JSONL in the standard chat fine-tuning format: user, assistant, tool calls and tool results. One conversation per line.</span>
			</label>
		</div>

		<div class="opts">
			{#if current}
				<div class="row">
					<span class="k">Sessions</span>
					<div class="seg">
						<button type="button" class:on={scope === 'one'} onclick={() => (scope = 'one')}>This session</button>
						<button type="button" class:on={scope === 'all'} onclick={() => (scope = 'all')}>All in list ({list.length})</button>
					</div>
				</div>
			{:else}
				<div class="row"><span class="k">Sessions</span><span>All {list.length} in the current list</span></div>
			{/if}
			{#if o.mode === 'normal'}
				<div class="row">
					<span class="k">Format</span>
					<div class="seg">
						<button type="button" class:on={o.format === 'markdown'} onclick={() => (o.format = 'markdown')}>Markdown</button>
						<button type="button" class:on={o.format === 'json'} onclick={() => (o.format = 'json')}>JSON</button>
					</div>
				</div>
			{/if}
			<label class="switch"><input type="checkbox" bind:checked={o.includeTools} /> Include tool calls and results</label>
			<label class="switch"><input type="checkbox" bind:checked={o.includeThinking} /> Include thinking</label>
			{#if o.mode === 'normal'}
				<label class="switch"><input type="checkbox" bind:checked={o.redact} /> Remove sensitive info</label>
			{:else}
				<p class="note"><Icon name="shield" size={14} /> Sensitive info is always removed, and injected system context is dropped. Tool calls without a recorded result are left out.</p>
			{/if}
		</div>

		<footer>
			<span class="status" aria-live="polite">
				{#if busy}Reading {progress.done}/{progress.total}…{:else if result}{result}{/if}
			</span>
			<button class="btn primary" type="submit" disabled={busy || !targets.length}>
				<Icon name="download" size={15} /> Download
			</button>
		</footer>
	</form>
</dialog>

<style>
	dialog {
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--ink);
		max-width: min(560px, calc(100vw - 32px));
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
		gap: 18px;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
	}
	.modes {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.mode {
		border: 1px solid var(--line);
		border-radius: var(--r);
		padding: 12px;
		display: grid;
		gap: 4px;
		cursor: pointer;
		align-content: start;
	}
	.mode input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.mode.on {
		border-color: var(--ink);
		box-shadow: 0 0 0 1px var(--ink);
	}
	.mode:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.mode span {
		color: var(--muted);
		font-size: 12.5px;
		line-height: 1.45;
	}
	.opts {
		display: grid;
		gap: 12px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 13px;
	}
	.k {
		color: var(--muted);
		width: 64px;
		flex: none;
	}
	.seg {
		display: inline-flex;
		background: var(--surface-2);
		border-radius: var(--r-sm);
		padding: 2px;
	}
	.seg button {
		all: unset;
		padding: 4px 10px;
		border-radius: 5px;
		cursor: pointer;
		font-size: 12.5px;
		color: var(--muted);
	}
	.seg button.on {
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow);
	}
	.seg button:focus-visible {
		outline: 2px solid var(--focus);
	}
	.note {
		margin: 0;
		display: flex;
		gap: 8px;
		align-items: flex-start;
		color: var(--muted);
		font-size: 12.5px;
	}
	.note :global(svg) {
		margin-top: 2px;
	}
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.status {
		color: var(--muted);
		font-size: 12.5px;
	}
	@media (max-width: 520px) {
		.modes {
			grid-template-columns: 1fr;
		}
	}
</style>
