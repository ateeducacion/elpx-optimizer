import { DecodedBuilder, type DecodedText } from './text-map.js';

/**
 * Finds url(...) and @import references in CSS without executing or fully
 * parsing it. Comments are skipped; escapes are decoded with an offset map.
 */

export interface CssReference {
  readonly kind: 'url' | 'import';
  /** Raw offsets of the URL text (inside quotes or url parentheses). */
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly quote: '"' | "'" | null;
  readonly decoded: DecodedText;
}

/** Scans CSS text and returns every url()/@import reference. */
export function scanCss(css: string): CssReference[] {
  const out: CssReference[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i]!;
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = readString(css, i).end;
      continue;
    }
    if (c === '@' && /^@import\b/i.test(css.slice(i, i + 8))) {
      let j = i + 7;
      while (j < n && /\s/.test(css[j]!)) j++;
      if (css[j] === '"' || css[j] === "'") {
        const s = readString(css, j);
        if (s.closed) out.push({ kind: 'import', rawStart: j + 1, rawEnd: s.end - 1, quote: css[j] as '"' | "'", decoded: s.decoded });
        i = s.end;
        continue;
      }
      i = j;
      continue;
    }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !isIdentChar(css[i - 1])) {
      const ref = readUrl(css, i + 4);
      if (ref) out.push(ref.ref);
      i = ref ? ref.end : i + 4;
      continue;
    }
    i++;
  }
  return out;
}

/** Returns true for characters that can be part of a CSS identifier. */
function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_\-\u0080-￿\\]/.test(ch);
}

/** Reads a quoted CSS string starting at `start` (the quote). */
function readString(css: string, start: number): { end: number; closed: boolean; decoded: DecodedText } {
  const quote = css[start];
  const b = new DecodedBuilder();
  let i = start + 1;
  const contentStart = i;
  while (i < css.length) {
    const c = css[i]!;
    if (c === quote) {
      return { end: i + 1, closed: true, decoded: b.finish(i - contentStart) };
    }
    if (c === '\n') break;
    if (c === '\\') {
      const esc = readEscape(css, i);
      b.push(esc.text, i - contentStart);
      i = esc.end;
      continue;
    }
    b.pushVerbatim(c, i - contentStart);
    i++;
  }
  return { end: i, closed: false, decoded: b.finish(i - contentStart) };
}

/** Decodes one CSS escape starting at the backslash. */
function readEscape(css: string, start: number): { text: string; end: number } {
  const next = css[start + 1];
  if (next === undefined) return { text: '', end: start + 1 };
  if (next === '\n') return { text: '', end: start + 2 };
  const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(start + 1, start + 7));
  if (hex) {
    let end = start + 1 + hex[0].length;
    if (css[end] === '\r' && css[end + 1] === '\n') end += 2;
    else if (css[end] !== undefined && /\s/.test(css[end]!)) end += 1;
    const cp = Number.parseInt(hex[0], 16);
    const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return { text: valid ? String.fromCodePoint(cp) : '�', end };
  }
  return { text: next, end: start + 2 };
}

/** Reads the inside of url( ... ) starting after the parenthesis. */
function readUrl(css: string, start: number): { ref: CssReference; end: number } | undefined {
  let i = start;
  while (i < css.length && /\s/.test(css[i]!)) i++;
  const q = css[i];
  if (q === '"' || q === "'") {
    const s = readString(css, i);
    if (!s.closed) return undefined;
    let j = s.end;
    while (j < css.length && /\s/.test(css[j]!)) j++;
    if (css[j] !== ')') return undefined;
    return { ref: { kind: 'url', rawStart: i + 1, rawEnd: s.end - 1, quote: q, decoded: s.decoded }, end: j + 1 };
  }
  const b = new DecodedBuilder();
  const contentStart = i;
  let lastNonSpace = i;
  while (i < css.length && css[i] !== ')') {
    const c = css[i]!;
    if (c === '"' || c === "'" || c === '(') return undefined;
    if (c === '\\') {
      const esc = readEscape(css, i);
      b.push(esc.text, i - contentStart);
      i = esc.end;
      lastNonSpace = i;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // whitespace inside an unquoted url is only allowed at the end
    if (i > lastNonSpace) return undefined;
    b.pushVerbatim(c, i - contentStart);
    i++;
    lastNonSpace = i;
  }
  if (css[i] !== ')') return undefined;
  const decoded = b.finish(lastNonSpace - contentStart);
  return { ref: { kind: 'url', rawStart: contentStart, rawEnd: lastNonSpace, quote: null, decoded }, end: i + 1 };
}

/** Escapes a URL for insertion into a CSS url()/string with the given quoting. */
export function escapeCssUrl(text: string, quote: '"' | "'" | null): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\a ';
    else if (quote && ch === quote) out += `\\${ch}`;
    else if (!quote && /[\s"'()]/.test(ch)) out += `\\${ch.codePointAt(0)!.toString(16)} `;
    else out += ch;
  }
  return out;
}
