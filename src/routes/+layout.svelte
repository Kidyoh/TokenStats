<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import '../app.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Session Browser</title>
	<meta name="description" content="Browse your local Claude Code, Codex and OpenCode sessions. Everything is read in your browser; nothing is uploaded." />
</svelte:head>

{@render children()}
