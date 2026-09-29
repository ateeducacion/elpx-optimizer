import type { TextEdit } from '../parse/text-map.js';
import type { Analysis, InventoryEntry, ReferenceInternal } from '../analyze/model.js';
import { entryRole } from '../analyze/analyze.js';
import { legacyFolderOf } from '../format/legacy-folders.js';
import { EntryIndex, resolveReference, type Resolution, type ResolveContext } from './resolve.js';
import { retargetValue } from './rewrite.js';
import { cleanFileName } from './slug.js';

/**
 * Package restructuring that rewrites references: exact deduplication,
 * flattening of eXeLearning 3 editor folders, and removal of references to
 * files that do not exist.
 *
 * Merges and moves are decided per file and then verified together: every
 * reference is resolved again against the final set of paths. A rewritten
 * reference must resolve exactly to its file's new path, and every other
 * reference must resolve exactly as before. Changes that break either rule
 * are cancelled until the whole set is consistent, so a file is only merged
 * or moved when all its references can follow it.
 */

export interface RestructureOptions {
  readonly deduplicate: boolean;
  readonly flatten: boolean;
  readonly removeMissing: boolean;
  /** Paths the user asked to leave untouched. */
  readonly excluded: ReadonlySet<string>;
  /** Files already removed by the unused-file cleanup. */
  readonly removed: ReadonlySet<string>;
  /** Files re-encoded into another format (e.g. WAV → MP3): path → new extension. */
  readonly convert?: ReadonlyMap<string, string>;
  /** Names chosen by the plan for converted files: execution keeps them (a name freed by a failed conversion is not reused). */
  readonly convertNames?: ReadonlyMap<string, string>;
  /** Give user files clean names (lower case, no spaces, accents or copy markers; see slug.ts). */
  readonly normalizeNames?: boolean;
}

export interface MergeDecision {
  /** Original path of the file that stays (it may also be moved). */
  readonly keep: string;
  readonly remove: readonly string[];
  /** Number of references rewritten per removed path. */
  readonly rewritten: Readonly<Record<string, number>>;
}

export interface MoveDecision {
  readonly from: string;
  readonly to: string;
  readonly references: number;
}

export interface UnlinkDecision {
  /** The missing path (or the reference itself when it is not a package path). */
  readonly key: string;
  readonly references: number;
  /** How the references were taken out: whole elements, attributes, or emptied data values. */
  readonly actions: { readonly element: number; readonly attribute: number; readonly value: number };
  readonly entries: readonly string[];
}

export interface RestructureSkip {
  readonly path: string;
  readonly kind: 'duplicate' | 'flatten' | 'missing-reference' | 'convert' | 'rename';
  readonly reason: string;
}

export interface RestructurePlan {
  readonly merges: readonly MergeDecision[];
  readonly moves: readonly MoveDecision[];
  /** Files renamed because their format changes (they may also have been moved out of an editor folder). */
  readonly conversions: readonly MoveDecision[];
  /** Files that only got a clean name (moved and converted files are reported as such). */
  readonly renamed: readonly MoveDecision[];
  readonly unlinks: readonly UnlinkDecision[];
  readonly skipped: readonly RestructureSkip[];
  /** Edits per text entry (raw offsets in the entry text). */
  readonly edits: ReadonlyMap<string, readonly TextEdit[]>;
  /** Moved files: original path → new path. */
  readonly renames: ReadonlyMap<string, string>;
  /** Files dropped because they were merged into an identical one. */
  readonly merged: ReadonlySet<string>;
  /** Directory entries that no longer contain any file. */
  readonly emptiedDirectories: readonly string[];
}

/** Elements deleted as a whole when the reference in the given attribute points to a missing file. */
const ELEMENT_ON_MISSING: Readonly<Record<string, readonly string[]>> = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  track: ['src'],
  embed: ['src'],
  input: ['src'],
  link: ['href'],
  param: ['value'],
  video: ['src'],
  audio: ['src'],
  iframe: ['src'],
  object: ['data'],
  script: ['src'],
};

/** Representations whose references are taken out when broken (never the user's own files or runtime assets). */
const UNLINK_SCOPE = new Set(['editable', 'published', 'search-index']);

/** Plans merges, moves and reference removals. Pure and deterministic: execution replays it. */
export function planRestructure(analysis: Analysis, options: RestructureOptions): RestructurePlan {
  const entries = analysis.result.entries;
  const inventory = new Map(entries.map((e) => [e.path, e]));
  const alive = entries.filter((e) => !e.isDirectory && !options.removed.has(e.path)).map((e) => e.path);
  const byTarget = referencesByTarget(analysis.references);
  const sources = new Set(analysis.references.map((r) => r.location.entry ?? ''));
  const skipped: RestructureSkip[] = [];
  const mergeInto = new Map<string, { keep: string; kind: 'duplicate' | 'flatten' }>();
  const moveTo = new Map<string, string>();
  const flattened = new Set<string>();
  const staticReason = (path: string, contentMatters: boolean): string | undefined =>
    cannotRetarget(path, options.excluded, inventory, byTarget, contentMatters);

  // 1. Exact duplicates.
  if (options.deduplicate) {
    for (const group of analysis.result.duplicates) {
      const members = group.paths.filter((p) => !options.removed.has(p));
      if (members.length < 2) continue;
      const keep = chooseKeep(members, inventory);
      for (const path of members) {
        if (path === keep) continue;
        const reason = options.excluded.has(keep) ? 'excluded by the user' : staticReason(path, true);
        if (reason) skipped.push({ path, kind: 'duplicate', reason });
        else mergeInto.set(path, { keep, kind: 'duplicate' });
      }
    }
  }

  // 2. eXeLearning 3 editor folders.
  if (options.flatten) {
    const candidates = alive.filter((p) => legacyFolderOf(p) && !mergeInto.has(p)).sort();
    const candidateSet = new Set(candidates);
    const occupied = new Map<string, string>();
    for (const p of alive) {
      if (candidateSet.has(p) || mergeInto.has(p)) continue;
      occupy(occupied, p, p);
    }
    for (const path of candidates) {
      const reason = staticReason(path, false) ?? (sources.has(path) ? 'contains references to other files' : undefined);
      if (reason) {
        skipped.push({ path, kind: 'flatten', reason });
        occupy(occupied, path, path);
        continue;
      }
      const target = `content/resources/${legacyFolderOf(path)!.name}`;
      const occupant = occupied.get(slot(target));
      if (occupant !== undefined && !options.excluded.has(occupant) && sameContent(path, occupant, inventory)) {
        mergeInto.set(path, { keep: occupant, kind: 'flatten' });
        continue;
      }
      const to = freeName(target, occupied);
      moveTo.set(path, to);
      flattened.add(path);
      occupy(occupied, to, path);
    }
  }

  // 3. Converted files get their new extension (after any move); their references follow them.
  const converting = new Set<string>();
  if (options.convert && options.convert.size > 0) {
    const occupied = new Map<string, string>();
    for (const p of alive) if (!mergeInto.has(p) && !options.convert.has(p)) occupy(occupied, moveTo.get(p) ?? p, p);
    for (const [path, ext] of [...options.convert].sort(([a], [b]) => compare(a, b))) {
      if (mergeInto.has(path) || options.removed.has(path) || !inventory.has(path)) continue;
      const reason = staticReason(path, false) ?? typeMismatch(path, ext, byTarget);
      if (reason) {
        skipped.push({ path, kind: 'convert', reason });
        occupy(occupied, moveTo.get(path) ?? path, path);
        continue;
      }
      const base = moveTo.get(path) ?? path;
      const to = freeName(options.convertNames?.get(path) ?? withExtension(base, ext), occupied);
      moveTo.set(path, to);
      converting.add(path);
      occupy(occupied, to, path);
    }
  }

  // 3b. Clean names, after any move or conversion; a taken name gets -2, -3… (as WordPress does).
  const normalized = new Set<string>();
  if (options.normalizeNames) {
    const occupied = new Map<string, string>();
    const candidates: string[] = [];
    for (const p of alive) {
      if (mergeInto.has(p)) continue;
      const current = moveTo.get(p) ?? p;
      const name = current.slice(current.lastIndexOf('/') + 1);
      if (entryRole(p) === 'user-asset' && !p.startsWith('custom/') && cleanFileName(name) !== name) candidates.push(p);
      else occupy(occupied, current, p);
    }
    // Folders with HTML or scripts are opaque: their code may name any of their files, referenced or not.
    const bundles = analysis.result.diagnostics.filter((d) => d.code === 'opaque-bundle').map((d) => d.resource!);
    const inBundle = (path: string): string | undefined => {
      const bundle = bundles.find((b) => path.startsWith(b));
      return bundle ? `inside ${bundle}, which contains HTML or scripts` : undefined;
    };
    // Files that keep their name are placed first, so that no clean name takes theirs.
    const renaming: string[] = [];
    for (const path of candidates.sort(compare)) {
      const reason = staticReason(path, false) ?? (sources.has(path) ? 'contains references to other files' : inBundle(path));
      if (!reason) {
        renaming.push(path);
        continue;
      }
      skipped.push({ path, kind: 'rename', reason });
      occupy(occupied, moveTo.get(path) ?? path, path);
    }
    for (const path of renaming) {
      const current = moveTo.get(path) ?? path;
      const dir = current.slice(0, current.lastIndexOf('/') + 1);
      const to = freeName(dir + cleanFileName(current.slice(dir.length)), occupied, '-');
      moveTo.set(path, to);
      normalized.add(path);
      occupy(occupied, to, path);
    }
  }

  // 4. Verify merges and moves together; cancel what does not hold.
  // Each failing round cancels at least one change, so this ends (at the latest with no changes left).
  let outcome = verify(analysis, alive, mergeInto, moveTo);
  while (outcome.failures.size > 0) {
    for (const [path, reason] of outcome.failures) {
      const merge = mergeInto.get(path);
      if (merge) {
        mergeInto.delete(path);
        skipped.push({ path, kind: merge.kind, reason });
      }
      if (moveTo.delete(path)) {
        const kind = converting.has(path) ? 'convert' : flattened.has(path) ? 'flatten' : 'rename';
        converting.delete(path);
        flattened.delete(path);
        normalized.delete(path);
        skipped.push({ path, kind, reason });
        // Identical copies only merged because this file was moving stay where they are.
        for (const [other, m] of [...mergeInto]) {
          if (m.keep === path && m.kind === 'flatten') {
            mergeInto.delete(other);
            skipped.push({ path: other, kind: 'flatten', reason: `identical to ${path}, which stays in place` });
          }
        }
      }
    }
    outcome = verify(analysis, alive, mergeInto, moveTo);
  }
  const edits = outcome.edits;
  const rewrittenCount = outcome.rewritten;

  // 5. References to missing files.
  const unlinks: UnlinkDecision[] = [];
  if (options.removeMissing) planUnlinks(analysis, edits, unlinks, skipped);

  const merges: MergeDecision[] = [];
  const byKeep = new Map<string, string[]>();
  for (const [path, m] of mergeInto) byKeep.set(m.keep, [...(byKeep.get(m.keep) ?? []), path]);
  for (const [keep, remove] of [...byKeep].sort(([a], [b]) => compare(a, b))) {
    const sorted = [...remove].sort(compare);
    merges.push({ keep, remove: sorted, rewritten: Object.fromEntries(sorted.map((p) => [p, rewrittenCount.get(p) ?? 0])) });
  }
  const decisions = [...moveTo].sort(([a], [b]) => compare(a, b)).map(([from, to]) => ({ from, to, references: rewrittenCount.get(from) ?? 0 }));
  const moves = decisions.filter((d) => !converting.has(d.from) && flattened.has(d.from));
  const conversions = decisions.filter((d) => converting.has(d.from));
  const renamed = decisions.filter((d) => !converting.has(d.from) && !flattened.has(d.from));
  const merged = new Set(mergeInto.keys());
  const finalFiles = alive.filter((p) => !merged.has(p)).map((p) => moveTo.get(p) ?? p);
  const changed = [...merged, ...moveTo.keys()];
  // Folders emptied by moves and merges go too, and so do empty eXeLearning 3 editor folders when flattening.
  const emptiedDirectories = entries
    .filter((e) => e.isDirectory)
    .map((e) => e.path)
    .filter((d) => (changed.some((p) => p.startsWith(d)) || (options.flatten && legacyFolderOf(`${d}x`))) && !finalFiles.some((p) => p.startsWith(d)));
  return {
    merges,
    moves,
    conversions,
    renamed,
    unlinks,
    skipped: dedupeSkips(skipped),
    edits: normalizeEdits(edits),
    renames: new Map(moveTo),
    merged,
    emptiedDirectories,
  };
}

/** Replaces a path's extension. */
function withExtension(path: string, ext: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return `${dot > slash ? path.slice(0, dot) : path}.${ext}`;
}

/** MIME types a `type` attribute may declare for each converted format; the first is written. */
const TYPE_FOR: Readonly<Record<string, readonly string[]>> = { mp3: ['audio/mpeg', 'audio/mp3'], m4a: ['audio/mp4', 'audio/aac', 'audio/x-m4a'] };

function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot + 1).toLowerCase() : '';
}

/** The declared type of the element holding a reference, when it no longer matches the new format. */
function staleType(ref: ReferenceInternal, ext: string): string | undefined {
  const type = ref.element?.attributes?.['type']?.trim().toLowerCase().split(';')[0];
  return type && TYPE_FOR[ext] && !TYPE_FOR[ext].includes(type) ? type : undefined;
}

/** A `type="audio/wav"` that cannot be rewritten would make browsers skip the converted file. */
function typeMismatch(path: string, ext: string, byTarget: ReadonlyMap<string, readonly ReferenceInternal[]>): string | undefined {
  for (const ref of byTarget.get(path) ?? []) {
    const type = staleType(ref, ext);
    if (type && !ref.element?.typeSpan) return `a ${ref.element!.tag} declares type="${type}", which cannot be updated`;
  }
  return undefined;
}

/** Case- and normalization-insensitive key for a path, as file systems compare names. */
function slot(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** Marks a file path and its parent folders as taken. */
function occupy(occupied: Map<string, string>, path: string, owner: string): void {
  occupied.set(slot(path), owner);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = `${slot(parts.slice(0, i).join('/'))}/`;
    if (!occupied.has(dir)) occupied.set(dir, '');
  }
}

/** First free name: name.ext, name_2.ext, name_3.ext… (a folder with the same name also counts as taken). */
function freeName(target: string, occupied: ReadonlyMap<string, string>, separator = '_'): string {
  const dot = target.lastIndexOf('.');
  const slash = target.lastIndexOf('/');
  const [base, ext] = dot > slash + 1 ? [target.slice(0, dot), target.slice(dot)] : [target, ''];
  const taken = (p: string): boolean => occupied.has(slot(p)) || occupied.has(`${slot(p)}/`);
  let candidate = target;
  for (let n = 2; taken(candidate); n++) candidate = `${base}${separator}${n}${ext}`;
  return candidate;
}

function sameContent(a: string, b: string, inventory: ReadonlyMap<string, InventoryEntry>): boolean {
  const ga = inventory.get(a)?.duplicateGroup;
  return ga !== undefined && ga === inventory.get(b)?.duplicateGroup;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Chooses the file to keep in a duplicate group: most references, then shortest path. */
function chooseKeep(paths: readonly string[], inventory: ReadonlyMap<string, InventoryEntry>): string {
  return [...paths].sort((a, b) => {
    const ra = inventory.get(a)?.references ?? 0;
    const rb = inventory.get(b)?.references ?? 0;
    return rb - ra || a.length - b.length || compare(a, b);
  })[0]!;
}

/** References that resolve to, or could resolve to, each path. */
function referencesByTarget(references: readonly ReferenceInternal[]): Map<string, ReferenceInternal[]> {
  const byTarget = new Map<string, ReferenceInternal[]>();
  const add = (path: string, r: ReferenceInternal): void => {
    const list = byTarget.get(path);
    if (list) list.push(r);
    else byTarget.set(path, [r]);
  };
  for (const r of references) {
    if (r.target) add(r.target, r);
    for (const c of r.candidates ?? []) if (c !== r.target) add(c, r);
  }
  return byTarget;
}

/** Returns why a file cannot be merged or moved, or undefined when all its references can follow it. */
function cannotRetarget(
  path: string,
  excluded: ReadonlySet<string>,
  inventory: ReadonlyMap<string, InventoryEntry>,
  byTarget: ReadonlyMap<string, readonly ReferenceInternal[]>,
  contentMatters: boolean,
): string | undefined {
  if (excluded.has(path)) return 'excluded by the user';
  const entry = inventory.get(path);
  if (!entry) return 'not in the inventory';
  if (entry.usage === 'protected') return `protected: ${entry.usageReasons.join('; ')}`;
  if (entry.usage === 'uncertain') return `uncertain references: ${entry.usageReasons.join('; ')}`;
  if (entry.usage === 'used' && entry.usageReasons.length > 0) return `also matched by lenient or dynamic references: ${entry.usageReasons.join('; ')}`;
  if (contentMatters && entry.extensionMatches === false) return 'content does not match the extension';
  for (const ref of byTarget.get(path) ?? []) {
    if (ref.kind !== 'explicit') return 'referenced from code or obfuscated data';
    if (ref.status !== 'resolved' || ref.target !== path) return 'referenced ambiguously';
    if (ref.lenient) return `reference matches only by ${ref.lenient}`;
    if (!ref.rewritable) return `reference in ${ref.via.join(' › ')} cannot be rewritten`;
  }
  return undefined;
}

function contextFor(ref: ReferenceInternal): ResolveContext {
  return ref.representation === 'editable' || ref.representation === 'search-index'
    ? { mode: 'editable', source: ref.location.entry ?? '', basenameFallback: false }
    : { mode: 'file', source: ref.location.entry ?? '', basenameFallback: false };
}

interface Verification {
  readonly edits: Map<string, TextEdit[]>;
  readonly rewritten: Map<string, number>;
  /** Original path of a merged or moved file → why the change cannot be kept. */
  readonly failures: Map<string, string>;
}

/** Resolves every reference against the final set of paths (see the module comment). */
function verify(
  analysis: Analysis,
  alive: readonly string[],
  mergeInto: ReadonlyMap<string, { keep: string }>,
  moveTo: ReadonlyMap<string, string>,
): Verification {
  const finalPath = (p: string): string => {
    const merge = mergeInto.get(p);
    const base = merge ? merge.keep : p;
    return moveTo.get(base) ?? base;
  };
  const movedFrom = new Map([...moveTo].map(([from, to]) => [to, from]));
  const future = new EntryIndex(alive.filter((p) => !mergeInto.has(p)).map(finalPath), (p) => entryRole(p) === 'user-asset');
  const edits = new Map<string, TextEdit[]>();
  const rewritten = new Map<string, number>();
  const failures = new Map<string, string>();
  const fail = (path: string, reason: string): void => {
    if (!failures.has(path)) failures.set(path, reason);
  };
  // A new name may not differ from another file's only in letter case or Unicode form (the same file on many
  // systems): this happens when a change that freed that name for another file is cancelled.
  const bySlot = new Map<string, string[]>();
  for (const p of future.files) bySlot.set(slot(p), [...(bySlot.get(slot(p)) ?? []), p]);
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    for (const p of group) {
      const from = movedFrom.get(p);
      if (from !== undefined) fail(from, `${p} would differ only in letter case from ${group.filter((o) => o !== p).join(', ')}`);
    }
  }
  for (const ref of analysis.references) {
    const target = ref.status === 'resolved' ? ref.target : undefined;
    const ctx = contextFor(ref);
    if (target !== undefined && finalPath(target) !== target) {
      const to = finalPath(target);
      const value = retargetValue(ref, to);
      if (value === undefined) {
        fail(target, `reference in ${ref.location.entry ?? '?'} cannot be expressed for ${to}`);
        continue;
      }
      const check = resolveReference(value, ctx, future);
      if (check.status !== 'resolved' || check.target !== to || check.lenient) {
        fail(target, `rewritten reference would not resolve exactly to ${to}`);
        continue;
      }
      const lifted = ref.site?.lift({ start: ref.site.start, end: ref.site.end, text: value });
      if (!ref.site || !lifted) {
        fail(target, `reference in ${ref.location.entry ?? '?'} cannot be rewritten in its encoding`);
        continue;
      }
      const list = edits.get(ref.site.entry) ?? [];
      list.push(lifted);
      // A new format also updates the element's declared type (<source type="audio/wav"> → audio/mpeg).
      const ext = extensionOf(to);
      if (ext !== extensionOf(target) && staleType(ref, ext)) {
        const el = ref.element!;
        const typeEdit = el.lift({ start: el.typeSpan!.start, end: el.typeSpan!.end, text: TYPE_FOR[ext]![0]! });
        if (!typeEdit) {
          fail(target, `the type attribute in ${ref.location.entry ?? '?'} cannot be updated`);
          continue;
        }
        list.push(typeEdit);
      }
      edits.set(ref.site.entry, list);
      rewritten.set(target, (rewritten.get(target) ?? 0) + 1);
      continue;
    }
    if (mergeInto.size === 0 && moveTo.size === 0) continue;
    const again = resolveReference(ref.value, ctx, future);
    if (sameResolution(ref, again)) continue;
    // A new path now captures this reference: the move that created it cannot be kept.
    const culprits = [again.target, ...(again.candidates ?? [])].filter((p): p is string => p !== undefined && movedFrom.has(p));
    const reason = `would change how "${ref.value.length > 80 ? `${ref.value.slice(0, 80)}…` : ref.value}" resolves`;
    if (culprits.length > 0) for (const c of culprits) fail(movedFrom.get(c)!, reason);
    else for (const p of [...mergeInto.keys(), ...moveTo.keys()]) fail(p, reason);
  }
  return { edits, rewritten, failures };
}

function sameResolution(ref: ReferenceInternal, again: Resolution): boolean {
  const set = (list: readonly string[] | undefined): string => [...(list ?? [])].sort().join('\n');
  return again.status === ref.status && again.target === ref.target && again.lenient === ref.lenient && set(again.candidates) === set(ref.candidates);
}

/** True for references whose target cannot exist in the package. */
function isBroken(ref: ReferenceInternal): boolean {
  return ref.status === 'missing' || ref.status === 'unmapped' || (ref.status === 'unresolvable' && ref.form === 'local-file');
}

/** Groups references to the same missing file: its expected package path (content/resources/… when a placeholder names it). */
function unlinkKey(ref: ReferenceInternal): string {
  const candidates = ref.status === 'missing' ? (ref.candidates ?? []) : [];
  return candidates.find((c) => c.startsWith('content/resources/')) ?? candidates[0] ?? ref.value;
}

/** Why a broken reference cannot be taken out automatically. */
function unlinkBlocker(ref: ReferenceInternal): string | undefined {
  if (!ref.site || !ref.removal) {
    const where = ref.via.join(' › ');
    if (where.includes('css')) return 'in a stylesheet; only HTML attributes and data values are removed';
    if (!ref.rewritable) return `in ${where || 'its location'}, which cannot be rewritten`;
    return `inside text in ${where || 'its location'}; only HTML attributes and data values are removed`;
  }
  if (ref.removal.kind !== 'json-string' && !ref.element) return 'the element holding it cannot be edited';
  return undefined;
}

type UnlinkAction = 'element' | 'attribute' | 'value';

/** Plans the removal of broken references and adds the edits. */
function planUnlinks(analysis: Analysis, edits: Map<string, TextEdit[]>, unlinks: UnlinkDecision[], skipped: RestructureSkip[]): void {
  const broken = analysis.references.filter((r) => r.kind === 'explicit' && UNLINK_SCOPE.has(r.representation) && isBroken(r));
  const removable = broken.filter((r) => {
    const reason = unlinkBlocker(r);
    if (reason) skipped.push({ path: unlinkKey(r), kind: 'missing-reference', reason });
    return !reason;
  });
  const removing = new Set(removable.map((r) => r.id));
  // Every reference held by the same element, to know whether the element can go as a whole.
  const byElement = new Map<string, ReferenceInternal[]>();
  const elementKey = (r: ReferenceInternal): string | undefined => {
    if (!r.element) return undefined;
    const at = r.element.lift({ start: r.element.key.start, end: r.element.key.end, text: '' });
    return at ? `${r.location.entry ?? ''}@${at.start}` : undefined;
  };
  for (const r of analysis.references) {
    const key = elementKey(r);
    if (key) byElement.set(key, [...(byElement.get(key) ?? []), r]);
  }
  const results = new Map<string, { refs: number; entries: Set<string>; actions: Record<UnlinkAction, number> }>();
  const record = (r: ReferenceInternal, action: UnlinkAction): void => {
    const key = unlinkKey(r);
    const agg = results.get(key) ?? { refs: 0, entries: new Set<string>(), actions: { element: 0, attribute: 0, value: 0 } };
    agg.refs++;
    agg.entries.add(r.site!.entry);
    agg.actions[action]++;
    results.set(key, agg);
  };
  const removals = new WeakSet<TextEdit>();
  const push = (entry: string, edit: TextEdit | undefined): boolean => {
    if (!edit) return false;
    const list = edits.get(entry) ?? [];
    // Never cut through another change, nor delete a range holding a rewritten reference.
    const clash = list.some((o) => {
      const disjoint = o.end <= edit.start || o.start >= edit.end;
      const inside = o.start >= edit.start && o.end <= edit.end;
      const around = edit.start >= o.start && edit.end <= o.end;
      return !disjoint && !(inside && removals.has(o)) && !(around && removals.has(o));
    });
    if (clash) return false;
    removals.add(edit);
    list.push(edit);
    edits.set(entry, list);
    return true;
  };
  const wholeElement = (r: ReferenceInternal, attribute: string): boolean => {
    const el = r.element!;
    if (!el.span || !(ELEMENT_ON_MISSING[el.tag] ?? []).includes(attribute)) return false;
    return (byElement.get(elementKey(r) ?? '') ?? [r]).every((s) => removing.has(s.id));
  };
  const srcsets = new Map<string, ReferenceInternal[]>();
  for (const r of removable) {
    const removal = r.removal!;
    const entry = r.site!.entry;
    if (removal.kind === 'json-string') {
      if (push(entry, removal.lift({ start: 0, end: removal.length, text: '' }))) record(r, 'value');
      else skipped.push({ path: unlinkKey(r), kind: 'missing-reference', reason: 'the data value cannot be edited in its encoding' });
      continue;
    }
    if (removal.kind === 'srcset') {
      const key = `${elementKey(r) ?? ''}#${removal.attribute}`;
      srcsets.set(key, [...(srcsets.get(key) ?? []), r]);
      continue;
    }
    const el = r.element!;
    const whole = wholeElement(r, removal.attribute);
    const span = whole ? el.span! : removal.span;
    if (push(entry, el.lift({ start: span.start, end: span.end, text: '' }))) record(r, whole ? 'element' : 'attribute');
    else skipped.push({ path: unlinkKey(r), kind: 'missing-reference', reason: 'the element cannot be edited in its encoding' });
  }
  for (const group of srcsets.values()) {
    const first = group[0]!;
    const removal = first.removal as Extract<NonNullable<ReferenceInternal['removal']>, { kind: 'srcset' }>;
    const el = first.element!;
    const entry = first.site!.entry;
    const gone = new Set(group.map((r) => (r.removal as typeof removal).index));
    const kept = removal.candidates.filter((_, i) => !gone.has(i));
    let edit: TextEdit | undefined;
    let action: UnlinkAction;
    if (kept.length > 0) {
      const value = kept.map((c) => removal.value.slice(c.start, c.end)).join(', ');
      edit = removal.valueLift({ start: 0, end: removal.valueLength, text: value });
      action = 'value';
    } else if (wholeElement(first, removal.attribute)) {
      edit = el.lift({ start: el.span!.start, end: el.span!.end, text: '' });
      action = 'element';
    } else {
      edit = el.lift({ start: removal.span.start, end: removal.span.end, text: '' });
      action = 'attribute';
    }
    if (push(entry, edit)) for (const r of group) record(r, action);
    else
      for (const r of group) skipped.push({ path: unlinkKey(r), kind: 'missing-reference', reason: 'the srcset attribute cannot be edited in its encoding' });
  }
  for (const [key, agg] of [...results].sort(([a], [b]) => compare(a, b))) {
    unlinks.push({ key, references: agg.refs, actions: agg.actions, entries: [...agg.entries].sort() });
  }
}

/**
 * Sorts edits and resolves nesting: an edit inside a removed element or
 * attribute is dropped (the enclosing removal covers it). Identical edits
 * collapse. Partial overlaps cannot come from well-formed markup; they are
 * refused rather than guessed.
 */
function normalizeEdits(edits: ReadonlyMap<string, readonly TextEdit[]>): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  for (const [entry, list] of [...edits].sort(([a], [b]) => compare(a, b))) {
    const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: TextEdit[] = [];
    for (const e of sorted) {
      const prev = kept[kept.length - 1];
      if (prev && e.start >= prev.start && e.end <= prev.end && (prev.text === '' || (e.start === prev.start && e.end === prev.end && e.text === prev.text))) {
        continue;
      }
      if (prev && e.start < prev.end) throw new Error(`Overlapping reference edits in ${entry}`);
      kept.push({ start: e.start, end: e.end, text: e.text });
    }
    out.set(entry, kept);
  }
  return out;
}

function dedupeSkips(list: readonly RestructureSkip[]): RestructureSkip[] {
  const seen = new Set<string>();
  const out: RestructureSkip[] = [];
  for (const s of list) {
    const key = `${s.kind}|${s.path}|${s.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => compare(a.path, b.path) || compare(a.kind, b.kind));
}
