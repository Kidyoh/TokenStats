/**
 * Minimal schema-less protobuf reader. Antigravity stores conversation steps as protobuf
 * without a published schema; the field numbers used by the parser were mapped by hand.
 */
export type Field = number | Uint8Array;

export class Pb {
	private fields = new Map<number, Field[]>();
	constructor(buf: Uint8Array) {
		let i = 0;
		const varint = () => {
			let r = 0n;
			let s = 0n;
			for (;;) {
				const b = buf[i++];
				if (b === undefined) throw new Error('truncated');
				r |= BigInt(b & 0x7f) << s;
				if (b < 0x80) return r;
				s += 7n;
			}
		};
		while (i < buf.length) {
			const key = Number(varint());
			const f = key >>> 3;
			const wt = key & 7;
			let v: Field;
			if (wt === 0) {
				const big = varint();
				v = big > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(big);
			} else if (wt === 2) {
				const n = Number(varint());
				v = buf.subarray(i, i + n);
				i += n;
			} else if (wt === 1) {
				v = buf.subarray(i, i + 8);
				i += 8;
			} else if (wt === 5) {
				v = buf.subarray(i, i + 4);
				i += 4;
			} else throw new Error('bad wire type');
			const list = this.fields.get(f) ?? [];
			list.push(v);
			this.fields.set(f, list);
		}
	}

	static parse(buf: Uint8Array | null | undefined): Pb | null {
		if (!buf?.length) return null;
		try {
			return new Pb(buf);
		} catch {
			return null;
		}
	}

	all(f: number): Field[] {
		return this.fields.get(f) ?? [];
	}
	num(f: number): number | null {
		const v = this.all(f)[0];
		return typeof v === 'number' ? v : null;
	}
	str(f: number): string | null {
		const v = this.all(f)[0];
		return v instanceof Uint8Array ? dec.decode(v) : null;
	}
	strs(f: number): string[] {
		return this.all(f).flatMap((v) => (v instanceof Uint8Array ? [dec.decode(v)] : []));
	}
	msg(f: number): Pb | null {
		const v = this.all(f)[0];
		return v instanceof Uint8Array ? Pb.parse(v) : null;
	}
	msgs(f: number): Pb[] {
		return this.all(f).flatMap((v) => (v instanceof Uint8Array ? [Pb.parse(v)].filter((x): x is Pb => !!x) : []));
	}
	/** Follow a path of message fields, e.g. path(1, 4) => msg(1).msg(4) */
	path(...fs: number[]): Pb | null {
		let cur: Pb | null = this;
		for (const f of fs) cur = cur?.msg(f) ?? null;
		return cur;
	}
}

const dec = new TextDecoder();
