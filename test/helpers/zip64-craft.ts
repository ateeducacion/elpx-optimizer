/**
 * Helpers that post-process archives built by craftZip: replace the classic
 * end of central directory with ZIP64 end records (optionally corrupted), and
 * patch individual header fields, so tests can reach every validation branch
 * of the reader without large files.
 */

/** Overrides for the records written by withZip64End. */
export interface Zip64EndOptions {
  /** Values of the ZIP64 end of central directory record. */
  record?: Partial<{
    signature: number;
    recordSize: number;
    disk: number;
    cdDisk: number;
    entriesOnDisk: number;
    total: number;
    cdSize: number;
    cdOffset: number;
  }>;
  /** Extra bytes appended to the ZIP64 record (its extensible data sector). */
  recordExtra?: Uint8Array;
  /** Omit the ZIP64 record entirely (the locator still points where it would be). */
  skipRecord?: boolean;
  /** Values of the ZIP64 locator. */
  locator?: Partial<{ disk: number; offset: number; totalDisks: number }>;
  /** Values of the classic EOCD (defaults: 0xffff / 0xffffffff sentinels). */
  classic?: Partial<{ entriesOnDisk: number; total: number; cdSize: number; cdOffset: number }>;
}

/** Reads the classic EOCD fields of an archive without a comment. */
export function readEocd(zip: Uint8Array): { offset: number; total: number; cdSize: number; cdOffset: number } {
  const offset = zip.length - 22;
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  return { offset, total: v.getUint16(offset + 10, true), cdSize: v.getUint32(offset + 12, true), cdOffset: v.getUint32(offset + 16, true) };
}

/** Writes a little-endian 64-bit value. */
function setU64(v: DataView, p: number, value: number): void {
  v.setUint32(p, value % 0x100000000, true);
  v.setUint32(p + 4, Math.floor(value / 0x100000000), true);
}

/** Replaces the classic EOCD of a craftZip archive with ZIP64 end records. */
export function withZip64End(zip: Uint8Array, options: Zip64EndOptions = {}): Uint8Array {
  const eocd = readEocd(zip);
  const body = zip.subarray(0, eocd.offset);
  const r = options.record ?? {};
  const extra = options.recordExtra ?? new Uint8Array(0);
  const record = new Uint8Array(56 + extra.length);
  const rv = new DataView(record.buffer);
  rv.setUint32(0, r.signature ?? 0x06064b50, true);
  setU64(rv, 4, r.recordSize ?? 44 + extra.length);
  rv.setUint16(12, 45, true);
  rv.setUint16(14, 45, true);
  rv.setUint32(16, r.disk ?? 0, true);
  rv.setUint32(20, r.cdDisk ?? 0, true);
  setU64(rv, 24, r.entriesOnDisk ?? eocd.total);
  setU64(rv, 32, r.total ?? eocd.total);
  setU64(rv, 40, r.cdSize ?? eocd.cdSize);
  setU64(rv, 48, r.cdOffset ?? eocd.cdOffset);
  record.set(extra, 56);
  const recordOffset = body.length;
  const locator = new Uint8Array(20);
  const lv = new DataView(locator.buffer);
  lv.setUint32(0, 0x07064b50, true);
  lv.setUint32(4, options.locator?.disk ?? 0, true);
  setU64(lv, 8, options.locator?.offset ?? recordOffset);
  lv.setUint32(16, options.locator?.totalDisks ?? 1, true);
  const classic = new Uint8Array(22);
  const cv = new DataView(classic.buffer);
  cv.setUint32(0, 0x06054b50, true);
  cv.setUint16(8, options.classic?.entriesOnDisk ?? 0xffff, true);
  cv.setUint16(10, options.classic?.total ?? 0xffff, true);
  cv.setUint32(12, options.classic?.cdSize ?? 0xffffffff, true);
  cv.setUint32(16, options.classic?.cdOffset ?? 0xffffffff, true);
  const parts = [body, ...(options.skipRecord ? [] : [record]), locator, classic];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Returns a copy of the archive with a 16- or 32-bit field overwritten. */
export function patch(zip: Uint8Array, offset: number, value: number, bytes: 2 | 4): Uint8Array {
  const out = zip.slice();
  const v = new DataView(out.buffer);
  if (bytes === 2) v.setUint16(offset, value, true);
  else v.setUint32(offset, value, true);
  return out;
}

/** Absolute offset of the n-th central directory header of an archive without a comment. */
export function centralHeaderOffset(zip: Uint8Array, index = 0): number {
  const { cdOffset } = readEocd(zip);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let p = cdOffset;
  for (let i = 0; i < index; i++) p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  return p;
}

/** Builds a ZIP64 extended information extra field with the given 64-bit values. */
export function zip64Extra(values: readonly number[], trailing32?: number): Uint8Array {
  const size = values.length * 8 + (trailing32 === undefined ? 0 : 4);
  const out = new Uint8Array(4 + size);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0x0001, true);
  v.setUint16(2, size, true);
  values.forEach((value, i) => setU64(v, 4 + i * 8, value));
  if (trailing32 !== undefined) v.setUint32(4 + values.length * 8, trailing32, true);
  return out;
}

/** Inserts bytes at an offset (used to create gaps or trailing central directory data). */
export function insertAt(zip: Uint8Array, offset: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(zip.length + bytes.length);
  out.set(zip.subarray(0, offset), 0);
  out.set(bytes, offset);
  out.set(zip.subarray(offset), offset + bytes.length);
  return out;
}
