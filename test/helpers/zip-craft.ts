import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/core/io/crc32.js';

/** Description of one entry for the raw ZIP crafting helper. */
export interface CraftEntry {
  name: string | Uint8Array;
  data?: Uint8Array | string;
  method?: 0 | 8;
  flags?: number;
  /** Overrides applied to the central header only. */
  central?: Partial<{
    crc: number;
    csize: number;
    usize: number;
    method: number;
    flags: number;
    external: number;
    madeBy: number;
    offset: number;
    name: Uint8Array;
    extra: Uint8Array;
  }>;
  /** Overrides applied to the local header only. */
  local?: Partial<{ crc: number; csize: number; usize: number; method: number; flags: number; name: Uint8Array; extra: Uint8Array }>;
  /** Raw payload override (compressed bytes as stored). */
  payload?: Uint8Array;
  /** Append a data descriptor after the payload. */
  descriptor?: { signature?: boolean; crc?: number; csize?: number; usize?: number };
}

const enc = new TextEncoder();

/**
 * Builds a ZIP archive byte by byte so tests can produce both valid archives
 * and deliberately malformed or hostile ones.
 */
export function craftZip(
  entries: CraftEntry[],
  options: {
    comment?: string;
    prefix?: Uint8Array;
    trailing?: Uint8Array;
    eocd?: Partial<{ count: number; cdSize: number; cdOffset: number }>;
    skipEocd?: boolean;
  } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    offset += b.length;
  };
  if (options.prefix) push(options.prefix);
  const central: Uint8Array[] = [];
  for (const e of entries) {
    const name = typeof e.name === 'string' ? enc.encode(e.name) : e.name;
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : (e.data ?? new Uint8Array(0));
    const method = e.method ?? 0;
    const payload = e.payload ?? (method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw);
    const crc = crc32(raw);
    const flags = e.flags ?? 0x0800;
    const localOffset = offset;
    const lName = e.local?.name ?? name;
    const lExtra = e.local?.extra ?? new Uint8Array(0);
    const lh = new Uint8Array(30 + lName.length + lExtra.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.local?.flags ?? flags, true);
    lv.setUint16(8, e.local?.method ?? method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x5021, true);
    lv.setUint32(14, e.local?.crc ?? (flags & 8 ? 0 : crc), true);
    lv.setUint32(18, e.local?.csize ?? (flags & 8 ? 0 : payload.length), true);
    lv.setUint32(22, e.local?.usize ?? (flags & 8 ? 0 : raw.length), true);
    lv.setUint16(26, lName.length, true);
    lv.setUint16(28, lExtra.length, true);
    lh.set(lName, 30);
    lh.set(lExtra, 30 + lName.length);
    push(lh);
    push(payload);
    if (e.descriptor) {
      const d = new Uint8Array(e.descriptor.signature === false ? 12 : 16);
      const dv = new DataView(d.buffer);
      let p = 0;
      if (e.descriptor.signature !== false) {
        dv.setUint32(0, 0x08074b50, true);
        p = 4;
      }
      dv.setUint32(p, e.descriptor.crc ?? crc, true);
      dv.setUint32(p + 4, e.descriptor.csize ?? payload.length, true);
      dv.setUint32(p + 8, e.descriptor.usize ?? raw.length, true);
      push(d);
    }
    const cName = e.central?.name ?? name;
    const cExtra = e.central?.extra ?? new Uint8Array(0);
    const ch = new Uint8Array(46 + cName.length + cExtra.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, e.central?.madeBy ?? 0x0314, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.central?.flags ?? flags, true);
    cv.setUint16(10, e.central?.method ?? method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x5021, true);
    cv.setUint32(16, e.central?.crc ?? crc, true);
    cv.setUint32(20, e.central?.csize ?? payload.length, true);
    cv.setUint32(24, e.central?.usize ?? raw.length, true);
    cv.setUint16(28, cName.length, true);
    cv.setUint16(30, cExtra.length, true);
    cv.setUint32(38, e.central?.external ?? (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, e.central?.offset ?? localOffset, true);
    ch.set(cName, 46);
    ch.set(cExtra, 46 + cName.length);
    central.push(ch);
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) {
    push(c);
    cdSize += c.length;
  }
  if (!options.skipEocd) {
    const comment = enc.encode(options.comment ?? '');
    const eocd = new Uint8Array(22 + comment.length);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    const count = options.eocd?.count ?? entries.length;
    ev.setUint16(8, count, true);
    ev.setUint16(10, count, true);
    ev.setUint32(12, options.eocd?.cdSize ?? cdSize, true);
    ev.setUint32(16, options.eocd?.cdOffset ?? cdOffset, true);
    ev.setUint16(20, comment.length, true);
    eocd.set(comment, 22);
    push(eocd);
  }
  if (options.trailing) push(options.trailing);
  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
