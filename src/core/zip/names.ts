import { ElpxError } from '../errors.js';
import { cp437Decode, isAscii, isValidUtf8, utf8DecodeStrict } from '../io/text.js';

/** How an entry name was decoded from its raw bytes. */
export type NameEncoding = 'utf8-flag' | 'ascii' | 'utf8-guess' | 'cp437';

/** Decodes a raw ZIP entry name according to the general purpose flag bit 11. */
export function decodeEntryName(raw: Uint8Array, utf8Flag: boolean): { name: string; encoding: NameEncoding } {
  if (utf8Flag) return { name: utf8DecodeStrict(raw, 'ZIP entry name'), encoding: 'utf8-flag' };
  if (isAscii(raw)) return { name: utf8DecodeStrict(raw), encoding: 'ascii' };
  // Many tools write UTF-8 names without setting the flag; prefer UTF-8 when valid.
  if (isValidUtf8(raw)) return { name: utf8DecodeStrict(raw), encoding: 'utf8-guess' };
  return { name: cp437Decode(raw), encoding: 'cp437' };
}

/** Result of validating an entry name. */
export interface NameCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validates an entry name against path traversal and platform-specific
 * pitfalls. Rejects absolute paths, drive letters, UNC paths, backslashes,
 * dot segments, empty segments and control characters.
 */
export function checkEntryName(name: string, maxDepth: number): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'empty name' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: 'control character in name' };
  if (name.includes('\\')) return { ok: false, reason: 'backslash in name' };
  if (name.startsWith('/')) return { ok: false, reason: 'absolute path' };
  if (/^[A-Za-z]:/.test(name)) return { ok: false, reason: 'drive letter' };
  const isDir = name.endsWith('/');
  const segments = (isDir ? name.slice(0, -1) : name).split('/');
  if (segments.length > maxDepth) return { ok: false, reason: 'path too deep' };
  for (const seg of segments) {
    if (seg === '') return { ok: false, reason: 'empty path segment' };
    if (seg === '.' || seg === '..') return { ok: false, reason: 'dot segment (path traversal)' };
  }
  return { ok: true };
}

/** Throws a zip-security error when the name is unsafe. */
export function assertSafeEntryName(name: string, maxDepth: number): void {
  const check = checkEntryName(name, maxDepth);
  if (!check.ok) {
    throw new ElpxError('zip-security', `Unsafe entry name "${displayName(name)}": ${check.reason}`, {
      entry: displayName(name),
      reason: check.reason,
    });
  }
}

/** Escapes control characters so a hostile name is safe to print. */
export function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Returns the directory part of a ZIP path ("a/b/c.png" -> "a/b"). */
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Returns the last path segment ("a/b/c.png" -> "c.png"). */
export function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** Returns the lower-case extension without dot, or '' ("a/B.JPG" -> "jpg"). */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}
