import { JsonSyntaxError, parseJson, type JsonValue } from '../parse/json.js';

/**
 * `libs/elpx-manifest.js`, read as data (never evaluated). It lists the files
 * the download-source-file iDevice fetches to rebuild the package; since
 * upstream v4.0.3 it lists every ZIP entry with the manifest itself last.
 */

export const MANIFEST_PATH = 'libs/elpx-manifest.js';

export interface ElpxManifest {
  readonly version: number;
  readonly files: readonly string[];
  readonly projectTitle: string | undefined;
  /** Other top-level keys, preserved when regenerating. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** Text before the assignment (the header comment), preserved verbatim. */
  readonly prefix: string;
}

const ASSIGNMENT = /window\.__ELPX_MANIFEST__\s*=\s*/;

/** Parses the manifest script; returns undefined when it is not in the known form. */
export function parseManifest(text: string): ElpxManifest | { error: string } {
  const m = ASSIGNMENT.exec(text);
  if (!m) return { error: 'window.__ELPX_MANIFEST__ assignment not found' };
  const prefix = text.slice(0, m.index);
  if (/[^\s]/.test(prefix.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))) {
    return { error: 'unexpected code before the manifest assignment' };
  }
  const body = text.slice(m.index + m[0].length).replace(/;\s*$/, '');
  let value: JsonValue;
  try {
    value = parseJson(body.trim(), 16).root;
  } catch (error) {
    return { error: error instanceof JsonSyntaxError ? `manifest is not JSON data: ${error.message}` : 'manifest is not JSON data' };
  }
  const plain = toPlain(value);
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return { error: 'manifest is not an object' };
  const obj = plain as Record<string, unknown>;
  const files = obj['files'];
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) return { error: 'manifest "files" is not a list of strings' };
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (k !== 'version' && k !== 'files' && k !== 'projectTitle') extra[k] = v;
  return {
    version: typeof obj['version'] === 'number' ? obj['version'] : 1,
    files: files as string[],
    projectTitle: typeof obj['projectTitle'] === 'string' ? obj['projectTitle'] : undefined,
    extra,
    prefix,
  };
}

/** Converts a parsed JSON tree into plain JavaScript values. */
function toPlain(v: JsonValue): unknown {
  switch (v.kind) {
    case 'string':
      return v.value;
    case 'number':
      return Number(v.raw);
    case 'boolean':
      return v.raw === 'true';
    case 'null':
      return null;
    case 'array':
      return v.items.map(toPlain);
    case 'object':
      return Object.fromEntries(v.entries.map((e) => [e.key.value, toPlain(e.value)]));
  }
}

/**
 * Regenerates the manifest for the given final entry list, following the
 * upstream writer: original order for files that remain, new files appended,
 * the manifest self-reference last, JSON.stringify(..., null, 2) + ";\n".
 */
export function renderManifest(original: ElpxManifest, finalEntries: readonly string[]): string {
  const present = new Set(finalEntries.filter((e) => !e.endsWith('/') && e !== MANIFEST_PATH));
  const ordered: string[] = [];
  for (const f of original.files) if (present.has(f) && !ordered.includes(f)) ordered.push(f);
  for (const f of finalEntries) if (present.has(f) && !ordered.includes(f)) ordered.push(f);
  ordered.push(MANIFEST_PATH);
  const obj: Record<string, unknown> = { version: original.version, files: ordered };
  if (original.projectTitle !== undefined) obj['projectTitle'] = original.projectTitle;
  Object.assign(obj, original.extra);
  return `${original.prefix}window.__ELPX_MANIFEST__=${JSON.stringify(obj, null, 2)};\n`;
}

/** Compares a manifest with the archive entries. */
export function manifestDiff(manifest: ElpxManifest, entries: readonly string[]): { missing: string[]; unlisted: string[] } {
  const files = new Set(entries.filter((e) => !e.endsWith('/')));
  const listed = new Set(manifest.files);
  return {
    missing: manifest.files.filter((f) => !files.has(f)),
    unlisted: [...files].filter((f) => !listed.has(f)),
  };
}
