import type { Req, Res } from './protocol';
import ParseWorker from './parse.worker?worker';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Slot {
	worker = new ParseWorker();
	pending = new Map<number, Pending>();
	busy = 0;
	constructor() {
		this.worker.onmessage = (e: MessageEvent<Res>) => {
			const p = this.pending.get(e.data.id);
			if (!p) return;
			this.pending.delete(e.data.id);
			this.busy--;
			if (e.data.ok) p.resolve(e.data.result);
			else p.reject(new Error(e.data.error));
		};
	}
}

let seq = 0;

/** A few parse workers. Slot 0 also owns the OpenCode database, so OpenCode calls go there. */
export class Pool {
	slots: Slot[];
	constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
		this.slots = Array.from({ length: size }, () => new Slot());
	}
	run<T>(req: Req, slot?: number): Promise<T> {
		const s = slot != null ? this.slots[slot] : this.slots.reduce((a, b) => (b.busy < a.busy ? b : a));
		const id = ++seq;
		s.busy++;
		return new Promise<T>((resolve, reject) => {
			s.pending.set(id, { resolve, reject });
			s.worker.postMessage({ id, req });
		});
	}
	get size() {
		return this.slots.length;
	}
}
