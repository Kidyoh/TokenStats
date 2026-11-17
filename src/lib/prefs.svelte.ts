// Per-browser display preferences (kept in localStorage; harmless if storage is blocked).
import type { Tool } from './types';
const KEY = 'sb-prefs';

interface Prefs {
	redact: boolean;
	tools: boolean;
	thinking: boolean;
	meta: boolean;
	/** models.dev model ("provider/id") to price a tool's sessions at when they don't name a model */
	priceAs: Partial<Record<Tool, string>>;
}

const defaults: Prefs = { redact: false, tools: true, thinking: true, meta: false, priceAs: {} };

function load(): Prefs {
	try {
		return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
	} catch {
		return { ...defaults };
	}
}

export const prefs = $state<Prefs>(typeof localStorage === 'undefined' ? { ...defaults } : load());

export function savePrefs() {
	try {
		localStorage.setItem(KEY, JSON.stringify(prefs));
	} catch {
		/* storage blocked */
	}
}
