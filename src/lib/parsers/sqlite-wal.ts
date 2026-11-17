/**
 * Fold a SQLite write-ahead log into its main database image, in memory.
 *
 * OpenCode runs SQLite in WAL mode, so recent writes sit in `opencode.db-wal`
 * until a checkpoint. sql.js only takes a single database image, so we apply the
 * committed WAL frames ourselves (validating salts and the checksum chain, like
 * SQLite does on recovery) and mark the result as a rollback-journal database.
 * Format: https://www.sqlite.org/fileformat.html#the_write_ahead_log
 */
export function applyWal(db: Uint8Array, wal: Uint8Array | null | undefined): Uint8Array {
	const out = db.slice();
	if (out.length >= 20) {
		// File format read/write version 2 = WAL; 1 = legacy. sql.js opens it as a plain file.
		out[18] = 1;
		out[19] = 1;
	}
	if (!wal || wal.length < 32) return out;

	const hv = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
	const magic = hv.getUint32(0);
	if (magic !== 0x377f0682 && magic !== 0x377f0683) return out;
	const bigEndianSums = (magic & 1) === 1;
	const pageSize = hv.getUint32(8) === 1 ? 65536 : hv.getUint32(8);
	const salt1 = hv.getUint32(16);
	const salt2 = hv.getUint32(20);

	let s0 = 0;
	let s1 = 0;
	const sum = (start: number, len: number) => {
		for (let i = start; i < start + len; i += 8) {
			const a = hv.getUint32(i, !bigEndianSums);
			const b = hv.getUint32(i + 4, !bigEndianSums);
			s0 = (s0 + a + s1) >>> 0;
			s1 = (s1 + b + s0) >>> 0;
		}
	};
	sum(0, 24);
	if (s0 !== hv.getUint32(24) || s1 !== hv.getUint32(28)) return out;

	const frameSize = 24 + pageSize;
	const pending = new Map<number, number>(); // page -> offset of its data, since last commit
	const committed = new Map<number, number>();
	let dbPages = 0;

	for (let off = 32; off + frameSize <= wal.length; off += frameSize) {
		if (hv.getUint32(off + 8) !== salt1 || hv.getUint32(off + 12) !== salt2) break;
		sum(off, 8);
		sum(off + 24, pageSize);
		if (s0 !== hv.getUint32(off + 16) || s1 !== hv.getUint32(off + 20)) break;
		pending.set(hv.getUint32(off), off + 24);
		const commitSize = hv.getUint32(off + 4);
		if (commitSize > 0) {
			for (const [pg, at] of pending) committed.set(pg, at);
			pending.clear();
			dbPages = commitSize;
		}
	}
	if (!committed.size) return out;

	const result = new Uint8Array(dbPages * pageSize);
	result.set(out.subarray(0, Math.min(out.length, result.length)));
	for (const [pg, at] of committed) {
		if (pg >= 1 && pg <= dbPages) result.set(wal.subarray(at, at + pageSize), (pg - 1) * pageSize);
	}
	result[18] = 1;
	result[19] = 1;
	return result;
}
