import { DecodedBuilder, type DecodedText } from './text-map.js';

/**
 * Percent-decoding with an offset map. Consecutive %XX escapes are decoded
 * as UTF-8. Returns undefined when the input contains malformed escapes or
 * invalid UTF-8 (the caller then treats the text literally).
 */
export function decodePercent(raw: string): DecodedText | undefined {
  const b = new DecodedBuilder();
  let i = 0;
  while (i < raw.length) {
    const pct = raw.indexOf('%', i);
    const stop = pct < 0 ? raw.length : pct;
    if (stop > i) b.pushVerbatim(raw.slice(i, stop), i);
    if (pct < 0) break;
    // collect a run of %XX escapes
    const bytes: number[] = [];
    const starts: number[] = [];
    let j = pct;
    while (j < raw.length && raw[j] === '%') {
      const hex = raw.slice(j + 1, j + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      starts.push(j);
      j += 3;
    }
    const decoded = decodeUtf8Run(bytes, starts);
    if (!decoded) return undefined;
    for (const [text, start] of decoded) b.push(text, start);
    i = j;
  }
  return b.finish(raw.length);
}

/** Decodes a run of UTF-8 bytes into characters paired with their raw starts. */
function decodeUtf8Run(bytes: number[], starts: number[]): [string, number][] | undefined {
  const out: [string, number][] = [];
  let k = 0;
  while (k < bytes.length) {
    const b0 = bytes[k]!;
    let need = 0;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
    } else return undefined;
    for (let n = 1; n <= need; n++) {
      const bn = bytes[k + n];
      if (bn === undefined || (bn & 0xc0) !== 0x80) return undefined;
      cp = (cp << 6) | (bn & 0x3f);
    }
    if ((need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) {
      return undefined;
    }
    out.push([String.fromCodePoint(cp), starts[k]!]);
    k += need + 1;
  }
  return out;
}

/** Characters left unescaped by encodeURIComponent. */
const COMPONENT_SAFE = /[A-Za-z0-9\-_.!~*'()]/;

/** Returns true when raw text only contains characters encodeURIComponent would emit. */
export function looksPercentEncoded(raw: string): boolean {
  for (const ch of raw) if (ch !== '%' && !COMPONENT_SAFE.test(ch)) return false;
  return raw.includes('%');
}

/** Encodes like encodeURIComponent (used for the DataGame storage pattern). */
export function encodeComponent(text: string): string {
  return encodeURIComponent(text);
}

/**
 * Encodes a ZIP path for use in a URL in the same style as an existing
 * reference: characters that must be escaped are percent-encoded; non-ASCII
 * characters are escaped only when the original reference escaped them.
 */
export function encodePathLike(path: string, escapeNonAscii: boolean): string {
  let out = '';
  for (const ch of path) {
    if (/[A-Za-z0-9\-_.~!$&'()*+,;=:@/]/.test(ch)) out += ch;
    else if (ch.codePointAt(0)! >= 0x80 && !escapeNonAscii) out += ch;
    else out += encodeURIComponent(ch);
  }
  return out;
}
