<script lang="ts">
	import { renderCard, type CardData } from '#lib/sharecard.ts';
	import Icon from './Icon.svelte';

	let { data, onclose }: { data: CardData; onclose: () => void } = $props();

	let dialog: HTMLDialogElement;
	let blob = $state<Blob | null>(null);
	let url = $state<string | null>(null);
	let status = $state<string | null>(null);
	const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;

	$effect(() => {
		dialog.showModal();
		let gone = false;
		renderCard(data).then(
			(b) => {
				if (gone) return;
				blob = b;
				url = URL.createObjectURL(b);
			},
			(e) => (status = (e as Error).message)
		);
		return () => {
			gone = true;
			if (url) URL.revokeObjectURL(url);
		};
	});

	const name = () => `ai-coding-stats-${new Date().toISOString().slice(0, 10)}.png`;

	function download() {
		if (!url) return;
		const a = Object.assign(document.createElement('a'), { href: url, download: name() });
		document.body.append(a);
		a.click();
		a.remove();
		status = `Saved ${name()}`;
	}

	async function copy() {
		if (!blob) return;
		try {
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			status = 'Copied. Paste it into a post or chat.';
		} catch {
			status = "This browser didn't allow copying images. Download it instead.";
		}
	}
</script>

<dialog bind:this={dialog} onclose={onclose} onclick={(e) => e.target === dialog && dialog.close()}>
	<div class="box">
		<header>
			<div>
				<h3>Share your stats</h3>
				<p>Totals only: no session titles, prompts or folders.</p>
			</div>
			<button class="btn ghost icon" aria-label="Close" onclick={() => dialog.close()}><Icon name="x" /></button>
		</header>
		<div class="preview">
			{#if url}<img src={url} alt="Stats card: {data.rangeLabel}, {data.sessions} sessions" />{:else}<div class="wait">Drawing…</div>{/if}
		</div>
		<footer>
			<span class="status" aria-live="polite">{status ?? '1200 × 675 PNG'}</span>
			<div class="acts">
				{#if canCopy}<button class="btn" onclick={copy} disabled={!blob}><Icon name="copy" size={14} /> Copy image</button>{/if}
				<button class="btn primary" onclick={download} disabled={!url}><Icon name="download" size={14} /> Download PNG</button>
			</div>
		</footer>
	</div>
</dialog>

<style>
	dialog {
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--ink);
		max-width: min(820px, calc(100vw - 32px));
		width: 100%;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.45);
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
	.preview {
		border-radius: var(--r);
		overflow: hidden;
		border: 1px solid var(--line);
		aspect-ratio: 1200 / 675;
		background: #0b0b0d;
	}
	img {
		display: block;
		width: 100%;
		height: 100%;
	}
	.wait {
		display: grid;
		place-items: center;
		height: 100%;
		color: #a1a1aa;
		font-size: 13px;
	}
	footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.status {
		color: var(--muted);
		font-size: 12.5px;
	}
	.acts {
		display: flex;
		gap: 8px;
	}
</style>
