import { ElpxError } from '../errors.js';
export { utf8Encode } from './hash.js';

interface Decoder {
  decode(input: Uint8Array): string;
}
type DecoderCtor = new (label: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => Decoder;

const DecoderImpl = (globalThis as unknown as { TextDecoder: DecoderCtor }).TextDecoder;
const strictUtf8 = new DecoderImpl('utf-8', { fatal: true, ignoreBOM: true });
const lenientUtf8 = new DecoderImpl('utf-8', { fatal: false, ignoreBOM: true });

/** Decodes UTF-8 strictly; throws ElpxError when bytes are not valid UTF-8. */
export function utf8DecodeStrict(bytes: Uint8Array, what = 'text'): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new ElpxError('io', `Invalid UTF-8 in ${what}`);
  }
}

/** Decodes UTF-8 replacing invalid sequences (for display only). */
export function utf8DecodeLenient(bytes: Uint8Array): string {
  return lenientUtf8.decode(bytes);
}

/** Returns true when the bytes form valid UTF-8. */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Decodes IBM code page 437, the legacy default for ZIP names without the UTF-8 flag. */
export function cp437Decode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

/** Returns true when every byte is 7-bit ASCII. */
export function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return false;
  return true;
}

/** Concatenates byte arrays into a single buffer. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Compares two byte arrays for equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
