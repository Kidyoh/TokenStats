// Which sessions have been sent to Worklog from this browser, so the session list and the
// conversation view can show it. Kept in localStorage; harmless if storage is blocked
// (the marks then last only until the page is closed).
import type { Session } from './types';

const KEY = 'sb-worklog-sent';

export interface SentMark {
	/** when it was sent (ms) */
	at: number;
	/** the session's end time when it was sent, to tell whether it has continued since */
	end: number | null;
}

function load(): Record<string, SentMark> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
	} catch {
		return {};
	}
}

export const sent = $state<{ marks: Record<string, SentMark> }>({ marks: typeof localStorage === 'undefined' ? {} : load() });

export function markSent(sessions: Pick<Session, 'id' | 'end'>[]) {
	const at = Date.now();
	const next = { ...sent.marks };
	for (const s of sessions) next[s.id] = { at, end: s.end };
	sent.marks = next;
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		/* storage blocked or full */
	}
}

export type SentState = { at: number; stale: boolean } | null;

/** Whether a session was sent, and whether it has new activity since (sending again updates its entry). */
export function sentState(s: Pick<Session, 'id' | 'end'>): SentState {
	const m = sent.marks[s.id];
	if (!m) return null;
	return { at: m.at, stale: !!(s.end && m.end && s.end > m.end) };
}
