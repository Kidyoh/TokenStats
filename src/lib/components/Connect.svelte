<script lang="ts">
	import { readDrop, supportsHandles } from '#lib/sources.ts';
	import { app, type Found } from '#lib/store.svelte.ts';
	import { TOOL_IDS, TOOLS, type Tool } from '#lib/types.ts';
	import Icon from './Icon.svelte';

	let { compact = false }: { compact?: boolean } = $props();

	const isWin = typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent);
	const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
	const canHandle = supportsHandles();
	const sep = isWin ? '\\' : '/';

	// The real home folder, once known (learned from any session's folder), so the copied path is exact.
	// Until then, Windows expands %USERPROFILE% in its file window, and macOS/Linux expand ~.
	const HOME_KEY = 'sb-home';
	const HOME_RE = /^([A-Za-z]:\\Users\\[^\\]+|\/Users\/[^/]+|\/home\/[^/]+)/;
	let knownHome = $state<string | null>(null);
	try {
		knownHome = localStorage.getItem(HOME_KEY);
	} catch {
		/* storage blocked */
	}
	$effect(() => {
		if (knownHome) return;
		for (const s of app.sessions) {
			const m = HOME_RE.exec(s.cwd ?? '');
			if (!m || m[1].includes(':') !== isWin) continue;
			knownHome = m[1];
			try {
				localStorage.setItem(HOME_KEY, m[1]);
			} catch {
				/* storage blocked */
			}
			return;
		}
	});
	const home = $derived(knownHome ?? (isWin ? '%USERPROFILE%' : '~'));

	// Default install locations, relative to the home folder. Browsers won't open a folder window at a
	// path the page chooses, so we copy the path for the person to paste, and start the window in Documents.
	const TRAIL: Record<Tool, string[]> = {
		claude: ['.claude'],
		codex: ['.codex'],
		opencode: ['.local', 'share', 'opencode'],
		grok: ['.grok'],
		antigravity: ['.gemini', 'antigravity'],
		cursor: ['.cursor']
	};
	const path = (t: Tool) => [home, ...TRAIL[t]].join(sep);

	const FEATURES = [
		{ i: 'list', t: 'Read every conversation', d: 'Chat-style transcripts with tool calls, diffs and output you can expand.' },
		{ i: 'brain', t: 'Tokens and cost', d: 'Totals per tool, model and day, priced at public list prices.' },
		{ i: 'tool', t: 'Tools', d: 'Which tools and shell commands your agents run most, and how often they fail.' },
		{ i: 'refresh', t: 'Time', d: 'Active hours, streaks and when in the week you work.' },
		{ i: 'image', t: 'Share a card', d: 'Turn your stats into an image to post, with no titles or folders on it.' },
		{ i: 'shield', t: 'Hide secrets', d: 'Remove keys, tokens and emails before you read, export or share.' }
	];

	let copied = $state<Tool | null>(null);
	/** While the system folder window is open: which tool, and whether its path reached the clipboard */
	let guide = $state<{ tool: Tool; copied: boolean } | null>(null);

	function startGuide(tool: Tool) {
		guide = { tool, copied: false };
		// Not awaited: the folder window has to open within the same click.
		navigator.clipboard?.writeText(path(tool)).then(
			() => {
				if (guide?.tool === tool) guide = { tool, copied: true };
			},
			() => {}
		);
	}
	let busy = $state<Tool | 'drop' | null>(null);
	/** the tool whose folders are about to be removed (waiting for the person to confirm) */
	let removing = $state<Tool | null>(null);
	async function remove(t: Tool) {
		removing = null;
		busy = t;
		try {
			for (const r of [...app.roots, ...app.pendingRoots].filter((r) => r.tools?.includes(t))) await app.removeRoot(r);
			delete notes[t];
		} finally {
			busy = null;
		}
	}
	let notes = $state<Partial<Record<Tool | 'drop', { kind: 'err' | 'ok'; text: string }>>>({});
	let dragging = $state(false);
	let input: HTMLInputElement;
	let pendingTool: Tool = 'claude';

	const pickedKey = (t: Tool) => `sb-picked-${t}`;
	function pickedBefore(t: Tool) {
		try {
			return localStorage.getItem(pickedKey(t)) === '1';
		} catch {
			return false;
		}
	}
	let picked = $state(Object.fromEntries(TOOL_IDS.map((t) => [t, pickedBefore(t)])) as Record<Tool, boolean>);

	const describe = (found: Found) =>
		TOOL_IDS.filter((k) => found[k])
			.map((k) => `${found[k]} ${TOOLS[k]}`)
			.join(', ');

	function explain(tool: Tool | 'drop', folderName: string, found: Found) {
		if (!found.total) {
			notes[tool] =
				tool === 'drop'
					? { kind: 'err', text: `No sessions in “${folderName}”.` }
					: { kind: 'err', text: `No sessions in “${folderName}”. ${TOOLS[tool]} keeps them in ${path(tool)}.` };
			return;
		}
		if (tool !== 'drop') {
			picked[tool] = true;
			try {
				localStorage.setItem(pickedKey(tool), '1');
			} catch {
				/* storage blocked: the picker just won't remember */
			}
		}
		notes[tool] =
			tool === 'drop' || found[tool]
				? { kind: 'ok', text: `Found ${describe(found)} ${found.total === 1 ? 'session' : 'sessions'}` }
				: { kind: 'err', text: `Added, but it holds ${describe(found)} sessions, not ${TOOLS[tool]}.` };
	}

	async function pick(tool: Tool) {
		delete notes[tool];
		startGuide(tool);
		if (!canHandle) {
			pendingTool = tool;
			return input.click(); // the guide closes when a folder arrives or the page regains focus
		}
		const opts: Record<string, unknown> = { id: `sb-${tool}`, mode: 'read' };
		// First time: start in Documents (a sibling of the target). Afterwards the browser reopens
		// wherever this picker was last used, which `startIn` would override.
		if (!picked[tool]) opts.startIn = 'documents';
		let handle: FileSystemDirectoryHandle;
		try {
			handle = await (window as any).showDirectoryPicker(opts);
		} catch (e) {
			if ((e as DOMException).name !== 'AbortError') notes[tool] = { kind: 'err', text: (e as Error).message };
			return;
		} finally {
			guide = null;
		}
		busy = tool;
		// Folders that held only this tool are replaced by the new pick.
		const old = app.roots.filter((r) => r.tools?.length === 1 && r.tools[0] === tool);
		try {
			const found = await app.addHandle(handle);
			explain(tool, handle.name, found);
			if (found[tool]) for (const r of old) if (!(r.handle && (await r.handle.isSameEntry(handle)))) await app.removeRoot(r);
		} catch (e) {
			notes[tool] = { kind: 'err', text: (e as Error).message };
		} finally {
			busy = null;
		}
	}

	async function onFiles(e: Event) {
		guide = null;
		const el = e.target as HTMLInputElement;
		const files = [...(el.files ?? [])];
		el.value = '';
		if (!files.length) return;
		const tool = pendingTool;
		busy = tool;
		try {
			explain(tool, files[0].webkitRelativePath.split('/')[0] || 'that folder', await app.addFiles(files));
		} finally {
			busy = null;
		}
	}

	async function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (!e.dataTransfer) return;
		const pending = readDrop(e.dataTransfer); // must start inside the event
		busy = 'drop';
		delete notes.drop;
		try {
			const dropped = await pending;
			if (!dropped.length) {
				notes.drop = { kind: 'err', text: 'Drop a folder, not individual files.' };
				return;
			}
			const total: Found = { claude: 0, codex: 0, opencode: 0, grok: 0, antigravity: 0, cursor: 0, total: 0 };
			for (const d of dropped) {
				const f = 'handle' in d ? await app.addHandle(d.handle) : await app.addFiles(d.files, d.paths);
				for (const k of [...TOOL_IDS, 'total'] as const) total[k] += f[k];
			}
			explain('drop', dropped.length === 1 && 'handle' in dropped[0] ? dropped[0].handle.name : 'those folders', total);
		} catch (err) {
			notes.drop = { kind: 'err', text: (err as Error).message };
		} finally {
			busy = null;
		}
	}

	async function copy(t: Tool) {
		try {
			await navigator.clipboard.writeText(path(t));
			copied = t;
			setTimeout(() => (copied = null), 1400);
		} catch {
			/* clipboard blocked: the path is visible anyway */
		}
	}
</script>

<svelte:window onfocus={() => !canHandle && guide && setTimeout(() => (guide = null), 400)} />

<input bind:this={input} type="file" webkitdirectory multiple hidden onchange={onFiles} />

{#if guide}
	<div class="guide" role="status" aria-live="assertive">
		<div class="g-title">
			<Icon name={guide.copied ? 'check' : 'info'} size={15} />
			{guide.copied ? 'Path copied. In the folder window:' : 'In the folder window, go to:'}
		</div>
		{#if !guide.copied}<code class="g-path">{path(guide.tool)}</code>{/if}
		<ol>
			{#if isWin}
				<li>Press <kbd>Alt</kbd> + <kbd>D</kbd> to jump to the address bar</li>
				<li>{guide.copied ? 'Paste with' : 'Type the path above, or paste with'} <kbd>Ctrl</kbd> + <kbd>V</kbd>, then press <kbd>Enter</kbd></li>
				<li>Click <b>Select Folder</b></li>
			{:else if isMac}
				<li>Press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>G</kbd></li>
				<li>{guide.copied ? 'Paste with' : 'Type the path above, or paste with'} <kbd>⌘</kbd> <kbd>V</kbd>, then press <kbd>Return</kbd></li>
				<li>Click <b>Select</b></li>
			{:else}
				<li>Press <kbd>Ctrl</kbd> + <kbd>L</kbd></li>
				<li>{guide.copied ? 'Paste with' : 'Type the path above, or paste with'} <kbd>Ctrl</kbd> + <kbd>V</kbd>, then press <kbd>Enter</kbd></li>
				<li>Click <b>Select</b></li>
			{/if}
		</ol>
	</div>
{/if}

<div
	class="connect"
	class:compact
	role="region"
	aria-label="Add session folders"
	ondragover={(e) => (e.preventDefault(), (dragging = true))}
	ondragleave={(e) => e.currentTarget === e.target && (dragging = false)}
	ondrop={onDrop}
>
	{#if !compact}
		<section class="hero">
			<div class="pitch">
				<h1>Every AI coding session,<br />in one place.</h1>
				<p>
					Pick the folder where your coding agent keeps its history. Read every conversation and see where your tokens, tools and hours went across
					{TOOL_IDS.map((t) => TOOLS[t]).join(', ').replace(/, ([^,]+)$/, ' and $1')}.
				</p>
			</div>

			<div class="start" class:dragging class:busy={busy === 'drop'}>
				<div class="start-head">
					<span class="start-ico"><Icon name="folder" size={20} /></span>
					<div>
						<b>{busy === 'drop' ? 'Reading…' : 'Choose a folder to get started'}</b>
						<span>Click your tool, or drag its folder anywhere on this page.</span>
					</div>
				</div>
				<div class="picks">
					{#each TOOL_IDS as t (t)}
						<button class="pickbtn" disabled={busy !== null} onclick={() => pick(t)} title="Choose {path(t)}">
							<span class="dot {t}"></span>
							<span class="pn">{busy === t ? 'Reading…' : TOOLS[t]}</span>
							<span class="pp mono">{TRAIL[t].join(sep)}</span>
						</button>
					{/each}
				</div>
				{#if notes.drop}<p class="note {notes.drop.kind}">{notes.drop.text}</p>{/if}
				{#each TOOL_IDS.filter((t) => notes[t]) as t (t)}<p class="note {notes[t]!.kind}">{TOOLS[t]}: {notes[t]!.text}</p>{/each}
			</div>

			<ul class="trust">
				<li><Icon name="shield" size={14} /> Read on this device</li>
				<li><Icon name="check" size={14} /> Session files are never uploaded</li>
				<li><Icon name="check" size={14} /> No account</li>
			</ul>
		</section>

		<section class="features" aria-label="What you get">
			{#each FEATURES as f (f.t)}
				<div class="feat">
					<span class="fi"><Icon name={f.i} size={15} /></span>
					<b>{f.t}</b>
					<span>{f.d}</span>
				</div>
			{/each}
		</section>

		<h2 class="where">Where each tool keeps its sessions</h2>
	{/if}

	{#if compact}
		<ul class="rows">
			{#each TOOL_IDS as t (t)}
				{@const live = app.roots.filter((r) => r.tools?.includes(t))}
				{@const waiting = app.pendingRoots.filter((r) => r.tools?.includes(t))}
				{@const n = app.sessions.filter((s) => s.source === t && !s.parent).length}
				{@const state = live.length ? 'live' : waiting.some((r) => r.handle) ? 'access' : waiting.length ? 'repick' : 'none'}
				<li class={state}>
					<span class="dot {t}"></span>
					<div class="info">
						<div class="tname">
							{TOOLS[t]}
							{#if state === 'live'}<span class="badge ok"><Icon name="check" size={11} /> Connected</span>
							{:else if state === 'access'}<span class="badge warn">Needs access</span>
							{:else if state === 'repick'}<span class="badge warn">Choose again</span>{/if}
						</div>
						<div class="status">
							{#if state === 'live'}
								{n} {n === 1 ? 'session' : 'sessions'} · <span class="mono">{live.map((r) => r.name).join(', ')}</span>
							{:else if state === 'access'}
								{n} from last sync · your browser asks again each visit
							{:else if state === 'repick'}
								{n} from last sync · this browser can't keep folder access
							{:else}
								<button class="path mono" title="Copy path" onclick={() => copy(t)}>
									<span>{path(t)}</span><Icon name={copied === t ? 'check' : 'copy'} size={12} />
								</button>
							{/if}
						</div>
						{#if notes[t]}<p class="note {notes[t]!.kind}">{notes[t]!.text}</p>{/if}
						{#if removing === t}
							<div class="confirm" role="alert">
								<span>Remove {[...live, ...waiting].map((r) => r.name).join(', ')}? Its {n} {n === 1 ? 'session' : 'sessions'} and cached conversations are cleared from this browser. Your files aren't touched.</span>
								<span class="cb">
									<button class="btn ghost sm" onclick={() => (removing = null)}>Cancel</button>
									<button class="btn sm danger" onclick={() => remove(t)}>Remove</button>
								</span>
							</div>
						{/if}
					</div>
					<div class="act">
						{#if state === 'live'}
							<button class="btn ghost sm" disabled={busy !== null} onclick={() => pick(t)}>{busy === t ? 'Reading…' : 'Change'}</button>
						{:else if state === 'access'}
							<button class="btn sm primary" onclick={() => app.sync()}>Allow</button>
						{:else}
							<button class="btn sm" class:primary={state === 'repick'} disabled={busy !== null} onclick={() => pick(t)}>
								{busy === t ? 'Reading…' : state === 'repick' ? 'Choose' : 'Connect'}
							</button>
						{/if}
						{#if state !== 'none'}
							<button
								class="btn ghost icon sm"
								title="Remove this folder and its cached data"
								aria-label="Remove {TOOLS[t]} folder"
								disabled={busy !== null}
								onclick={() => (removing = removing === t ? null : t)}><Icon name="x" size={14} /></button
							>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		<div class="drop slim" class:dragging class:busy={busy === 'drop'}>
			<Icon name="folder" size={15} />
			<span>{#if busy === 'drop'}Reading…{:else}Or drag folders here{/if}</span>
			{#if notes.drop}<span class="note {notes.drop.kind}">{notes.drop.text}</span>{/if}
		</div>
	{:else}

	<div class="grid">
		{#each TOOL_IDS as t (t)}
			<div class="card">
				<div class="name"><span class="dot {t}"></span>{TOOLS[t]}</div>
				<button class="path mono" title="Copy path" onclick={() => copy(t)}>
					<span>{path(t)}</span>
					<Icon name={copied === t ? 'check' : 'copy'} size={13} />
				</button>
				{#if !compact}
					<div class="trail">Copies this path for you to paste into the folder window</div>
				{/if}
				<button class="btn" disabled={busy !== null} onclick={() => pick(t)}>
					{busy === t ? 'Reading…' : 'Choose folder'}
				</button>
				{#if notes[t]}<p class="note {notes[t]!.kind}">{notes[t]!.text}</p>{/if}
			</div>
		{/each}
	</div>
	{/if}

	{#if !compact}
		<details class="help">
			<summary>Can't find the folder?</summary>
			<ul>
				{#if isWin}
					<li>Clicking <b>Choose folder</b> copies the path. In the window, press <kbd>Alt</kbd>+<kbd>D</kbd>, paste, and press Enter.</li>
				{:else if isMac}
					<li>Clicking <b>Choose folder</b> copies the path. In the window, press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd>, paste, and press Return.</li>
					<li>To browse instead, press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>.</kbd> to show hidden folders (their names start with a dot).</li>
				{:else}
					<li>Clicking <b>Choose folder</b> copies the path. In the window, press <kbd>Ctrl</kbd>+<kbd>L</kbd>, paste, and press Enter. <kbd>Ctrl</kbd>+<kbd>H</kbd> shows hidden folders.</li>
				{/if}
				<li>Picking your whole home folder won't work in most browsers. Pick each tool's folder instead.</li>
				{#if canHandle}
					<li>This browser remembers the folders you pick, so next time one click reconnects them.</li>
				{:else}
					<li>This browser can't remember folders, so you'll choose them again next visit. Dragging a folder onto this page is the quickest way.</li>
				{/if}
				<li>Cursor's in-editor chat history lives in one very large database, so only agent transcripts are shown.</li>
			</ul>
		</details>
	{/if}
</div>

<style>
	.connect {
		max-width: 920px;
		margin: 0 auto;
		padding: 72px 24px 48px;
		display: grid;
		gap: 20px;
	}
	.connect.compact {
		padding: 0;
		margin: 0;
		max-width: none;
		width: 100%;
		gap: 10px;
	}
	.hero {
		display: grid;
		gap: 22px;
		margin-bottom: 28px;
	}
	.start {
		border: 1.5px dashed var(--line);
		border-radius: var(--r-lg);
		background: var(--surface);
		padding: 20px;
		display: grid;
		gap: 16px;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.start.dragging {
		border-color: var(--ink);
		background: var(--surface-2);
	}
	.start-head {
		display: flex;
		gap: 14px;
		align-items: center;
	}
	.start-head b {
		display: block;
		font-size: 16px;
		font-weight: 650;
	}
	.start-head span {
		color: var(--muted);
		font-size: 13px;
	}
	.start-ico {
		width: 42px;
		height: 42px;
		border-radius: 11px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--accent-ink);
		flex: none;
	}
	.picks {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
	}
	@media (max-width: 600px) {
		.picks {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.connect {
			padding-top: 40px;
		}
		h1 br {
			display: none;
		}
	}
	.pickbtn {
		all: unset;
		box-sizing: border-box;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 2px 9px;
		padding: 11px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--bg);
		cursor: pointer;
		transition:
			border-color 0.12s,
			transform 0.12s;
	}
	.pickbtn:hover:not(:disabled) {
		border-color: var(--ink-2);
		transform: translateY(-1px);
	}
	.pickbtn:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.pickbtn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.pn {
		font-weight: 600;
		font-size: 14px;
	}
	.pp {
		grid-column: 2;
		font-size: 11.5px;
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.features {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
		gap: 18px 28px;
		border-top: 1px solid var(--line-soft);
		padding: 28px 0 20px;
	}
	.feat {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 2px 10px;
		font-size: 13px;
	}
	.feat b {
		font-weight: 600;
	}
	.feat > span:last-child {
		grid-column: 2;
		color: var(--muted);
		line-height: 1.45;
	}
	.fi {
		width: 26px;
		height: 26px;
		border-radius: 7px;
		display: grid;
		place-items: center;
		background: var(--surface-2);
		color: var(--ink-2);
		grid-row: span 2;
	}
	.where {
		font-size: 14px;
		font-weight: 600;
		margin: 8px 0 -6px;
		color: var(--ink-2);
	}
	h1 {
		font-size: clamp(30px, 5vw, 44px);
		line-height: 1.08;
		letter-spacing: -0.035em;
		font-weight: 680;
		margin: 0 0 14px;
	}
	.hero p {
		color: var(--muted);
		font-size: 16.5px;
		max-width: 620px;
		margin: 0;
		line-height: 1.55;
	}
	.trust {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		padding: 0;
		margin: 0;
		list-style: none;
		font-size: 13px;
		color: var(--ink-2);
	}
	.trust li {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.trust :global(svg) {
		color: var(--ok);
	}
	.drop {
		border: 1.5px dashed var(--line);
		border-radius: var(--r-lg);
		padding: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		color: var(--muted);
		font-size: 13.5px;
		flex-wrap: wrap;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.compact .drop {
		padding: 10px 12px;
		font-size: 12.5px;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r);
		overflow: hidden;
	}
	.rows li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 11px 12px;
		background: var(--surface);
	}
	.rows li + li {
		border-top: 1px solid var(--line-soft);
	}
	.rows li.none {
		background: transparent;
	}
	.rows li.none .tname {
		color: var(--ink-2);
		font-weight: 500;
	}
	.rows .dot {
		align-self: start;
		margin-top: 6px;
	}
	.info {
		min-width: 0;
		display: grid;
		gap: 2px;
	}
	.tname {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
		font-size: 13.5px;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11px;
		font-weight: 500;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid currentColor;
	}
	.badge.ok {
		color: var(--ok);
	}
	.badge.warn {
		color: var(--warn);
	}
	.status {
		font-size: 12px;
		color: var(--muted);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.status .path {
		display: inline-flex;
		max-width: 100%;
	}
	.confirm {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--danger) 9%, transparent);
		font-size: 12.5px;
		color: var(--ink-2);
		display: grid;
		gap: 8px;
		white-space: normal;
	}
	.cb {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}
	.btn.danger {
		background: var(--danger);
		border-color: var(--danger);
		color: #fff;
	}
	.act {
		display: flex;
		gap: 4px;
		align-items: center;
	}
	.drop.slim {
		justify-content: flex-start;
		border-radius: var(--r);
	}
	.drop.dragging {
		border-color: var(--ink);
		background: var(--surface-2);
		color: var(--ink);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 10px;
	}
	.compact .grid {
		grid-template-columns: 1fr;
		gap: 6px;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r);
		padding: 14px;
		display: grid;
		gap: 10px;
		align-content: start;
	}
	.compact .card {
		grid-template-columns: 1fr auto;
		align-items: center;
		padding: 8px 10px;
		gap: 4px 10px;
	}
	.compact .card .path {
		grid-row: 2;
	}
	.compact .card .btn {
		grid-row: 1 / span 2;
		grid-column: 2;
	}
	.compact .note {
		grid-column: 1 / -1;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
	}
	.path {
		all: unset;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		cursor: pointer;
		font-size: 12px;
		min-width: 0;
	}
	.path span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.path:hover {
		color: var(--ink);
	}
	.path:focus-visible {
		outline: 2px solid var(--focus);
	}
	.trail {
		font-size: 12px;
		color: var(--faint);
	}
	.guide {
		position: fixed;
		top: 16px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		width: min(440px, calc(100vw - 32px));
		background: var(--ink);
		color: var(--bg);
		border-radius: var(--r);
		box-shadow: var(--shadow-lg);
		padding: 14px 16px;
		font-size: 13.5px;
		animation: drop-in 0.18s ease-out;
	}
	.g-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
	}
	.g-path {
		display: block;
		margin-top: 8px;
		padding: 6px 8px;
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--bg) 14%, transparent);
		overflow-wrap: anywhere;
		user-select: all;
	}
	.guide ol {
		margin: 10px 0 0;
		padding-left: 20px;
		display: grid;
		gap: 4px;
	}
	.guide kbd {
		background: color-mix(in srgb, var(--bg) 16%, transparent);
		border-color: color-mix(in srgb, var(--bg) 30%, transparent);
		color: var(--bg);
	}
	@keyframes drop-in {
		from {
			opacity: 0;
			transform: translate(-50%, -6px);
		}
	}
	.card .btn {
		justify-content: center;
	}
	.note {
		margin: 0;
		font-size: 12.5px;
	}
	.note.ok {
		color: var(--ok);
	}
	.note.err {
		color: var(--danger);
	}
	.help {
		color: var(--muted);
		font-size: 13px;
		margin-top: 8px;
	}
	.help summary {
		cursor: pointer;
		width: fit-content;
	}
	.help ul {
		margin: 10px 0 0;
		padding-left: 18px;
		display: grid;
		gap: 4px;
	}
</style>
