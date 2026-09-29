/**
 * Portable image header inspection: dimensions, alpha, animation, EXIF
 * orientation, colour profile and metadata presence, and an estimate of the
 * JPEG quality from its quantisation tables. Used by the planner of both
 * engines, so decisions do not depend on which encoder is available.
 */

export interface ImageInfo {
  readonly format: 'jpeg' | 'png' | 'webp' | 'gif' | 'other';
  readonly width?: number;
  readonly height?: number;
  readonly hasAlpha?: boolean;
  /** True for APNG, animated WebP and multi-frame GIF. */
  readonly animated: boolean;
  readonly frames?: number;
  /** True for JPEG files carrying extra images (MPF, e.g. stereo or depth maps). */
  readonly multiImage: boolean;
  readonly orientation?: number;
  readonly hasIcc: boolean;
  readonly hasExif: boolean;
  readonly hasXmp: boolean;
  readonly hasIptc: boolean;
  readonly hasText: boolean;
  readonly colorModel?: 'gray' | 'rgb' | 'palette' | 'cmyk' | 'ycck';
  readonly bitDepth?: number;
  readonly progressive?: boolean;
  /** True for lossless encodings (PNG, WebP VP8L). */
  readonly lossless?: boolean;
  /** Estimated IJG quality (1-100) for baseline JPEG quantisation tables. */
  readonly jpegQuality?: number;
  /** Bytes used by metadata segments/chunks. */
  readonly metadataBytes: number;
  /** Structural problem found while parsing, if any. */
  readonly error?: string;
}

/** A JPEG marker segment with offsets into the file. */
export interface JpegSegment {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
  readonly dataStart: number;
}

/** A PNG chunk with offsets into the file. */
export interface PngChunk {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly dataStart: number;
  readonly length: number;
}

/** A RIFF chunk of a WebP file. */
export interface RiffChunk {
  readonly fourcc: string;
  readonly start: number;
  readonly end: number;
  readonly dataStart: number;
  readonly size: number;
}

const be16 = (b: Uint8Array, p: number): number => (b[p]! << 8) | b[p + 1]!;
const be32 = (b: Uint8Array, p: number): number => ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
const le16 = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8);
const le24 = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16);
const le32 = (b: Uint8Array, p: number): number => (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
const str = (b: Uint8Array, p: number, n: number): string => {
  let s = '';
  for (let i = p; i < Math.min(b.length, p + n); i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** Inspects an image of a known format. */
export function inspectImage(bytes: Uint8Array, format: string): ImageInfo {
  try {
    switch (format) {
      case 'jpeg':
        return inspectJpeg(bytes);
      case 'png':
        return inspectPng(bytes);
      case 'webp':
        return inspectWebp(bytes);
      case 'gif':
        return inspectGif(bytes);
      default:
        return empty('other');
    }
  } catch (error) {
    return { ...empty(format === 'jpeg' || format === 'png' || format === 'webp' || format === 'gif' ? format : 'other'), error: (error as Error).message };
  }
}

function empty(format: ImageInfo['format']): ImageInfo {
  return { format, animated: false, multiImage: false, hasIcc: false, hasExif: false, hasXmp: false, hasIptc: false, hasText: false, metadataBytes: 0 };
}

/** Splits a JPEG into marker segments up to (and including) SOS. */
export function jpegSegments(b: Uint8Array): JpegSegment[] {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Not a JPEG');
  const out: JpegSegment[] = [];
  let p = 2;
  while (p < b.length) {
    if (b[p] !== 0xff) throw new Error('Corrupt JPEG marker stream');
    while (b[p] === 0xff) p++;
    const marker = b[p]!;
    const start = p - 1;
    p++;
    if (marker === 0xd9) {
      out.push({ marker, start, end: p, dataStart: p });
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push({ marker, start, end: p, dataStart: p });
      continue;
    }
    if (p + 2 > b.length) throw new Error('Truncated JPEG segment');
    const length = be16(b, p);
    if (length < 2 || p + length > b.length) throw new Error('Truncated JPEG segment');
    out.push({ marker, start, end: p + length, dataStart: p + 2 });
    p += length;
    if (marker === 0xda) break; // entropy-coded data follows
  }
  return out;
}

/** Classifies an APPn segment by its identifier. */
export function jpegSegmentKind(b: Uint8Array, s: JpegSegment): 'exif' | 'xmp' | 'icc' | 'iptc' | 'jfif' | 'mpf' | 'adobe' | 'comment' | 'other' {
  const id = str(b, s.dataStart, Math.min(32, s.end - s.dataStart));
  if (s.marker === 0xe1 && id.startsWith('Exif\0')) return 'exif';
  if (s.marker === 0xe1 && (id.startsWith('http://ns.adobe.com/xap/1.0/') || id.startsWith('http://ns.adobe.com/xmp/'))) return 'xmp';
  if (s.marker === 0xe2 && id.startsWith('ICC_PROFILE\0')) return 'icc';
  if (s.marker === 0xe2 && id.startsWith('MPF\0')) return 'mpf';
  if (s.marker === 0xed && id.startsWith('Photoshop 3.0')) return 'iptc';
  if (s.marker === 0xe0 && (id.startsWith('JFIF\0') || id.startsWith('JFXX\0'))) return 'jfif';
  if (s.marker === 0xee && id.startsWith('Adobe')) return 'adobe';
  if (s.marker === 0xfe) return 'comment';
  return 'other';
}

const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103,
  77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Estimates IJG quality from a luminance quantisation table (64 values). */
export function estimateJpegQuality(table: readonly number[]): number {
  let sum = 0;
  let std = 0;
  for (let i = 0; i < 64; i++) {
    sum += table[i]!;
    std += STD_LUMA[i]!;
  }
  const scale = (sum * 100) / std;
  const q = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
  return Math.max(1, Math.min(100, Math.round(q)));
}

function inspectJpeg(b: Uint8Array): ImageInfo {
  const segments = jpegSegments(b);
  let width: number | undefined;
  let height: number | undefined;
  let components = 0;
  let progressive = false;
  let bitDepth: number | undefined;
  let orientation: number | undefined;
  let hasIcc = false;
  let hasExif = false;
  let hasXmp = false;
  let hasIptc = false;
  let multiImage = false;
  let adobeTransform: number | undefined;
  let metadataBytes = 0;
  let lumaTable: number[] | undefined;
  for (const s of segments) {
    const m = s.marker;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      bitDepth = b[s.dataStart];
      height = be16(b, s.dataStart + 1);
      width = be16(b, s.dataStart + 3);
      components = b[s.dataStart + 5]!;
      progressive = m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce;
    } else if (m === 0xdb) {
      let p = s.dataStart;
      while (p < s.end) {
        const pq = b[p]! >> 4;
        const tq = b[p]! & 0x0f;
        const size = pq ? 128 : 64;
        if (tq === 0 && !lumaTable) {
          lumaTable = [];
          for (let i = 0; i < 64; i++) lumaTable.push(pq ? be16(b, p + 1 + i * 2) : b[p + 1 + i]!);
        }
        p += 1 + size;
      }
    } else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      const kind = jpegSegmentKind(b, s);
      if (kind === 'exif') {
        hasExif = true;
        orientation = readExifOrientation(b.subarray(s.dataStart + 6, s.end));
      } else if (kind === 'icc') hasIcc = true;
      else if (kind === 'xmp') hasXmp = true;
      else if (kind === 'iptc') hasIptc = true;
      else if (kind === 'mpf') multiImage = true;
      else if (kind === 'adobe') adobeTransform = b[s.dataStart + 11];
      if (kind !== 'jfif' && kind !== 'adobe') metadataBytes += s.end - s.start;
    }
  }
  const colorModel: ImageInfo['colorModel'] = components === 1 ? 'gray' : components === 4 ? (adobeTransform === 2 ? 'ycck' : 'cmyk') : 'rgb';
  const info: ImageInfo = {
    format: 'jpeg',
    animated: false,
    multiImage,
    hasAlpha: false,
    hasIcc,
    hasExif,
    hasXmp,
    hasIptc,
    hasText: false,
    progressive,
    lossless: false,
    colorModel,
    metadataBytes,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(bitDepth !== undefined ? { bitDepth } : {}),
    ...(orientation !== undefined ? { orientation } : {}),
    ...(lumaTable ? { jpegQuality: estimateJpegQuality(lumaTable) } : {}),
  };
  if (width === undefined) return { ...info, error: 'JPEG frame header not found' };
  if (!hasEndOfImage(b)) return { ...info, error: 'JPEG end-of-image marker missing (truncated file)' };
  return info;
}

/** Looks for the EOI marker near the end (some files carry trailing bytes after it). */
function hasEndOfImage(b: Uint8Array): boolean {
  for (let i = b.length - 2; i >= Math.max(2, b.length - 4096); i--) if (b[i] === 0xff && b[i + 1] === 0xd9) return true;
  return false;
}

/** Reads the orientation tag (0x0112) from a TIFF/EXIF block. */
export function readExifOrientation(tiff: Uint8Array): number | undefined {
  const entry = findIfd0Entry(tiff, 0x0112);
  if (!entry) return undefined;
  const value = entry.little ? le16(tiff, entry.valueOffset) : be16(tiff, entry.valueOffset);
  return value >= 1 && value <= 8 ? value : undefined;
}

/** Locates an IFD0 entry in a TIFF block and returns where its value lives. */
export function findIfd0Entry(tiff: Uint8Array, tag: number): { little: boolean; valueOffset: number; type: number } | undefined {
  if (tiff.length < 8) return undefined;
  const order = str(tiff, 0, 2);
  const little = order === 'II';
  if (!little && order !== 'MM') return undefined;
  const u16 = (p: number): number => (little ? le16(tiff, p) : be16(tiff, p));
  const u32 = (p: number): number => (little ? le32(tiff, p) : be32(tiff, p));
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return undefined;
    if (u16(e) === tag) return { little, valueOffset: e + 8, type: u16(e + 2) };
  }
  return undefined;
}

/** Splits a PNG into chunks; verifies structure but not CRCs. */
export function pngChunks(b: Uint8Array): PngChunk[] {
  if (str(b, 0, 8) !== '\x89PNG\r\n\x1a\n') throw new Error('Not a PNG');
  const out: PngChunk[] = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const length = be32(b, p);
    const type = str(b, p + 4, 4);
    const end = p + 12 + length;
    if (end > b.length) throw new Error('Truncated PNG chunk');
    out.push({ type, start: p, end, dataStart: p + 8, length });
    p = end;
    if (type === 'IEND') break;
  }
  if (out[0]?.type !== 'IHDR') throw new Error('PNG without IHDR');
  return out;
}

const PNG_METADATA = new Set(['iCCP', 'tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);

function inspectPng(b: Uint8Array): ImageInfo {
  const chunks = pngChunks(b);
  const ihdr = chunks[0]!;
  const width = be32(b, ihdr.dataStart);
  const height = be32(b, ihdr.dataStart + 4);
  const bitDepth = b[ihdr.dataStart + 8]!;
  const colorType = b[ihdr.dataStart + 9]!;
  let animated = false;
  let frames: number | undefined;
  let hasIcc = false;
  let hasExif = false;
  let hasText = false;
  let hasXmp = false;
  let trns = false;
  let orientation: number | undefined;
  let metadataBytes = 0;
  for (const c of chunks) {
    if (c.type === 'acTL') {
      animated = true;
      frames = be32(b, c.dataStart);
    } else if (c.type === 'iCCP') hasIcc = true;
    else if (c.type === 'eXIf') {
      hasExif = true;
      orientation = readExifOrientation(b.subarray(c.dataStart, c.dataStart + c.length));
    } else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      hasText = true;
      if (c.type === 'iTXt' && str(b, c.dataStart, 17) === 'XML:com.adobe.xmp') hasXmp = true;
    } else if (c.type === 'tRNS') trns = true;
    if (PNG_METADATA.has(c.type)) metadataBytes += c.end - c.start;
  }
  const colorModel: ImageInfo['colorModel'] = colorType === 3 ? 'palette' : colorType === 0 || colorType === 4 ? 'gray' : 'rgb';
  return {
    format: 'png',
    width,
    height,
    bitDepth,
    colorModel,
    hasAlpha: colorType === 4 || colorType === 6 || trns,
    animated,
    ...(frames !== undefined ? { frames } : {}),
    multiImage: false,
    hasIcc,
    hasExif,
    hasXmp,
    hasIptc: false,
    hasText,
    lossless: true,
    metadataBytes,
    ...(orientation !== undefined ? { orientation } : {}),
  };
}

/** Splits a WebP file into RIFF chunks. */
export function webpChunks(b: Uint8Array): RiffChunk[] {
  if (str(b, 0, 4) !== 'RIFF' || str(b, 8, 4) !== 'WEBP') throw new Error('Not a WebP');
  const out: RiffChunk[] = [];
  let p = 12;
  const riffEnd = Math.min(b.length, 8 + le32(b, 4));
  while (p + 8 <= riffEnd) {
    const fourcc = str(b, p, 4);
    const size = le32(b, p + 4);
    const end = p + 8 + size + (size & 1);
    if (p + 8 + size > b.length) throw new Error('Truncated WebP chunk');
    out.push({ fourcc, start: p, end: Math.min(end, b.length), dataStart: p + 8, size });
    p = end;
  }
  return out;
}

function inspectWebp(b: Uint8Array): ImageInfo {
  const chunks = webpChunks(b);
  let width: number | undefined;
  let height: number | undefined;
  let hasAlpha = false;
  let animated = false;
  let hasIcc = false;
  let hasExif = false;
  let hasXmp = false;
  let lossless = false;
  let frames = 0;
  let orientation: number | undefined;
  let metadataBytes = 0;
  for (const c of chunks) {
    if (c.fourcc === 'VP8X') {
      const flags = b[c.dataStart]!;
      animated = (flags & 0x02) !== 0;
      hasAlpha = hasAlpha || (flags & 0x10) !== 0;
      width = le24(b, c.dataStart + 4) + 1;
      height = le24(b, c.dataStart + 7) + 1;
    } else if (c.fourcc === 'VP8 ') {
      if (width === undefined) {
        width = le16(b, c.dataStart + 6) & 0x3fff;
        height = le16(b, c.dataStart + 8) & 0x3fff;
      }
    } else if (c.fourcc === 'VP8L') {
      lossless = true;
      const bits = le32(b, c.dataStart + 1);
      if (width === undefined) {
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      }
      hasAlpha = hasAlpha || ((bits >> 28) & 1) === 1;
    } else if (c.fourcc === 'ALPH') hasAlpha = true;
    else if (c.fourcc === 'ANMF') frames++;
    else if (c.fourcc === 'ICCP') {
      hasIcc = true;
      metadataBytes += c.end - c.start;
    } else if (c.fourcc === 'EXIF') {
      hasExif = true;
      orientation = readExifOrientation(b.subarray(c.dataStart + (str(b, c.dataStart, 6) === 'Exif\0\0' ? 6 : 0), c.dataStart + c.size));
      metadataBytes += c.end - c.start;
    } else if (c.fourcc === 'XMP ') {
      hasXmp = true;
      metadataBytes += c.end - c.start;
    }
  }
  return {
    format: 'webp',
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    hasAlpha,
    animated,
    ...(animated ? { frames } : {}),
    multiImage: false,
    hasIcc,
    hasExif,
    hasXmp,
    hasIptc: false,
    hasText: false,
    lossless,
    metadataBytes,
    ...(orientation !== undefined ? { orientation } : {}),
  };
}

function inspectGif(b: Uint8Array): ImageInfo {
  const width = le16(b, 6);
  const height = le16(b, 8);
  const packed = b[10]!;
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));
  let frames = 0;
  let hasAlpha = false;
  const skipSubBlocks = (): void => {
    while (p < b.length) {
      const size = b[p]!;
      p++;
      if (size === 0) return;
      p += size;
    }
  };
  while (p < b.length) {
    const block = b[p]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = b[p + 1];
      if (label === 0xf9 && (b[p + 3]! & 0x01) === 1) hasAlpha = true;
      p += 2;
      skipSubBlocks();
    } else if (block === 0x2c) {
      frames++;
      const lp = b[p + 9]!;
      p += 10;
      if (lp & 0x80) p += 3 * (1 << ((lp & 0x07) + 1));
      p++; // LZW minimum code size
      skipSubBlocks();
    } else {
      throw new Error('Corrupt GIF block');
    }
  }
  return {
    format: 'gif',
    width,
    height,
    hasAlpha,
    animated: frames > 1,
    frames,
    multiImage: false,
    hasIcc: false,
    hasExif: false,
    hasXmp: false,
    hasIptc: false,
    hasText: false,
    lossless: true,
    colorModel: 'palette',
    metadataBytes: 0,
  };
}
