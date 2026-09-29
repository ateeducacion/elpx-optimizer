import { extname } from '../zip/names.js';

/** Broad category of a resource. */
export type ResourceKind = 'image' | 'video' | 'audio' | 'font' | 'document' | 'archive' | 'text' | 'unknown';

/** Result of content sniffing. */
export interface SniffResult {
  readonly kind: ResourceKind;
  /** Short format id, e.g. "jpeg", "png", "mp4", "webm", "html". */
  readonly format: string;
  readonly mime: string;
}

/** Number of leading bytes callers should provide to sniff(). */
export const SNIFF_BYTES = 512;

const ascii = (b: Uint8Array, start: number, length: number): string => {
  let s = '';
  for (let i = start; i < Math.min(b.length, start + length); i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** Detects the real format of a resource from its first bytes (and extension for text). */
export function sniff(head: Uint8Array, path: string): SniffResult {
  const b = head;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', format: 'jpeg', mime: 'image/jpeg' };
  if (ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n') return { kind: 'image', format: 'png', mime: 'image/png' };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { kind: 'image', format: 'gif', mime: 'image/gif' };
  if (ascii(b, 0, 4) === 'RIFF') {
    const sub = ascii(b, 8, 4);
    if (sub === 'WEBP') return { kind: 'image', format: 'webp', mime: 'image/webp' };
    if (sub === 'AVI ') return { kind: 'video', format: 'avi', mime: 'video/x-msvideo' };
    if (sub === 'WAVE') return { kind: 'audio', format: 'wav', mime: 'audio/wav' };
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    const brands = ascii(b, 8, Math.min(64, b.length - 8));
    if (/avif|avis/.test(brands)) return { kind: 'image', format: 'avif', mime: 'image/avif' };
    if (/heic|heix|mif1|msf1|heis/.test(brand)) return { kind: 'image', format: 'heic', mime: 'image/heic' };
    if (brand === 'qt  ') return { kind: 'video', format: 'mov', mime: 'video/quicktime' };
    if (/^M4A |^M4B /.test(brand)) return { kind: 'audio', format: 'm4a', mime: 'audio/mp4' };
    if (/^3g/.test(brand)) return { kind: 'video', format: '3gp', mime: 'video/3gpp' };
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return { kind: 'video', format: 'm4v', mime: 'video/x-m4v' };
    return { kind: 'video', format: 'mp4', mime: 'video/mp4' };
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(ascii(b, 4, 4))) {
    return { kind: 'video', format: 'mov', mime: 'video/quicktime' };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return ascii(b, 0, Math.min(b.length, 64)).includes('webm')
      ? { kind: 'video', format: 'webm', mime: 'video/webm' }
      : { kind: 'video', format: 'mkv', mime: 'video/x-matroska' };
  }
  if (ascii(b, 0, 4) === 'OggS') {
    const body = ascii(b, 0, Math.min(b.length, 128));
    if (body.includes('theora')) return { kind: 'video', format: 'ogv', mime: 'video/ogg' };
    if (body.includes('OpusHead')) return { kind: 'audio', format: 'opus', mime: 'audio/ogg' };
    return { kind: 'audio', format: 'ogg', mime: 'audio/ogg' };
  }
  if (ascii(b, 0, 3) === 'FLV') return { kind: 'video', format: 'flv', mime: 'video/x-flv' };
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xba) return { kind: 'video', format: 'mpeg', mime: 'video/mpeg' };
  if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return { kind: 'video', format: 'mpegts', mime: 'video/mp2t' };
  if (ascii(b, 0, 16) === '0&\xb2u\x8ef\xcf\x11\xa6\xd9\x00\xaa\x00b\xcel') {
    return { kind: 'video', format: 'asf', mime: 'video/x-ms-asf' };
  }
  if (ascii(b, 0, 3) === 'ID3' || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0)) {
    return { kind: 'audio', format: 'mp3', mime: 'audio/mpeg' };
  }
  if (ascii(b, 0, 4) === 'fLaC') return { kind: 'audio', format: 'flac', mime: 'audio/flac' };
  if (ascii(b, 0, 2) === 'BM') return { kind: 'image', format: 'bmp', mime: 'image/bmp' };
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { kind: 'image', format: 'ico', mime: 'image/x-icon' };
  if (ascii(b, 0, 4) === 'II*\x00' || ascii(b, 0, 4) === 'MM\x00*') return { kind: 'image', format: 'tiff', mime: 'image/tiff' };
  if (ascii(b, 0, 5) === '%PDF-') return { kind: 'document', format: 'pdf', mime: 'application/pdf' };
  if (ascii(b, 0, 4) === 'wOFF') return { kind: 'font', format: 'woff', mime: 'font/woff' };
  if (ascii(b, 0, 4) === 'wOF2') return { kind: 'font', format: 'woff2', mime: 'font/woff2' };
  if (ascii(b, 0, 4) === 'OTTO') return { kind: 'font', format: 'otf', mime: 'font/otf' };
  if (b.length >= 4 && b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return { kind: 'font', format: 'ttf', mime: 'font/ttf' };
  if (ascii(b, 0, 4) === 'PK\x03\x04') {
    const ext = extname(path);
    if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(ext)) return { kind: 'document', format: ext, mime: 'application/zip' };
    return { kind: 'archive', format: 'zip', mime: 'application/zip' };
  }
  return sniffText(b, path);
}

/** Classifies text-like content, relying on the extension for the specific type. */
function sniffText(b: Uint8Array, path: string): SniffResult {
  for (let i = 0; i < Math.min(b.length, SNIFF_BYTES); i++) {
    const c = b[i]!;
    if (c === 0 || (c < 0x09 && c !== 0x1b)) return { kind: 'unknown', format: 'binary', mime: 'application/octet-stream' };
  }
  const start = ascii(b, 0, Math.min(b.length, 256))
    .replace(/^\uFEFF|^\xEF\xBB\xBF/, '')
    .trimStart()
    .toLowerCase();
  const ext = extname(path);
  if (start.startsWith('<svg') || (start.startsWith('<?xml') && start.includes('<svg'))) return { kind: 'image', format: 'svg', mime: 'image/svg+xml' };
  if (ext === 'svg' && start.startsWith('<')) return { kind: 'image', format: 'svg', mime: 'image/svg+xml' };
  if (start.startsWith('webvtt')) return { kind: 'text', format: 'vtt', mime: 'text/vtt' };
  const byExt: Record<string, [string, string]> = {
    html: ['html', 'text/html'],
    htm: ['html', 'text/html'],
    xhtml: ['html', 'application/xhtml+xml'],
    css: ['css', 'text/css'],
    js: ['js', 'text/javascript'],
    mjs: ['js', 'text/javascript'],
    json: ['json', 'application/json'],
    xml: ['xml', 'application/xml'],
    xsd: ['xml', 'application/xml'],
    dtd: ['dtd', 'application/xml-dtd'],
    srt: ['srt', 'application/x-subrip'],
    vtt: ['vtt', 'text/vtt'],
    txt: ['txt', 'text/plain'],
    md: ['txt', 'text/markdown'],
    csv: ['csv', 'text/csv'],
  };
  const hit = byExt[ext];
  if (hit) return { kind: 'text', format: hit[0], mime: hit[1] };
  if (start.startsWith('<!doctype html') || start.startsWith('<html')) return { kind: 'text', format: 'html', mime: 'text/html' };
  return { kind: 'text', format: 'txt', mime: 'text/plain' };
}

/** Formats each extension is expected to hold. */
const EXTENSION_FORMATS: Record<string, readonly string[]> = {
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  jpe: ['jpeg'],
  png: ['png'],
  apng: ['png'],
  gif: ['gif'],
  webp: ['webp'],
  avif: ['avif'],
  heic: ['heic'],
  svg: ['svg'],
  bmp: ['bmp'],
  ico: ['ico'],
  tif: ['tiff'],
  tiff: ['tiff'],
  mp4: ['mp4', 'm4v', 'mov', '3gp'],
  m4v: ['mp4', 'm4v', 'mov'],
  mov: ['mov', 'mp4', 'm4v'],
  webm: ['webm', 'mkv'],
  mkv: ['mkv', 'webm'],
  ogv: ['ogv'],
  ogg: ['ogg', 'ogv', 'opus'],
  oga: ['ogg', 'opus'],
  opus: ['opus', 'ogg'],
  avi: ['avi'],
  flv: ['flv'],
  mpg: ['mpeg', 'mpegts'],
  mpeg: ['mpeg', 'mpegts'],
  ts: ['mpegts'],
  wmv: ['asf'],
  '3gp': ['3gp', 'mp4'],
  mp3: ['mp3'],
  m4a: ['m4a', 'mp4'],
  aac: ['aac', 'mp3'],
  wav: ['wav'],
  flac: ['flac'],
  pdf: ['pdf'],
  woff: ['woff'],
  woff2: ['woff2'],
  ttf: ['ttf'],
  otf: ['otf'],
  zip: ['zip'],
};

/**
 * Returns true when the file extension is consistent with the sniffed
 * format, false on a mismatch, and undefined when the extension is unknown
 * or the content is text (where sniffing relies on the extension).
 */
export function extensionMatches(path: string, sniffed: SniffResult): boolean | undefined {
  if (sniffed.kind === 'text') return undefined;
  const expected = EXTENSION_FORMATS[extname(path)];
  if (!expected) return undefined;
  return expected.includes(sniffed.format);
}

/** MIME type expected from an extension alone (used for display and reports). */
export function mimeFromExtension(path: string): string | undefined {
  const ext = extname(path);
  const table: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    webm: 'video/webm',
    ogv: 'video/ogg',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    vtt: 'text/vtt',
    srt: 'application/x-subrip',
    pdf: 'application/pdf',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    json: 'application/json',
    xml: 'application/xml',
  };
  return table[ext];
}
