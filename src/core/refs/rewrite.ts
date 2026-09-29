import { applyEdits, type TextEdit } from '../parse/text-map.js';
import { encodePathLike } from '../parse/uri.js';
import { decodeHtmlRefs } from '../parse/html.js';
import { DecodingMode } from 'entities/decode';
import type { Analysis, InventoryEntry, ReferenceInternal } from '../analyze/model.js';
import { EntryIndex, CONTEXT_PATH, resolveReference, type ResolveContext } from './resolve.js';
import { entryRole } from '../analyze/analyze.js';

/**
 * Reference retargeting for exact deduplication. A duplicate is only removed
 * when every reference to it can be rewritten in its own encoding layers and
 * the rewritten reference resolves exactly to the kept file.
 */

export interface DedupDecision {
  readonly keep: string;
  readonly remove: readonly string[];
  readonly skipped: readonly { path: string; reason: string }[];
  /** Number of references rewritten per removed path. */
  readonly rewritten: Readonly<Record<string, number>>;
}

export interface DedupPlan {
  readonly decisions: readonly DedupDecision[];
  /** Edits per text entry (raw offsets in the entry text). */
  readonly edits: ReadonlyMap<string, readonly TextEdit[]>;
}

/** Computes the replacement URL for a reference so that it points to `target`. */
export function retargetValue(ref: ReferenceInternal, target: string): string | undefined {
  const suffixIndex = ref.value.search(/[?#]/);
  const suffix = suffixIndex >= 0 && ref.lenient !== 'literal-special' ? ref.value.slice(suffixIndex) : '';
  const editable = ref.representation === 'editable' || ref.representation === 'search-index';
  if (editable) {
    // eXeLearning looks placeholders up literally; characters that end its regexes, or an "&" that
    // HTML would read as a character reference, cannot be expressed so that both it and browsers agree.
    if (/[\s"'<>\\]/.test(target)) return undefined;
    if (decodeHtmlRefs(target, DecodingMode.Attribute).text !== target) return undefined;
    if (ref.form === 'resources-legacy' && target.startsWith('content/resources/')) {
      return `resources/${target.slice('content/resources/'.length)}${suffix}`;
    }
    if (ref.form === 'context-path' || ref.form === 'resources-legacy' || ref.form === 'relative') {
      return `${CONTEXT_PATH}/${target}${suffix}`;
    }
    return undefined;
  }
  if (ref.form !== 'relative') return undefined;
  const source = ref.location.entry ?? '';
  const fromDir = source.includes('/') ? source.slice(0, source.lastIndexOf('/')).split('/') : [];
  const to = target.split('/');
  let common = 0;
  while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common]) common++;
  const rel = [...fromDir.slice(common).map(() => '..'), ...to.slice(common)].join('/');
  const escapeNonAscii = /%[89A-Fa-f][0-9A-Fa-f]/.test(ref.value);
  return encodePathLike(rel, escapeNonAscii) + suffix;
}

/** Chooses the file to keep in a duplicate group: most references, then shortest path. */
function chooseKeep(paths: readonly string[], inventory: ReadonlyMap<string, InventoryEntry>): string {
  return [...paths].sort((a, b) => {
    const ra = inventory.get(a)?.references ?? 0;
    const rb = inventory.get(b)?.references ?? 0;
    return rb - ra || a.length - b.length || (a < b ? -1 : 1);
  })[0]!;
}

/** Plans exact deduplication with reference rewriting. */
export function planDeduplication(analysis: Analysis, excluded: ReadonlySet<string>, alsoRemoved: ReadonlySet<string>): DedupPlan {
  const inventory = new Map(analysis.result.entries.map((e) => [e.path, e]));
  const byTarget = new Map<string, ReferenceInternal[]>();
  for (const r of analysis.references) {
    if (r.target) {
      const list = byTarget.get(r.target) ?? [];
      list.push(r);
      byTarget.set(r.target, list);
    }
    for (const c of r.candidates ?? []) {
      if (c === r.target) continue;
      const list = byTarget.get(c) ?? [];
      list.push(r);
      byTarget.set(c, list);
    }
  }
  const removed = new Set(alsoRemoved);
  const decisions: DedupDecision[] = [];
  const edits = new Map<string, TextEdit[]>();
  for (const group of analysis.result.duplicates) {
    const members = group.paths.filter((p) => !removed.has(p));
    if (members.length < 2) continue;
    const keep = chooseKeep(members, inventory);
    const remove: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const rewritten: Record<string, number> = {};
    for (const path of members) {
      if (path === keep) continue;
      const reason = cannotDeduplicate(path, keep, excluded, inventory, byTarget);
      if (reason) {
        skipped.push({ path, reason });
        continue;
      }
      const refs = byTarget.get(path) ?? [];
      const future = new EntryIndex(
        analysis.result.entries.filter((e) => !e.isDirectory && !removed.has(e.path) && e.path !== path).map((e) => e.path),
        (p) => entryRole(p) === 'user-asset',
      );
      const pending: [string, TextEdit][] = [];
      let failure: string | undefined;
      for (const ref of refs) {
        const value = retargetValue(ref, keep);
        if (value === undefined) {
          failure = `reference in ${ref.location.entry ?? '?'} cannot be expressed for ${keep}`;
          break;
        }
        const ctx: ResolveContext =
          ref.representation === 'editable' || ref.representation === 'search-index'
            ? { mode: 'editable', source: ref.location.entry ?? '', basenameFallback: false }
            : { mode: 'file', source: ref.location.entry ?? '', basenameFallback: false };
        const check = resolveReference(value, ctx, future);
        if (check.status !== 'resolved' || check.target !== keep || check.lenient) {
          failure = `rewritten reference would not resolve exactly to ${keep}`;
          break;
        }
        const lifted = ref.site?.lift({ start: ref.site.start, end: ref.site.end, text: value });
        if (!ref.site || !lifted) {
          failure = `reference in ${ref.location.entry ?? '?'} cannot be rewritten in its encoding`;
          break;
        }
        pending.push([ref.site.entry, lifted]);
      }
      if (failure) {
        skipped.push({ path, reason: failure });
        continue;
      }
      for (const [entry, edit] of pending) {
        const list = edits.get(entry) ?? [];
        list.push(edit);
        edits.set(entry, list);
      }
      remove.push(path);
      removed.add(path);
      rewritten[path] = refs.length;
    }
    decisions.push({ keep, remove, skipped, rewritten });
  }
  return { decisions, edits };
}

/** Returns why a duplicate cannot be removed, or undefined when it can. */
function cannotDeduplicate(
  path: string,
  keep: string,
  excluded: ReadonlySet<string>,
  inventory: ReadonlyMap<string, InventoryEntry>,
  byTarget: ReadonlyMap<string, readonly ReferenceInternal[]>,
): string | undefined {
  if (excluded.has(path) || excluded.has(keep)) return 'excluded by the user';
  const entry = inventory.get(path);
  if (!entry) return 'not in the inventory';
  if (entry.usage === 'protected') return `protected: ${entry.usageReasons.join('; ')}`;
  if (entry.usage === 'uncertain') return `uncertain references: ${entry.usageReasons.join('; ')}`;
  if (entry.usage === 'used' && entry.usageReasons.length > 0) return `also matched by lenient or dynamic references: ${entry.usageReasons.join('; ')}`;
  if (entry.extensionMatches === false) return 'content does not match the extension';
  for (const ref of byTarget.get(path) ?? []) {
    if (ref.kind !== 'explicit') return 'referenced from code or obfuscated data';
    if (ref.status !== 'resolved' || ref.target !== path) return 'referenced ambiguously';
    if (ref.lenient) return `reference matches only by ${ref.lenient}`;
    if (!ref.rewritable) return `reference in ${ref.via.join(' › ')} cannot be rewritten`;
  }
  return undefined;
}

/** Applies edits to the text sources, returning the new texts by entry. */
export function applyTextEdits(texts: ReadonlyMap<string, { text: string }>, edits: ReadonlyMap<string, readonly TextEdit[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [entry, list] of edits) {
    const source = texts.get(entry);
    if (!source) throw new Error(`No text for ${entry}`);
    out.set(entry, applyEdits(source.text, list));
  }
  return out;
}
