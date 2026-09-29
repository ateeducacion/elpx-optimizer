/**
 * eXeLearning DataGame payload codecs.
 *
 * Games store their data in a hidden `<div class="<prefix>-DataGame">`. The
 * body is either plain JSON or an obfuscated form produced by upstream
 * `$exeDevices.iDevice.gamification.helpers.encrypt`: every UTF-16 code unit
 * is XORed with 146 and the result passed through the legacy JavaScript
 * `escape()` (common.js at the pinned upstream SHA). The legacy
 * `escape`/`unescape` semantics (%XX and %uXXXX) are reimplemented here
 * because they are not available in every runtime we target.
 */

const XOR_KEY = 146;
const ESCAPE_SAFE = /[A-Za-z0-9@*_+\-./]/;

/** Legacy JavaScript unescape(): decodes %XX and %uXXXX, leaving malformed sequences as-is. */
export function jsUnescape(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '%') {
      if (input[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 2, i + 6))) {
        out += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
        i += 5;
        continue;
      }
      if (/^[0-9a-fA-F]{2}$/.test(input.slice(i + 1, i + 3))) {
        out += String.fromCharCode(Number.parseInt(input.slice(i + 1, i + 3), 16));
        i += 2;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Legacy JavaScript escape(): %XX below 256, %uXXXX otherwise. */
export function jsEscape(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const code = c.charCodeAt(0);
    if (ESCAPE_SAFE.test(c)) out += c;
    else if (code < 256) out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    else out += `%u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** Decrypts an obfuscated DataGame payload (upstream helpers.decrypt). */
export function decryptDataGame(payload: string): string {
  const s = payload === 'undefined' || payload === 'null' ? '' : jsUnescape(payload);
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(XOR_KEY ^ s.charCodeAt(i));
  return out;
}

/** Encrypts a DataGame payload (upstream helpers.encrypt). */
export function encryptDataGame(text: string): string {
  let x = '';
  for (let i = 0; i < text.length; i++) x += String.fromCharCode(text.charCodeAt(i) ^ XOR_KEY);
  return jsEscape(x);
}

/** Classification of a DataGame div body. */
export type DataGameEncoding = 'json' | 'xor' | 'empty';

/** Detects how a DataGame body is encoded (upstream isJsonString / decrypt fallback). */
export function dataGameEncoding(body: string): DataGameEncoding {
  const t = body.trim();
  if (t === '') return 'empty';
  return t.startsWith('{') ? 'json' : 'xor';
}

/** Returns the game prefix of a DataGame class list ("clasifica-DataGame js-hidden" -> "clasifica"). */
export function dataGamePrefix(className: string): string | undefined {
  for (const token of className.split(/\s+/)) {
    const m = /^(.+)-DataGame$/.exec(token);
    if (m) return m[1];
  }
  return undefined;
}

/** Link-anchor class families that carry the real media URLs of games. */
export const DATAGAME_LINK_CLASS = /-(Link(?:Images|Audios|Back|Wordings|LocalVideo|TextsPoints)[A-Za-z]*)(?:-\d+)?$/;
