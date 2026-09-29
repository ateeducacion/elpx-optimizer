import { basename } from '../zip/names.js';
import { decodePercent } from '../parse/uri.js';

/**
 * Resolution of reference strings to ZIP entries, following eXeLearning's
 * rules (verified in docs/upstream-review.md §8) without guessing: every
 * lenient match is reported as such, and ambiguity is never resolved by
 * picking a file silently.
 */

export type ReferenceForm =
  | 'context-path'
  | 'relative'
  | 'resources-legacy'
  | 'stale-editor-path'
  | 'asset-uri'
  | 'absolute-url'
  | 'protocol-relative'
  | 'root-relative'
  | 'local-file'
  | 'pseudo'
  | 'data-uri'
  | 'fragment'
  | 'empty';

export type ResolutionStatus = 'resolved' | 'missing' | 'ambiguous' | 'external' | 'ignored' | 'unmapped' | 'unresolvable';

/** How a resolved reference matched when it was not an exact path match. */
export type LenientRule =
  'basename' | 'case' | 'unicode' | 'double-slash' | 'literal-special' | 'backslash' | 'stale-editor-path' | 'multiple-prefixes' | 'escaped-quotes';

export interface Resolution {
  readonly form: ReferenceForm;
  readonly status: ResolutionStatus;
  /** ZIP path of the target when resolved. */
  readonly target?: string;
  /** Candidate paths for ambiguous references, or the expected path for missing ones. */
  readonly candidates?: readonly string[];
  readonly lenient?: LenientRule;
  /** The path contained %XX escapes that were decoded to find the file. */
  readonly percentEncoded?: boolean;
  /** Query string and fragment kept aside (with their leading ? or #). */
  readonly suffix: string;
}

/** Where a reference appears, which decides how relative paths resolve. */
export interface ResolveContext {
  /** 'editable' = content.xml/search index (rendered by eXeLearning), 'file' = a real file (HTML page, CSS). */
  readonly mode: 'editable' | 'file';
  /** ZIP path of the file containing the reference (for mode 'file'). */
  readonly source: string;
  /** Allow the basename fallback eXeLearning's browser importer applies. */
  readonly basenameFallback: boolean;
}

/** Lookup structure over the archive's file entries. */
export class EntryIndex {
  readonly files: ReadonlySet<string>;
  private readonly lower = new Map<string, string[]>();
  private readonly nfc = new Map<string, string[]>();
  private readonly base = new Map<string, string[]>();

  constructor(files: Iterable<string>, basenameScope: (path: string) => boolean = () => true) {
    const set = new Set<string>();
    for (const f of files) {
      set.add(f);
      push(this.lower, f.normalize('NFC').toLowerCase(), f);
      push(this.nfc, f.normalize('NFC'), f);
      if (basenameScope(f)) push(this.base, basename(f).normalize('NFC'), f);
    }
    this.files = set;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  byNfc(path: string): readonly string[] {
    return this.nfc.get(path.normalize('NFC')) ?? [];
  }

  byLower(path: string): readonly string[] {
    return this.lower.get(path.normalize('NFC').toLowerCase()) ?? [];
  }

  byBasename(name: string): readonly string[] {
    return this.base.get(name.normalize('NFC')) ?? [];
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export const CONTEXT_PATH = '{{context_path}}';

const PSEUDO_SCHEMES = new Set(['exe-node', 'exe-package', 'javascript', 'mailto', 'tel', 'sms', 'about', 'blob', 'geo']);

/** Splits a reference into path and query/fragment suffix. */
export function splitSuffix(value: string): { path: string; suffix: string } {
  const q = value.search(/[?#]/);
  return q < 0 ? { path: value, suffix: '' } : { path: value.slice(0, q), suffix: value.slice(q) };
}

/** Classifies and resolves a reference string. */
export function resolveReference(raw: string, ctx: ResolveContext, index: EntryIndex): Resolution {
  const value = raw.trim();
  if (value === '') return { form: 'empty', status: 'ignored', suffix: '' };
  if (value.startsWith('#')) return { form: 'fragment', status: 'ignored', suffix: value };
  if (value.startsWith(CONTEXT_PATH)) {
    const rest = value.slice(CONTEXT_PATH.length).replace(/^\/+/, '');
    if (rest === '') return { form: 'context-path', status: 'ignored', suffix: '' };
    const { path, suffix } = splitSuffix(rest);
    const candidates = path.startsWith('content/resources/') ? [path] : [path, `content/${path}`, `content/resources/${path}`, `resources/${path}`];
    // eXeLearning's browser importer falls back to the file name for placeholders.
    return lookup('context-path', candidates, suffix, true, index);
  }
  // Values wrapped in stray quotes or escaped quotes (a known upstream escaping bug) are
  // classified by their content; they are never treated as local paths.
  const unquoted = value.replace(/^(?:\\?["'])+/, '').replace(/(?:\\?["'])+$/, '');
  if (unquoted !== value && /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(unquoted)) {
    return { form: 'absolute-url', status: 'external', suffix: '' };
  }
  if (unquoted !== value && unquoted.startsWith(CONTEXT_PATH)) {
    // Markup whose quotes were escaped twice (\"...\"): eXeLearning's importer still matches the
    // placeholder and strips the trailing backslash, so resolve it the same way, flagged as lenient.
    const inner = resolveReference(unquoted.replace(/\\+$/, ''), ctx, index);
    return inner.status === 'resolved' ? { ...inner, lenient: 'escaped-quotes' } : inner;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (scheme && !/^[a-zA-Z]:[\\/]/.test(value)) {
    const s = scheme[1]!.toLowerCase();
    if (s === 'asset') return { form: 'asset-uri', status: 'unmapped', suffix: '' };
    if (s === 'data') return { form: 'data-uri', status: 'ignored', suffix: '' };
    if (s === 'file') return { form: 'local-file', status: 'unresolvable', suffix: '' };
    if (PSEUDO_SCHEMES.has(s)) return { form: 'pseudo', status: 'ignored', suffix: '' };
    return { form: 'absolute-url', status: 'external', suffix: '' };
  }
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return { form: 'local-file', status: 'unresolvable', suffix: '' };
  if (value.startsWith('//')) return { form: 'protocol-relative', status: 'external', suffix: '' };
  if (value.startsWith('/')) return { form: 'root-relative', status: 'unresolvable', suffix: '' };
  const { path, suffix } = splitSuffix(value);
  if (ctx.mode === 'editable') {
    if (path.startsWith('resources/')) {
      return lookup('resources-legacy', [`content/${path}`, path], suffix, true, index);
    }
    const stale = /^(?:\.\.\/)*files\/tmp\/(?:[^/]+\/)*?([^/]+\/[^/]+)$/.exec(path);
    if (path.startsWith('files/tmp/') && stale) {
      const r = lookup('stale-editor-path', [`content/resources/${stale[1]!}`], suffix, false, index);
      return r.status === 'resolved' ? { ...r, lenient: 'stale-editor-path' } : r;
    }
    const rel = normalizeRelative('', path);
    if (rel === undefined) return { form: 'relative', status: 'unresolvable', suffix };
    return lookup('relative', [rel], suffix, ctx.basenameFallback, index);
  }
  const dir = ctx.source.includes('/') ? ctx.source.slice(0, ctx.source.lastIndexOf('/') + 1) : '';
  const resolved = normalizeRelative(dir, path);
  if (resolved === undefined) return { form: 'relative', status: 'unresolvable', suffix };
  if (resolved === '' || resolved.endsWith('/')) {
    // A link to a folder: served as its index page when there is one.
    const indexPage = `${resolved}index.html`;
    return index.has(indexPage) ? { form: 'relative', status: 'resolved', target: indexPage, suffix } : { form: 'relative', status: 'ignored', suffix };
  }
  return lookup('relative', [resolved], suffix, ctx.basenameFallback, index);
}

/** Resolves "../" and "./" segments against a directory; undefined if it escapes the root. */
export function normalizeRelative(dir: string, path: string): string | undefined {
  const parts = (dir + path).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.') continue;
    if (p === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join('/');
}

/**
 * Looks up candidate paths: exact (percent-decoded), literal, with unencoded
 * "?"/"#" kept, collapsed slashes, backslashes, Unicode normalization, case,
 * then (when allowed) the basename fallback.
 */
function lookup(form: ReferenceForm, candidates: readonly string[], suffix: string, basenameFallback: boolean, index: EntryIndex): Resolution {
  const decoded = candidates.map((c) => decodeOnce(c));
  const percentEncoded = candidates.some((c, i) => decoded[i] !== c);
  const hits = unique(decoded.filter((c) => index.has(c)));
  if (hits.length >= 1) {
    return {
      form,
      status: 'resolved',
      target: hits[0]!,
      ...(hits.length > 1 ? { lenient: 'multiple-prefixes' as const, candidates: hits } : {}),
      ...(percentEncoded ? { percentEncoded } : {}),
      suffix,
    };
  }
  const tries: [LenientRule, (c: string) => string[]][] = [
    ['literal-special', (c) => (suffix && index.has(c + suffix) ? [c + suffix] : [])],
    [
      'double-slash',
      (c) => {
        const d = c.replace(/\/{2,}/g, '/');
        return d !== c && index.has(d) ? [d] : [];
      },
    ],
    [
      'backslash',
      (c) => {
        const d = c.replace(/\\/g, '/');
        return d !== c && index.has(d) ? [d] : [];
      },
    ],
    ['unicode', (c) => index.byNfc(c).filter((x) => x !== c)],
    ['case', (c) => index.byLower(c).filter((x) => x !== c)],
  ];
  for (const [rule, fn] of tries) {
    for (const c of [...candidates, ...decoded]) {
      const found = unique(fn(c));
      if (found.length === 1) {
        return {
          form,
          status: 'resolved',
          target: found[0]!,
          lenient: rule,
          ...(percentEncoded ? { percentEncoded } : {}),
          suffix: rule === 'literal-special' ? '' : suffix,
        };
      }
      if (found.length > 1) return { form, status: 'ambiguous', candidates: found, suffix };
    }
  }
  if (basenameFallback) {
    const name = basename(decoded[0] ?? '');
    const found = name ? unique(index.byBasename(name)) : [];
    if (found.length === 1) return { form, status: 'resolved', target: found[0]!, lenient: 'basename', suffix };
    if (found.length > 1) return { form, status: 'ambiguous', candidates: found, suffix };
  }
  return { form, status: 'missing', candidates: unique(decoded), ...(percentEncoded ? { percentEncoded } : {}), suffix };
}

/** Percent-decodes once; returns the input when it is not validly encoded. */
function decodeOnce(path: string): string {
  if (!path.includes('%')) return path;
  return decodePercent(path)?.text ?? path;
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}
