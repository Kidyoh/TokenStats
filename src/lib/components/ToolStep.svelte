<script lang="ts">
	import { CATEGORY_ICON, toolInfo, type Step } from '#lib/toolinfo.ts';
	import Icon from './Icon.svelte';

	let { step, focus = false }: { step: Step; focus?: boolean } = $props();

	const info = $derived(step.call ? toolInfo(step.call) : null);
	const output = $derived(step.result?.text ?? '');
	const outLines = $derived(output ? output.split('\n').length : 0);
	const failed = $derived(!!step.result?.error);
	let open = $state(false);
	$effect(() => {
		if (focus) open = true; // jumped to from the "removed items" list
	});
	let fullOutput = $state(false);
	const PREVIEW_LINES = 40;

	function diffLines(old: string, nw: string) {
		// Simple line diff: shared prefix/suffix kept as context, the middle shown as removed/added.
		const a = old ? old.split('\n') : [];
		const b = nw ? nw.split('\n') : [];
		let s = 0;
		while (s < a.length && s < b.length && a[s] === b[s]) s++;
		let e = 0;
		while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
		const ctx = (l: string[]) => l.map((t) => ({ t, k: ' ' }));
		return [
			...ctx(a.slice(Math.max(0, s - 2), s)),
			...a.slice(s, a.length - e).map((t) => ({ t, k: '-' })),
			...b.slice(s, b.length - e).map((t) => ({ t, k: '+' })),
			...ctx(b.slice(b.length - e, Math.min(b.length, b.length - e + 2)))
		];
	}
	const patchLines = (p: string) =>
		p.split('\n').map((t) => ({ t, k: t.startsWith('+') && !t.startsWith('+++') ? '+' : t.startsWith('-') && !t.startsWith('---') ? '-' : t.startsWith('***') || t.startsWith('@@') ? '@' : ' ' }));
	const shownOutput = $derived(fullOutput || outLines <= PREVIEW_LINES ? output : output.split('\n').slice(0, PREVIEW_LINES).join('\n'));
</script>

<div class="step" class:open class:failed>
	<button class="row" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="ico"><Icon name={info ? CATEGORY_ICON[info.category] : 'tool'} size={14} /></span>
		<span class="label">{info ? info.label : 'Tool output'}</span>
		{#if info?.server}<span class="server">{info.server}</span>{/if}
		<span class="summary">{info?.summary ?? ''}</span>
		<span class="status">
			{#if failed}
				<span class="err">failed</span>
			{:else if step.result}
				{#if outLines > 1}<span class="lines">{outLines} lines</span>{/if}
			{:else if step.call}
				<span class="none">no output</span>
			{/if}
			<span class="chev"><Icon name="chevron" size={14} /></span>
		</span>
	</button>

	{#if open}
		<div class="detail">
			{#if info?.command}
				<pre class="cmd"><span class="prompt">$</span> {info.command}</pre>
			{/if}
			{#if info?.code}
				<pre class="code">{info.code}</pre>
			{/if}
			{#each info?.diffs ?? [] as d, i (i)}
				<div class="diff">
					{#if d.file}<div class="diff-file mono">{d.file}{d.old ? '' : ' (new content)'}</div>{/if}
					<pre>{#each diffLines(d.old, d.new) as l, j (j)}<span class="dl k{l.k === '+' ? 'add' : l.k === '-' ? 'del' : 'ctx'}">{l.k}&nbsp;{l.t}</span>{/each}</pre>
				</div>
			{/each}
			{#if info?.patch}
				<div class="diff">
					<pre>{#each patchLines(info.patch) as l, j (j)}<span class="dl k{l.k === '+' ? 'add' : l.k === '-' ? 'del' : l.k === '@' ? 'hdr' : 'ctx'}">{l.t || ' '}</span>{/each}</pre>
				</div>
			{/if}
			{#if info?.params.length}
				<dl class="params">
					{#each info.params as [k, v] (k)}
						<dt>{k}</dt>
						<dd class:multi={v.includes('\n') || v.length > 120}>{v}</dd>
					{/each}
				</dl>
			{/if}
			{#if step.result}
				<div class="out-head">
					<span>{failed ? 'Error' : 'Output'}</span>
					{#if outLines > PREVIEW_LINES}
						<button class="link" onclick={() => (fullOutput = !fullOutput)}>{fullOutput ? 'Show less' : `Show all ${outLines} lines`}</button>
					{/if}
				</div>
				<pre class="out" class:err={failed}>{shownOutput || '(empty)'}</pre>
			{:else if step.call}
				<div class="out-head"><span>No output was recorded for this call.</span></div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.step {
		border-radius: var(--r-sm);
		min-width: 0;
	}
	.step.open {
		background: var(--surface);
		box-shadow: 0 0 0 1px var(--line);
		margin: 4px 0;
	}
	.row {
		all: unset;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 5px 8px;
		border-radius: var(--r-sm);
		cursor: pointer;
		font-size: 13px;
		min-width: 0;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.open .row:hover {
		background: transparent;
	}
	.row:focus-visible {
		outline: 2px solid var(--focus);
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
	.failed .ico {
		color: var(--danger);
	}
	.label {
		font-weight: 550;
		color: var(--ink);
		white-space: nowrap;
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
	.summary {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
		flex: none;
		font-size: 12px;
		color: var(--faint);
	}
	.err {
		color: var(--danger);
		font-weight: 500;
	}
	.chev {
		transition: transform 0.15s;
		color: var(--faint);
	}
	.open .chev {
		transform: rotate(90deg);
	}
	.detail {
		padding: 4px 10px 10px 38px;
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	pre {
		margin: 0;
		padding: 10px 12px;
		background: var(--code);
		border: 1px solid var(--line-soft);
		border-radius: var(--r-sm);
		overflow: auto;
		max-height: 460px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.5;
	}
	.cmd .prompt {
		color: var(--faint);
		user-select: none;
	}
	.diff pre {
		padding: 6px 0;
		white-space: pre;
	}
	.diff-file {
		color: var(--muted);
		margin-bottom: 4px;
		overflow-wrap: anywhere;
	}
	.dl {
		display: block;
		padding: 0 12px;
	}
	.kadd {
		background: color-mix(in srgb, var(--ok) 13%, transparent);
	}
	.kdel {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}
	.khdr {
		color: var(--muted);
	}
	.params {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 4px 14px;
		margin: 0;
		font-size: 12.5px;
	}
	.params dt {
		color: var(--muted);
		font-family: var(--mono);
		font-size: 12px;
	}
	.params dd {
		margin: 0;
		font-family: var(--mono);
		font-size: 12px;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		min-width: 0;
	}
	.params dd.multi {
		max-height: 200px;
		overflow: auto;
		background: var(--code);
		padding: 6px 8px;
		border-radius: var(--r-sm);
	}
	.out-head {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: var(--muted);
		margin-bottom: -4px;
	}
	.out.err {
		color: var(--danger);
	}
	.link {
		all: unset;
		cursor: pointer;
		color: var(--ink-2);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
