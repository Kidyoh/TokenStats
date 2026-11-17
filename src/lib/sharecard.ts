// A shareable PNG of the overview: totals, a daily chart, tools and top models. Drawn on a canvas
// in the browser. It shows totals only: no session titles, prompts, folders or file names.
import { fmt } from './format';
import { usd } from './pricing.svelte';
import { TOOL_IDS, TOOLS, type Tool } from './types';

export interface CardData {
	/** e.g. "Last 30 days" or "All time" */
	rangeLabel: string;
	sessions: number;
	tokens: number;
	cost: number;
	/** active hours, when known */
	hours: number | null;
	toolCalls: number | null;
	perTool: { tool: Tool; tokens: number; sessions: number }[];
	days: { day: number; v: Partial<Record<Tool, number>> }[];
	models: { name: string; tokens: number }[];
}

const W = 1200;
const H = 675;
const FONT = '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

// The card is always dark, whatever the page theme, so it looks the same wherever it's posted.
const C = { bg: '#0b0b0d', panel: '#141417', line: '#26262b', ink: '#fafafa', ink2: '#d4d4d8', muted: '#a1a1aa', faint: '#71717a' };

function toolColor(t: Tool): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue(`--${t}`).trim();
	return v || '#a1a1aa';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export async function renderCard(d: CardData): Promise<Blob> {
	try {
		await Promise.all([document.fonts.load(`650 40px "Inter Variable"`), document.fonts.load(`500 14px "JetBrains Mono Variable"`)]);
	} catch {
		/* fall back to system fonts */
	}
	const scale = 2; // sharp on high-density screens and when re-compressed by social sites
	const canvas = document.createElement('canvas');
	canvas.width = W * scale;
	canvas.height = H * scale;
	const ctx = canvas.getContext('2d')!;
	ctx.scale(scale, scale);
	ctx.textBaseline = 'alphabetic';

	// Background
	ctx.fillStyle = C.bg;
	ctx.fillRect(0, 0, W, H);
	const glow = ctx.createRadialGradient(W * 0.85, -60, 10, W * 0.85, -60, 620);
	glow.addColorStop(0, 'rgba(255,255,255,0.07)');
	glow.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, W, H);

	const P = 56;
	// Brand mark: three bars
	const mark = [10, 18, 14];
	mark.forEach((h, i) => {
		ctx.fillStyle = C.ink;
		roundRect(ctx, P + i * 7, 52 + (18 - h), 4.5, h, 1.5);
		ctx.fill();
	});
	ctx.font = `600 17px ${FONT}`;
	ctx.fillStyle = C.ink;
	ctx.fillText('My AI coding stats', P + 30, 69);
	ctx.font = `500 14px ${FONT}`;
	ctx.fillStyle = C.muted;
	ctx.textAlign = 'right';
	ctx.fillText(`${d.rangeLabel} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`, W - P, 69);
	ctx.textAlign = 'left';

	// Headline numbers
	let x = P;
	const big = (value: string, label: string) => {
		ctx.font = `680 60px ${FONT}`;
		ctx.fillStyle = C.ink;
		ctx.fillText(value, x, 158);
		const w = ctx.measureText(value).width;
		ctx.font = `500 16px ${FONT}`;
		ctx.fillStyle = C.muted;
		ctx.fillText(label, x + 2, 186);
		x += Math.max(w, ctx.measureText(label).width) + 56;
	};
	big(fmt(d.tokens), 'tokens');
	if (d.cost) big(usd(d.cost), 'estimated at list prices');
	big(d.sessions.toLocaleString(), d.sessions === 1 ? 'session' : 'sessions');
	if (d.hours) big(d.hours >= 10 ? Math.round(d.hours).toLocaleString() : d.hours.toFixed(1), 'hours active');
	else if (d.toolCalls) big(fmt(d.toolCalls), 'tool calls');

	// Daily chart
	const cx = P;
	const cy = 222;
	const cw = W - P * 2;
	const ch = 190;
	ctx.fillStyle = C.panel;
	roundRect(ctx, cx - 16, cy - 16, cw + 32, ch + 52, 14);
	ctx.fill();
	const max = Math.max(1, ...d.days.map((b) => Object.values(b.v).reduce((a, v) => a + (v ?? 0), 0)));
	const n = Math.max(1, d.days.length);
	const gap = n > 120 ? 0.5 : n > 60 ? 1.5 : 3;
	const bw = Math.max(1, (cw - gap * (n - 1)) / n);
	d.days.forEach((b, i) => {
		let y = cy + ch;
		for (const t of TOOL_IDS) {
			const v = b.v[t];
			if (!v) continue;
			const h = Math.max(1.5, (v / max) * ch);
			ctx.fillStyle = toolColor(t);
			roundRect(ctx, cx + i * (bw + gap), y - h, bw, h, Math.min(2, bw / 2));
			ctx.fill();
			y -= h + (bw > 3 ? 1 : 0);
		}
	});
	ctx.font = `500 12px ${FONT}`;
	ctx.fillStyle = C.faint;
	const first = d.days[0]?.day;
	if (first) ctx.fillText(new Date(first).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), cx, cy + ch + 24);
	ctx.textAlign = 'center';
	ctx.fillText(`tokens per day · peak ${fmt(max)}`, cx + cw / 2, cy + ch + 24);
	ctx.textAlign = 'right';
	ctx.fillText('Today', cx + cw, cy + ch + 24);
	ctx.textAlign = 'left';

	// Tools and models
	const by = 480;
	const colW = (cw - 48) / 2;
	ctx.font = `600 13px ${FONT}`;
	ctx.fillStyle = C.muted;
	ctx.fillText('BY TOOL', P, by);
	ctx.fillText('TOP MODELS', P + colW + 48, by);

	const tools = d.perTool.filter((t) => t.tokens).slice(0, 5);
	const tmax = Math.max(1, ...tools.map((t) => t.tokens));
	tools.forEach((t, i) => {
		const y = by + 30 + i * 30;
		ctx.fillStyle = toolColor(t.tool);
		ctx.beginPath();
		ctx.arc(P + 5, y - 5, 5, 0, Math.PI * 2);
		ctx.fill();
		ctx.font = `550 15px ${FONT}`;
		ctx.fillStyle = C.ink2;
		ctx.fillText(TOOLS[t.tool], P + 20, y);
		const barX = P + 140;
		const barW = colW - 140 - 70;
		ctx.fillStyle = C.line;
		roundRect(ctx, barX, y - 10, barW, 7, 3.5);
		ctx.fill();
		ctx.fillStyle = toolColor(t.tool);
		roundRect(ctx, barX, y - 10, Math.max(4, (t.tokens / tmax) * barW), 7, 3.5);
		ctx.fill();
		ctx.font = `600 14px ${FONT}`;
		ctx.fillStyle = C.ink;
		ctx.textAlign = 'right';
		ctx.fillText(fmt(t.tokens), P + colW, y);
		ctx.textAlign = 'left';
	});

	const mx = P + colW + 48;
	d.models.slice(0, 5).forEach((m, i) => {
		const y = by + 30 + i * 30;
		ctx.font = `500 14px ${MONO}`;
		ctx.fillStyle = C.ink2;
		let name = m.name;
		while (ctx.measureText(name).width > colW - 90 && name.length > 4) name = name.slice(0, -2);
		if (name !== m.name) name = name.slice(0, -1) + '…';
		ctx.fillText(name, mx, y);
		ctx.font = `600 14px ${FONT}`;
		ctx.fillStyle = C.ink;
		ctx.textAlign = 'right';
		ctx.fillText(fmt(m.tokens), W - P, y);
		ctx.textAlign = 'left';
	});

	// Footer
	ctx.font = `500 12.5px ${FONT}`;
	ctx.fillStyle = C.faint;
	ctx.fillText('Made with Session Browser · read on my own device', P, H - 30);

	return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the card'))), 'image/png'));
}
