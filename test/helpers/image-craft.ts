import { crc32 } from '../../src/core/io/crc32.js';

/**
 * Byte-level builders for image containers (JPEG, PNG, WebP, GIF) and TIFF
 * (EXIF) blocks, so tests can produce valid, unusual and malformed files
 * without an encoder.
 */

type Bytes = Uint8Array | readonly number[];

/** Encodes a string as Latin-1 bytes (one byte per code unit). */
export function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** Reads bytes as a Latin-1 string. */
export function readLatin1(bytes: Uint8Array, start = 0, length = bytes.length - start): string {
  let s = '';
  for (let i = start; i < Math.min(bytes.length, start + length); i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Concatenates byte arrays or number lists. */
export function cat(...parts: Bytes[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Big-endian 16-bit value. */
export function be16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}

/** Big-endian 32-bit value. */
export function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Little-endian 16-bit value. */
export function le16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}

/** Little-endian 24-bit value. */
export function le24(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

/** Little-endian 32-bit value. */
export function le32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

// ------------------------------------------------------------------ TIFF / EXIF

/** One IFD entry; SHORT (3) values use the first two value bytes, other types all four. */
export interface TiffEntry {
  tag: number;
  type: number;
  value: number;
}

/**
 * Builds a TIFF block with IFD0 at offset 8 and, when `exif` is given, an
 * ExifIFD (pointer tag 0x8769) placed right after IFD0.
 */
export function tiff(little: boolean, ifd0: TiffEntry[], exif?: TiffEntry[]): Uint8Array {
  const u16 = little ? le16 : be16;
  const u32 = little ? le32 : be32;
  const entries = [...ifd0];
  const ifd0Size = 2 + (entries.length + (exif ? 1 : 0)) * 12 + 4;
  const exifOffset = 8 + ifd0Size;
  if (exif) entries.push({ tag: 0x8769, type: 4, value: exifOffset });
  const ifd = (list: TiffEntry[]): number[] => {
    const out: number[] = [...u16(list.length)];
    for (const e of list) {
      out.push(...u16(e.tag), ...u16(e.type), ...u32(1));
      out.push(...(e.type === 3 ? [...u16(e.value), 0, 0] : u32(e.value)));
    }
    out.push(...u32(0));
    return out;
  };
  return cat(latin1(little ? 'II' : 'MM'), u16(42), u32(8), ifd(entries), exif ? ifd(exif) : []);
}

/** Reads the value of an entry in the ExifIFD of a TIFF block (for assertions). */
export function readExifIfdValue(t: Uint8Array, tag: number): number | undefined {
  const little = t[0] === 0x49;
  const u16 = (p: number): number => (little ? t[p]! | (t[p + 1]! << 8) : (t[p]! << 8) | t[p + 1]!);
  const u32 = (p: number): number =>
    little
      ? (t[p]! | (t[p + 1]! << 8) | (t[p + 2]! << 16) | (t[p + 3]! << 24)) >>> 0
      : ((t[p]! << 24) | (t[p + 1]! << 16) | (t[p + 2]! << 8) | t[p + 3]!) >>> 0;
  const findIn = (ifd: number, wanted: number): { type: number; at: number } | undefined => {
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === wanted) return { type: u16(e + 2), at: e + 8 };
    }
    return undefined;
  };
  const ptr = findIn(u32(4), 0x8769);
  if (!ptr) return undefined;
  const entry = findIn(u32(ptr.at), tag);
  if (!entry) return undefined;
  return entry.type === 3 ? u16(entry.at) : u32(entry.at);
}

// ------------------------------------------------------------------ JPEG

/** A JPEG marker segment with its length field. */
export function jpegSegment(marker: number, data: Bytes): Uint8Array {
  return cat([0xff, marker], be16(data.length + 2), data);
}

/** APP1 EXIF segment wrapping a TIFF block. */
export function exifApp1(t: Uint8Array): Uint8Array {
  return jpegSegment(0xe1, cat(latin1('Exif\0\0'), t));
}

/** JFIF APP0 segment. */
export function jfifApp0(): Uint8Array {
  return jpegSegment(0xe0, cat(latin1('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0]));
}

/** Frame header (SOFn). */
export function sof(width: number, height: number, options: { marker?: number; components?: number; bitDepth?: number } = {}): Uint8Array {
  const components = options.components ?? 3;
  const specs: number[] = [];
  for (let i = 0; i < components; i++) specs.push(i + 1, 0x11, 0);
  return jpegSegment(options.marker ?? 0xc0, cat([options.bitDepth ?? 8], be16(height), be16(width), [components], specs));
}

/** Quantisation table segment (8-bit or 16-bit precision). */
export function dqt(values: readonly number[], options: { id?: number; sixteen?: boolean } = {}): Uint8Array {
  const pq = options.sixteen ? 1 : 0;
  const body: number[] = [(pq << 4) | (options.id ?? 0)];
  for (const v of values) body.push(...(pq ? be16(v) : [v]));
  return jpegSegment(0xdb, body);
}

/** Minimal SOS segment followed by a few entropy-coded bytes. */
export function sosWithData(): Uint8Array {
  return cat(jpegSegment(0xda, [1, 1, 0, 0, 63, 0]), [0x12, 0x34, 0x56]);
}

/** Builds SOI + segments + SOS/data + EOI. */
export function buildJpeg(segments: Uint8Array[], options: { eoi?: boolean; sos?: boolean } = {}): Uint8Array {
  return cat([0xff, 0xd8], ...segments, options.sos === false ? [] : sosWithData(), options.eoi === false ? [] : [0xff, 0xd9]);
}

// ------------------------------------------------------------------ PNG

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG chunk with a correct CRC. */
export function pngChunk(type: string, data: Bytes = []): Uint8Array {
  const body = cat(latin1(type), data);
  return cat(be32(data.length), body, be32(crc32(body)));
}

/** IHDR chunk. */
export function ihdr(width: number, height: number, bitDepth = 8, colorType = 6): Uint8Array {
  return pngChunk('IHDR', cat(be32(width), be32(height), [bitDepth, colorType, 0, 0, 0]));
}

/** Signature + chunks (callers add IHDR and IEND). */
export function buildPng(chunks: Uint8Array[]): Uint8Array {
  return cat(PNG_SIGNATURE, ...chunks);
}

/** Lists the chunk types of a PNG (for assertions). */
export function pngTypes(b: Uint8Array): string[] {
  const out: string[] = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
    out.push(readLatin1(b, p + 4, 4));
    p += 12 + len;
  }
  return out;
}

// ------------------------------------------------------------------ WebP

/** A RIFF chunk with padding to an even size. */
export function riffChunk(fourcc: string, data: Bytes): Uint8Array {
  return cat(latin1(fourcc), le32(data.length), data, data.length & 1 ? [0] : []);
}

/** RIFF/WEBP container around chunks. */
export function buildWebp(chunks: Uint8Array[]): Uint8Array {
  const body = cat(...chunks);
  return cat(latin1('RIFF'), le32(body.length + 4), latin1('WEBP'), body);
}

/** VP8X chunk with flags and canvas size. */
export function vp8x(flags: number, width: number, height: number): Uint8Array {
  return riffChunk('VP8X', cat([flags, 0, 0, 0], le24(width - 1), le24(height - 1)));
}

/** Lossy VP8 chunk header with dimensions. */
export function vp8(width: number, height: number): Uint8Array {
  return riffChunk('VP8 ', cat([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], le16(width), le16(height), [0, 0]));
}

/** Lossless VP8L chunk header with dimensions and the alpha hint. */
export function vp8l(width: number, height: number, alpha: boolean): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28)) >>> 0;
  return riffChunk('VP8L', cat([0x2f], le32(bits), [0, 0, 0]));
}

/** Lists the chunk fourccs of a WebP (for assertions). */
export function webpTypes(b: Uint8Array): string[] {
  const out: string[] = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const size = (b[p + 4]! | (b[p + 5]! << 8) | (b[p + 6]! << 16) | (b[p + 7]! << 24)) >>> 0;
    out.push(readLatin1(b, p, 4));
    p += 8 + size + (size & 1);
  }
  return out;
}

// ------------------------------------------------------------------ GIF

/** Frame description for buildGif. */
export interface GifFrame {
  /** Local colour table size exponent (table has 2^(n+1) entries). */
  localTable?: number;
  transparent?: boolean;
}

/** Builds a GIF89a with optional global table, graphic control extensions and frames. */
export function buildGif(width: number, height: number, frames: GifFrame[], options: { globalTable?: number; comment?: string } = {}): Uint8Array {
  const parts: Bytes[] = [latin1('GIF89a'), le16(width), le16(height)];
  const g = options.globalTable;
  parts.push([g !== undefined ? 0x80 | g : 0, 0, 0]);
  if (g !== undefined) parts.push(new Uint8Array(3 * (1 << (g + 1))));
  if (options.comment) parts.push([0x21, 0xfe, options.comment.length], latin1(options.comment), [0]);
  for (const f of frames) {
    parts.push([0x21, 0xf9, 4, f.transparent ? 1 : 0, 0, 0, 0, 0]);
    const lp = f.localTable !== undefined ? 0x80 | f.localTable : 0;
    parts.push([0x2c], le16(0), le16(0), le16(width), le16(height), [lp]);
    if (f.localTable !== undefined) parts.push(new Uint8Array(3 * (1 << (f.localTable + 1))));
    parts.push([2, 2, 0x4c, 0x01, 0]);
  }
  parts.push([0x3b]);
  return cat(...parts);
}
