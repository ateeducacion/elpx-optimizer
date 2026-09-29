import { crc32 } from '../io/crc32.js';
import { findIfd0Entry, jpegSegmentKind, jpegSegments, pngChunks, webpChunks } from './image-inspect.js';

/**
 * Metadata preservation shared by both engines. Encoders are run with
 * metadata stripped; afterwards the relevant segments of the original file
 * are copied into the new file, so the result does not depend on which
 * encoder produced the pixels:
 *
 * - ICC colour profiles are always kept (colour fidelity).
 * - EXIF, XMP, IPTC and text chunks (authorship, licence, captions) are kept
 *   unless metadata stripping was requested explicitly.
 * - EXIF orientation is kept as-is because pixels are not rotated; when
 *   metadata is stripped the orientation is still kept (minimal EXIF is not
 *   synthesized: instead the file keeps its EXIF block, see image policy).
 */

export interface MetadataPolicy {
  keepIcc: boolean;
  keepExif: boolean;
  keepXmp: boolean;
  keepIptc: boolean;
  keepText: boolean;
}

/** Raw metadata blocks extracted from an original image. */
export interface PreservedMetadata {
  readonly format: 'jpeg' | 'png' | 'webp';
  /** JPEG: whole APPn segments. PNG: whole chunks. WebP: ICCP/EXIF/XMP chunk payloads. */
  readonly blocks: readonly { kind: string; bytes: Uint8Array }[];
}

const PNG_KEEP: Record<string, keyof MetadataPolicy> = {
  iCCP: 'keepIcc',
  sRGB: 'keepIcc',
  gAMA: 'keepIcc',
  cHRM: 'keepIcc',
  cICP: 'keepIcc',
  pHYs: 'keepIcc',
  eXIf: 'keepExif',
  tEXt: 'keepText',
  zTXt: 'keepText',
  iTXt: 'keepText',
  tIME: 'keepText',
};

/** Extracts the metadata blocks to carry over, according to the policy. */
export function extractMetadata(bytes: Uint8Array, format: 'jpeg' | 'png' | 'webp', policy: MetadataPolicy): PreservedMetadata {
  const blocks: { kind: string; bytes: Uint8Array }[] = [];
  if (format === 'jpeg') {
    for (const s of jpegSegments(bytes)) {
      const kind = jpegSegmentKind(bytes, s);
      const keep =
        (kind === 'icc' && policy.keepIcc) ||
        (kind === 'exif' && policy.keepExif) ||
        (kind === 'xmp' && policy.keepXmp) ||
        (kind === 'iptc' && policy.keepIptc) ||
        (kind === 'comment' && policy.keepText);
      if (keep) blocks.push({ kind, bytes: bytes.slice(s.start, s.end) });
    }
  } else if (format === 'png') {
    for (const c of pngChunks(bytes)) {
      const flag = PNG_KEEP[c.type];
      if (flag && policy[flag]) {
        const isXmp = c.type === 'iTXt' && latin1(bytes, c.dataStart, 17) === 'XML:com.adobe.xmp';
        if (isXmp && !policy.keepXmp) continue;
        blocks.push({ kind: c.type, bytes: bytes.slice(c.start, c.end) });
      }
    }
  } else {
    for (const c of webpChunks(bytes)) {
      const keep = (c.fourcc === 'ICCP' && policy.keepIcc) || (c.fourcc === 'EXIF' && policy.keepExif) || (c.fourcc === 'XMP ' && policy.keepXmp);
      if (keep) blocks.push({ kind: c.fourcc, bytes: bytes.slice(c.dataStart, c.dataStart + c.size) });
    }
  }
  return { format, blocks };
}

/** Options applied while injecting metadata into a newly encoded image. */
export interface InjectOptions {
  /** New pixel dimensions, patched into EXIF PixelX/YDimension when present. */
  width?: number;
  height?: number;
}

/** Inserts preserved metadata into an encoded image of the same format. */
export function injectMetadata(encoded: Uint8Array, preserved: PreservedMetadata, options: InjectOptions = {}): Uint8Array {
  if (preserved.blocks.length === 0) return encoded;
  if (preserved.format === 'jpeg') return injectJpeg(encoded, preserved, options);
  if (preserved.format === 'png') return injectPng(encoded, preserved, options);
  return injectWebp(encoded, preserved, options);
}

function injectJpeg(encoded: Uint8Array, preserved: PreservedMetadata, options: InjectOptions): Uint8Array {
  const segments = jpegSegments(encoded);
  const kinds = new Set(preserved.blocks.map((b) => b.kind));
  const parts: Uint8Array[] = [encoded.subarray(0, 2)];
  let insertAfter = 2;
  const kept: Uint8Array[] = [];
  let firstNonApp = segments.length;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const isApp = (s.marker >= 0xe0 && s.marker <= 0xef) || s.marker === 0xfe;
    if (!isApp) {
      firstNonApp = i;
      break;
    }
    const kind = jpegSegmentKind(encoded, s);
    if (kind === 'jfif') {
      kept.push(encoded.subarray(s.start, s.end));
      insertAfter = s.end;
    } else if (!kinds.has(kind)) {
      kept.push(encoded.subarray(s.start, s.end));
    }
  }
  const restStart = firstNonApp < segments.length ? segments[firstNonApp]!.start : insertAfter;
  // JFIF first, then preserved metadata, then any other encoder APP segments.
  const jfif = kept.filter((k) => latin1(k, 4, 5) === 'JFIF\0');
  const others = kept.filter((k) => latin1(k, 4, 5) !== 'JFIF\0');
  parts.push(...jfif);
  for (const block of preserved.blocks) {
    parts.push(block.kind === 'exif' ? patchExifSegment(block.bytes, options) : block.bytes);
  }
  parts.push(...others, encoded.subarray(restStart));
  return concat(parts);
}

function injectPng(encoded: Uint8Array, preserved: PreservedMetadata, options: InjectOptions): Uint8Array {
  const chunks = pngChunks(encoded);
  const types = new Set(preserved.blocks.map((b) => b.kind));
  // An embedded profile and sRGB are mutually exclusive; drop the encoder's colour chunks.
  const colour = ['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP'];
  const replacingColour = colour.some((t) => types.has(t));
  const parts: Uint8Array[] = [encoded.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === 'IHDR') {
      parts.push(encoded.subarray(c.start, c.end));
      for (const block of preserved.blocks) {
        parts.push(block.kind === 'eXIf' ? rebuildPngChunk('eXIf', patchTiff(block.bytes.subarray(8, block.bytes.length - 4), options)) : block.bytes);
      }
      continue;
    }
    if (types.has(c.type) || (replacingColour && colour.includes(c.type))) continue;
    parts.push(encoded.subarray(c.start, c.end));
  }
  return concat(parts);
}

function injectWebp(encoded: Uint8Array, preserved: PreservedMetadata, options: InjectOptions): Uint8Array {
  const chunks = webpChunks(encoded);
  const byKind = new Map(preserved.blocks.map((b) => [b.kind, b.bytes]));
  let width = 0;
  let height = 0;
  let alpha = false;
  const imageChunks: Uint8Array[] = [];
  // Encoder metadata chunks kept as-is must still be announced in the VP8X flags.
  const keptFromEncoder = new Set<string>();
  for (const c of chunks) {
    if (c.fourcc === 'VP8X') {
      width = le24(encoded, c.dataStart + 4) + 1;
      height = le24(encoded, c.dataStart + 7) + 1;
      alpha = alpha || (encoded[c.dataStart]! & 0x10) !== 0;
    } else if (c.fourcc === 'VP8 ') {
      if (!width) {
        width = (encoded[c.dataStart + 6]! | (encoded[c.dataStart + 7]! << 8)) & 0x3fff;
        height = (encoded[c.dataStart + 8]! | (encoded[c.dataStart + 9]! << 8)) & 0x3fff;
      }
      imageChunks.push(encoded.subarray(c.start, c.end));
    } else if (c.fourcc === 'VP8L') {
      const bits = (encoded[c.dataStart + 1]! | (encoded[c.dataStart + 2]! << 8) | (encoded[c.dataStart + 3]! << 16) | (encoded[c.dataStart + 4]! << 24)) >>> 0;
      if (!width) {
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      alpha = alpha || ((bits >>> 28) & 1) === 1;
      imageChunks.push(encoded.subarray(c.start, c.end));
    } else if (c.fourcc === 'ALPH') {
      alpha = true;
      imageChunks.push(encoded.subarray(c.start, c.end));
    } else if (c.fourcc === 'ICCP' || c.fourcc === 'EXIF' || c.fourcc === 'XMP ') {
      if (!byKind.has(c.fourcc)) {
        imageChunks.push(encoded.subarray(c.start, c.end));
        keptFromEncoder.add(c.fourcc);
      }
    } else {
      throw new Error(`Unsupported WebP chunk ${c.fourcc} in encoder output`);
    }
  }
  const icc = byKind.get('ICCP');
  const exif = byKind.get('EXIF');
  const xmp = byKind.get('XMP ');
  const has = (fourcc: string, preserved: Uint8Array | undefined): boolean => preserved !== undefined || keptFromEncoder.has(fourcc);
  const flags = (has('ICCP', icc) ? 0x20 : 0) | (alpha ? 0x10 : 0) | (has('EXIF', exif) ? 0x08 : 0) | (has('XMP ', xmp) ? 0x04 : 0);
  const vp8x = new Uint8Array(10);
  vp8x[0] = flags;
  setLe24(vp8x, 4, width - 1);
  setLe24(vp8x, 7, height - 1);
  const body: Uint8Array[] = [riffChunk('VP8X', vp8x)];
  if (icc) body.push(riffChunk('ICCP', icc));
  body.push(...imageChunks);
  if (exif) body.push(riffChunk('EXIF', patchTiffWithOptionalHeader(exif, options)));
  if (xmp) body.push(riffChunk('XMP ', xmp));
  const payload = concat(body);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  const size = payload.length + 4;
  header[4] = size & 0xff;
  header[5] = (size >> 8) & 0xff;
  header[6] = (size >> 16) & 0xff;
  header[7] = (size >>> 24) & 0xff;
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([header, payload]);
}

/** Patches an EXIF APP1 segment ("Exif\0\0" + TIFF) with new pixel dimensions. */
function patchExifSegment(segment: Uint8Array, options: InjectOptions): Uint8Array {
  const out = segment.slice();
  patchTiffInPlace(out.subarray(10), options);
  return out;
}

/** Returns a patched copy of a TIFF block. */
function patchTiff(tiff: Uint8Array, options: InjectOptions): Uint8Array {
  const out = tiff.slice();
  patchTiffInPlace(out, options);
  return out;
}

/** Patches a WebP EXIF payload that may start with an "Exif\0\0" header. */
function patchTiffWithOptionalHeader(payload: Uint8Array, options: InjectOptions): Uint8Array {
  const out = payload.slice();
  const offset = latin1(out, 0, 6) === 'Exif\0\0' ? 6 : 0;
  patchTiffInPlace(out.subarray(offset), options);
  return out;
}

/** Updates PixelXDimension/PixelYDimension in the EXIF sub-IFD when dimensions changed. */
function patchTiffInPlace(tiff: Uint8Array, options: InjectOptions): void {
  if (options.width === undefined || options.height === undefined) return;
  const exifPointer = findIfd0Entry(tiff, 0x8769);
  if (!exifPointer) return;
  const little = exifPointer.little;
  const u16 = (p: number): number => (little ? tiff[p]! | (tiff[p + 1]! << 8) : (tiff[p]! << 8) | tiff[p + 1]!);
  const u32 = (p: number): number =>
    little
      ? (tiff[p]! | (tiff[p + 1]! << 8) | (tiff[p + 2]! << 16) | (tiff[p + 3]! << 24)) >>> 0
      : ((tiff[p]! << 24) | (tiff[p + 1]! << 16) | (tiff[p + 2]! << 8) | tiff[p + 3]!) >>> 0;
  const ifd = u32(exifPointer.valueOffset);
  if (ifd + 2 > tiff.length) return;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return;
    const tag = u16(e);
    if (tag !== 0xa002 && tag !== 0xa003) continue;
    const value = tag === 0xa002 ? options.width : options.height;
    const type = u16(e + 2);
    const v = e + 8;
    if (type === 3) {
      if (little) {
        tiff[v] = value & 0xff;
        tiff[v + 1] = (value >> 8) & 0xff;
      } else {
        tiff[v] = (value >> 8) & 0xff;
        tiff[v + 1] = value & 0xff;
      }
    } else if (type === 4) {
      for (let k = 0; k < 4; k++) tiff[v + (little ? k : 3 - k)] = (value >>> (8 * k)) & 0xff;
    }
  }
}

/** Builds a PNG chunk with a fresh CRC. */
function rebuildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Builds a RIFF chunk with padding. */
function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i);
  out[4] = data.length & 0xff;
  out[5] = (data.length >> 8) & 0xff;
  out[6] = (data.length >> 16) & 0xff;
  out[7] = (data.length >>> 24) & 0xff;
  out.set(data, 8);
  return out;
}

function le24(b: Uint8Array, p: number): number {
  return b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16);
}

function setLe24(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff;
  b[p + 1] = (v >> 8) & 0xff;
  b[p + 2] = (v >> 16) & 0xff;
}

function latin1(b: Uint8Array, p: number, n: number): string {
  let s = '';
  for (let i = p; i < Math.min(b.length, p + n); i++) s += String.fromCharCode(b[i]!);
  return s;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
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
