<script lang="ts">
	import { untrack } from 'svelte';
	import { app } from '#lib/store.svelte.ts';
	import { TOOLS, type Session } from '#lib/types.ts';
	import { connect, rememberKey, savedKey, toEntry, WorklogError, type WorklogEntry } from '#lib/worklog.ts';
	import Icon from './Icon.svelte';
	import { markSent, sentState } from '#lib/worklog-sent.svelte.ts';

	let { current, list, onclose }: { current: Session | null; list: Session[]; onclose: () => void } = $props();

	type Row = { s: Session; e: WorklogEntry; on: boolean; state: 'idle' | 'sending' | 'sent' | 'failed'; err?: string };

	let dialog: HTMLDialogElement;
	const stored = savedKey();
	let key = $state(stored);
	let remember = $state(!!stored);
	// The dialog is created fresh each time it opens, so the initial scope only needs the first value.
	// svelte-ignore state_referenced_locally
	let scope = $state<'one' | 'all'>(current ? 'one' : 'all');
	let rows = $state<Row[]>([]);
	let reading = $state({ done: 0, total: 0, active: false });
	let sending = $state(false);
	let status = $state<string | null>(null);
	let limit = $state(100);

	$effect(() => {
		dialog.showModal();
	});

	// Subagent sessions are part of their parent's work, so they aren't sent on their own.
	const targets = $derived(scope === 'one' && current ? [current] : list.filter((s) => !s.parent));
	const chosen = $derived(rows.filter((r) => r.on));
	const done = $derived(rows.filter((r) => r.state === 'sent').length);

	let run = 0;
	$effect(() => {
		const ts = targets;
		const mine = ++run;
		rows = [];
		status = null;
		limit = 100;
		reading = { done: 0, total: ts.length, active: true };
		untrack(async () => {
			const out: Row[] = [];
			for (const [i, s] of ts.entries()) {
				if (mine !== run) return;
				// Before a Sync (or for an unreadable file) the messages aren't available; the summary
				// alone still makes an entry, with start-to-end time instead of active time.
				const msgs = await app.messages(s.id).catch(() => []);
				const e = toEntry(s, msgs);
				if (e) out.push({ s, e, on: true, state: 'idle' });
				if (mine === run && (i % 10 === 9 || i === ts.length - 1)) reading = { done: i + 1, total: ts.length, active: true };
			}
			if (mine !== run) return;
			rows = out;
			reading = { ...reading, active: false };
		});
	});

	const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const dur = (m?: number) => (m == null ? null : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim());

	async function send() {
		sending = true;
		status = 'Connecting…';
		try {
			const client = await connect(key);
			rememberKey(remember ? key.trim() : null);
			const queue = chosen.filter((r) => r.state !== 'sent');
			let failed = 0;
			let stop: WorklogError | null = null;
			const worker = async () => {
				while (queue.length && !stop) {
					const r = queue.shift()!;
					r.state = 'sending';
					try {
						await client.call('log_work', r.e);
						r.state = 'sent';
					} catch (e) {
						r.state = 'failed';
						r.err = (e as Error).message;
						failed++;
						if (e instanceof WorklogError && (e.status === 401 || e.status === 403)) stop = e;
					}
					status = `Sending ${done}/${chosen.length}…`;
				}
			};
			await Promise.all([worker(), worker(), worker()]);
			markSent(rows.filter((r) => r.state === 'sent').map((r) => r.s));
			if (stop) throw stop;
			status = `Sent ${done} ${done === 1 ? 'entry' : 'entries'} to Worklog${failed ? ` · ${failed} failed` : ''}`;
		} catch (e) {
			status = (e as Error).message;
		} finally {
			sending = false;
		}
	}

	function forget() {
		rememberKey(null);
		key = '';
		remember = false;
	}
</script>

<dialog bind:this={dialog} onclose={onclose} onclick={(e) => e.target === dialog && !sending && dialog.close()}>
	<form method="dialog" class="box" onsubmit={(e) => (e.preventDefault(), send())}>
		<header>
			<h3>Send to Worklog</h3>
			<button type="button" class="btn ghost icon" aria-label="Close" onclick={() => dialog.close()}><Icon name="x" /></button>
		</header>

		<p class="lead">
			Adds these sessions to your timeline on <a href="https://worklog.pro.et" target="_blank" rel="noopener">Worklog</a>. Each entry has a title, a short summary of the first
			prompt, the project folder's name, when it started and its active time. Conversations, code, file paths and tokens are never sent, and sensitive info is removed.
			Sending the same session again updates its entry.
		</p>

		<div class="opts">
			<label class="field">
				<span class="k">API key</span>
				<input type="password" bind:value={key} placeholder="wl_…" autocomplete="off" spellcheck="false" required />
			</label>
			<div class="keyrow">
				<label class="switch"><input type="checkbox" bind:checked={remember} /> Remember on this device</label>
				{#if stored}<button type="button" class="btn ghost small" onclick={forget}>Forget saved key</button>{/if}
				<a class="small" href="https://worklog.pro.et/signup" target="_blank" rel="noopener">Get a key</a>
			</div>

			{#if current}
				<div class="row">
					<span class="k">Sessions</span>
					<div class="seg">
						<button type="button" class:on={scope === 'one'} onclick={() => (scope = 'one')} disabled={sending}>This session</button>
						<button type="button" class:on={scope === 'all'} onclick={() => (scope = 'all')} disabled={sending}>All in list ({list.filter((s) => !s.parent).length})</button>
					</div>
				</div>
			{/if}
		</div>

		<div class="preview" aria-busy={reading.active}>
			{#if reading.active}
				<div class="empty">Preparing {reading.done}/{reading.total}…</div>
			{:else if !rows.length}
				<div class="empty">Nothing to send: these sessions have no start time or title.</div>
			{:else}
				<div class="phead">
					<span>{chosen.length} of {rows.length} selected</span>
					{#if rows.length > 1}
						<button type="button" class="btn ghost small" disabled={sending} onclick={() => rows.forEach((r) => (r.on = chosen.length !== rows.length))}>
							{chosen.length === rows.length ? 'Select none' : 'Select all'}
						</button>
					{/if}
				</div>
				<ul>
					{#each rows.slice(0, limit) as r (r.s.id)}
						<li class:off={!r.on}>
							<input type="checkbox" bind:checked={r.on} disabled={sending || r.state === 'sent'} aria-label="Include {r.e.title}" />
							<div class="body">
								{#if rows.length === 1}
									<input class="edit title" bind:value={r.e.title} maxlength="200" aria-label="Title" disabled={sending} />
									<textarea class="edit" rows="2" bind:value={r.e.summary} placeholder="No summary" aria-label="Summary" disabled={sending}></textarea>
								{:else}
									<div class="t">{r.e.title}</div>
									{#if r.e.summary}<div class="sum">{r.e.summary}</div>{/if}
								{/if}
								<div class="meta">
									<span><span class="dot {r.s.source}"></span>{TOOLS[r.s.source]}</span>
									{#if r.e.project}<span>{r.e.project}</span>{/if}
									<span>{when(r.e.occurred_at)}</span>
									{#if r.state !== 'sent' && sentState(r.s)}
										{@const ws = sentState(r.s)!}
										<span class="was" class:stale={ws.stale}>{ws.stale ? 'Sent before · new activity since' : 'Already in Worklog · sending updates it'}</span>
									{/if}
									{#if rows.length === 1}
										<label class="mins">
											<input type="number" min="0" max="1440" bind:value={r.e.duration_minutes} disabled={sending} aria-label="Minutes" /> min
										</label>
									{:else if r.e.duration_minutes}
										<span title="Active time: gaps over 30 minutes between messages are left out">{dur(r.e.duration_minutes)}</span>
									{/if}
								</div>
								{#if r.err}<div class="err">{r.err}</div>{/if}
							</div>
							<span class="st" aria-label={r.state}>
								{#if r.state === 'sent'}<Icon name="check" size={14} />{:else if r.state === 'failed'}<Icon name="alert" size={14} />{:else if r.state === 'sending'}…{/if}
							</span>
						</li>
					{/each}
				</ul>
				{#if rows.length > limit}
					<button type="button" class="btn ghost more" onclick={() => (limit += 200)}>Show more ({rows.length - limit} not shown, still included)</button>
				{/if}
			{/if}
		</div>

		<footer>
			<span class="status" aria-live="polite">{status ?? ''}</span>
			<button class="btn primary" type="submit" disabled={sending || reading.active || !chosen.filter((r) => r.state !== 'sent').length || !key.trim()}>
				<Icon name="send" size={15} />
				{done && done === chosen.length ? 'Sent' : `Send ${chosen.filter((r) => r.state !== 'sent').length || ''}`}
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
		max-width: min(640px, calc(100vw - 32px));
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
		max-height: calc(100dvh - 48px);
		grid-template-rows: auto auto auto minmax(0, 1fr) auto;
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
	.lead {
		margin: 0;
		color: var(--muted);
		font-size: 12.5px;
		line-height: 1.5;
	}
	.opts {
		display: grid;
		gap: 10px;
	}
	.field {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 13px;
	}
	.field input {
		flex: 1;
		min-width: 0;
		height: 32px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		font-family: var(--mono);
		font-size: 12.5px;
	}
	.field input:focus {
		outline: none;
		border-color: var(--ink-2);
	}
	.keyrow {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		padding-left: 76px;
	}
	.small {
		font-size: 12.5px;
	}
	.btn.small {
		height: 26px;
		padding: 0 8px;
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
	.preview {
		border: 1px solid var(--line);
		border-radius: var(--r);
		overflow: auto;
		min-height: 80px;
	}
	.empty {
		padding: 20px;
		color: var(--muted);
		font-size: 13px;
		text-align: center;
	}
	.phead {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 8px 6px 12px;
		border-bottom: 1px solid var(--line-soft);
		color: var(--muted);
		font-size: 12.5px;
		position: sticky;
		top: 0;
		background: var(--surface);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) 20px;
		gap: 10px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--line-soft);
		align-items: start;
	}
	li:last-child {
		border-bottom: 0;
	}
	li > input {
		margin-top: 3px;
	}
	li.off .body {
		opacity: 0.45;
	}
	.body {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.t {
		font-size: 13px;
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sum {
		color: var(--muted);
		font-size: 12.5px;
		line-height: 1.45;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.edit {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		padding: 6px 8px;
		font-size: 12.5px;
		resize: vertical;
	}
	.edit.title {
		font-weight: 550;
		font-size: 13px;
	}
	.edit:focus,
	.mins input:focus {
		outline: none;
		border-color: var(--ink-2);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		color: var(--muted);
		font-size: 12px;
	}
	.meta .dot {
		display: inline-block;
		margin-right: 5px;
	}
	.mins input {
		width: 64px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		padding: 2px 6px;
		font-size: 12px;
	}
	.was {
		color: var(--ok);
	}
	.was.stale {
		color: var(--warn);
	}
	.err {
		color: var(--danger);
		font-size: 12px;
	}
	.st {
		color: var(--ok);
		display: flex;
		justify-content: center;
		padding-top: 2px;
	}
	li:has(.err) .st {
		color: var(--danger);
	}
	.more {
		width: 100%;
		border-radius: 0;
		border: 0;
		border-top: 1px solid var(--line-soft);
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
		.keyrow {
			padding-left: 0;
		}
	}
</style>
