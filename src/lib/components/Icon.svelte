<script lang="ts" module>
	// Small stroke icon set (24px grid, 1.75 stroke).
	const P: Record<string, string> = {
		terminal: 'M4 17l6-6-6-6M12 19h8',
		file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
		edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
		search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
		globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
		folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
		agent: 'M12 3l2.2 4.6L19 8.3l-3.5 3.4.8 4.8L12 14.3 7.7 16.5l.8-4.8L5 8.3l4.8-.7z',
		list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
		tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
		brain: 'M9 4a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10a3 3 0 0 0 1 2.2A3 3 0 0 0 6 17a3 3 0 0 0 3 3V4zM15 4a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 10a3 3 0 0 1-1 2.2A3 3 0 0 1 18 17a3 3 0 0 1-3 3V4z',
		chevron: 'M9 6l6 6-6 6',
		check: 'M5 12l5 5L20 7',
		x: 'M6 6l12 12M18 6L6 18',
		alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
		send: 'M21 3L10 14M21 3l-6.5 18-4.5-7-7-4.5z',
		download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
		refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5',
		shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
		back: 'M15 18l-6-6 6-6',
		copy: 'M9 9h10v10H9zM5 15V5h10',
		plus: 'M12 5v14M5 12h14',
		image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
		info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
		settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'
	};
	export type IconName = keyof typeof P;
</script>

<script lang="ts">
	let { name, size = 16, class: cls = '' }: { name: IconName | string; size?: number; class?: string } = $props();
</script>

<svg
	class="icon {cls}"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"><path d={P[name] ?? P.tool} /></svg
>

<style>
	.icon {
		flex: none;
		display: block;
	}
</style>
