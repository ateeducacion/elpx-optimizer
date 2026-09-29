import { ElpxError, errorMessage } from '../errors.js';
import { throwIfCancelled, type CancelSignal } from '../cancel.js';
import { diagnostic, sortDiagnostics, type Diagnostic, type DiagnosticCode } from '../diagnostics.js';
import type { Limits } from '../limits.js';
import { streamRange, type ByteSource } from '../io/byte-source.js';
import { Sha256 } from '../io/hash.js';
import { bytesEqual, utf8DecodeStrict } from '../io/text.js';
import { openZip, readEntry, readEntryBytes, type ZipArchive, type ZipEntry } from '../zip/reader.js';
import { basename, displayName, extname } from '../zip/names.js';
import { detectPackage, type Detection } from '../format/detect.js';
import { parseContentXml, type OdeDocument } from '../format/content-xml.js';
import { MANIFEST_PATH, manifestDiff, parseManifest, type ElpxManifest } from '../format/manifest.js';
import { SNIFF_BYTES, extensionMatches, sniff, type SniffResult } from '../media/sniff.js';
import { inspectImage, type ImageInfo } from '../media/image-inspect.js';
import type { ProbeResult } from '../media/probe.js';
import { effectiveDuration } from '../media/probe.js';
import type { MediaEngine, ProgressListener, ResourceStore } from '../media/engine.js';
import { EntryIndex, resolveReference, type ResolveContext } from '../refs/resolve.js';
import type { FoundReference } from '../refs/scan.js';
import { legacyFolderOf } from '../format/legacy-folders.js';
import { ANALYSIS_SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION, UPSTREAM_VERSION } from '../version.js';
import type {
  Analysis,
  AudioSummary,
  AnalysisResult,
  DuplicateGroup,
  EntryRole,
  ImageSummary,
  InventoryEntry,
  PackageSummary,
  ReferenceInternal,
  TextSource,
  Usage,
  VideoSummary,
} from './model.js';
import { scanContentXml, scanCssFile, scanHtmlFile, scanSearchIndex, type ScanSink } from './sources.js';

/** Options for analyzeArchive. */
export interface AnalyzeOptions {
  readonly limits: Limits;
  /** Display name of the input (never used to access files). */
  readonly inputName?: string;
  readonly signal?: CancelSignal;
  readonly onProgress?: ProgressListener;
  /** When provided, videos are probed with the engine's ffprobe. */
  readonly media?: { readonly engine: MediaEngine; readonly store: ResourceStore };
}

const RUNTIME_PREFIXES = ['theme/', 'libs/', 'idevices/', 'content/css/', 'content/img/'];
const PACKAGE_FILES = new Set(['content.xml', 'content.dtd', 'screenshot.png', 'search_index.js', MANIFEST_PATH]);
const RESOLUTION_SENSITIVE_TYPES = new Set(['magnifier', 'hidden-image', 'puzzle', 'map', 'beforeafter', 'identify', 'image-gallery']);
const DEDUP_KINDS = new Set(['image', 'video', 'audio', 'document', 'font']);
/** Audio formats inspected with ffprobe (those the audio policy can act on). */
const PROBED_AUDIO = new Set(['wav', 'aiff', 'flac', 'mp3', 'm4a']);
/** Extensions of images whose headers are inspected (other names are never decoded). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'apng']);
/** eXeLearning hosted import limits (importPolicy.ts). */
const HOSTED = { entry: 200 * 1024 * 1024, total: 500 * 1024 * 1024, entries: 10_000 };

/** Role of an entry from its path. */
export function entryRole(path: string): EntryRole {
  if (PACKAGE_FILES.has(path)) return 'package';
  if (path === 'index.html' || /^html\/[^/]+\.html?$/.test(path)) return 'page';
  if (RUNTIME_PREFIXES.some((p) => path.startsWith(p))) return 'runtime';
  if (path.startsWith('content/resources/') || path.startsWith('custom/')) return 'user-asset';
  return 'other';
}

/** Returns true for text files whose references we scan. */
function scannable(path: string, sniffed: SniffResult): 'html' | 'css' | undefined {
  const role = entryRole(path);
  const ext = extname(path);
  if (role === 'page') return 'html';
  if (ext === 'css' && (role === 'runtime' || role === 'user-asset')) return 'css';
  if (role === 'user-asset' && (ext === 'html' || ext === 'htm' || ext === 'xhtml' || sniffed.format === 'svg')) return 'html';
  return undefined;
}

/**
 * Analyzes an archive without modifying anything. Never throws for problems
 * in the input: fatal problems are reported with `ok: false`.
 */
export async function analyzeArchive(source: ByteSource, options: AnalyzeOptions): Promise<Analysis> {
  const { limits, signal } = options;
  const progress = options.onProgress ?? (() => undefined);
  const inputName = options.inputName ?? 'input.elpx';
  const diagnostics: Diagnostic[] = [];
  const empty = { entries: 0, files: 0, uncompressedBytes: 0, userAssetBytes: 0, imageBytes: 0, videoBytes: 0, audioBytes: 0 };
  const fail = (sha256: string, d: Diagnostic): Analysis => ({
    result: baseResult(inputName, source.size, sha256, false, empty, [], [], [], [...diagnostics, d]),
    texts: new Map(),
    references: [],
    probes: new Map(),
    images: new Map(),
  });

  progress({ stage: 'read', message: 'Hashing input' });
  const hasher = new Sha256();
  let done = 0;
  for await (const chunk of streamRange(source, 0, source.size, signal ? { signal } : {})) {
    hasher.update(chunk);
    done += chunk.length;
    progress({ stage: 'read', fraction: Math.min(0.99, source.size ? done / source.size : 0) });
  }
  const inputSha = hasher.digestHex();

  let archive: ZipArchive;
  try {
    archive = await openZip(source, limits, signal);
  } catch (error) {
    if (error instanceof ElpxError && error.code === 'cancelled') throw error;
    if (error instanceof ElpxError && error.code === 'not-a-zip') {
      const head = await source.read(0, Math.min(SNIFF_BYTES, source.size));
      const s = sniff(head, inputName);
      const hint = s.format === 'txt' || s.kind === 'unknown' ? '' : ` (it looks like ${s.format.toUpperCase()})`;
      return fail(inputSha, diagnostic('not-a-zip', `The file is not a ZIP archive${hint}; .elpx projects are ZIP files`));
    }
    return fail(inputSha, errorDiagnostic(error));
  }
  for (const w of archive.warnings) diagnostics.push(diagnostic(w.code, w.message, w.entry ? { resource: w.entry } : {}));

  const detection: Detection = detectPackage(archive);
  if (detection.kind !== 'elpx') {
    const code: DiagnosticCode = detection.kind === 'legacy-elp' ? 'legacy-elp' : 'not-an-elpx';
    return withArchive(fail(inputSha, diagnostic(code, detection.reason)), archive);
  }

  // content.xml (editable representation)
  let ode: OdeDocument;
  let contentText: string;
  try {
    const bytes = await readEntryBytes(archive, archive.byName.get('content.xml')!, limits.maxTextEntryBytes, signal ? { signal } : {});
    contentText = utf8DecodeStrict(bytes, 'content.xml');
    ode = parseContentXml(contentText, limits.maxXmlDepth);
  } catch (error) {
    if (error instanceof ElpxError && error.code === 'cancelled') throw error;
    const d = errorDiagnostic(error, 'content-xml-invalid');
    return withArchive(fail(inputSha, { ...d, location: { entry: 'content.xml', ...(d.location ?? {}) } }), archive);
  }
  diagnostics.push(...ode.diagnostics);

  // Integrity pass: every entry is inflated, CRC-checked and sniffed.
  const files = archive.entries.filter((e) => !e.isDirectory);
  const sniffs = new Map<string, SniffResult>();
  const texts = new Map<string, TextSource>();
  texts.set('content.xml', { entry: 'content.xml', text: contentText });
  const images = new Map<string, ImageInfo>();
  let manifest: ElpxManifest | undefined;
  let item = 0;
  for (const entry of files) {
    throwIfCancelled(signal);
    item++;
    progress({ stage: 'analyze', resource: entry.name, item, items: files.length, fraction: Math.min(0.99, item / files.length) });
    try {
      await inspectEntry(archive, entry, limits, signal, sniffs, texts, images);
    } catch (error) {
      if (error instanceof ElpxError && error.code === 'cancelled') throw error;
      return withArchive(fail(inputSha, errorDiagnostic(error)), archive);
    }
  }

  // Manifest (data only, never evaluated).
  const manifestText = texts.get(MANIFEST_PATH)?.text;
  if (manifestText !== undefined) {
    const parsed = parseManifest(manifestText);
    if ('error' in parsed) {
      diagnostics.push(diagnostic('manifest-invalid', `libs/elpx-manifest.js: ${parsed.error}`, { resource: MANIFEST_PATH }));
    } else {
      manifest = parsed;
      const diff = manifestDiff(
        parsed,
        files.map((f) => f.name),
      );
      if (diff.missing.length > 0 || diff.unlisted.length > 0) {
        diagnostics.push(
          diagnostic('manifest-stale', `The download manifest lists ${diff.missing.length} absent files and omits ${diff.unlisted.length} existing ones`, {
            resource: MANIFEST_PATH,
            details: { missing: diff.missing.slice(0, 50), unlisted: diff.unlisted.slice(0, 50) },
          }),
        );
      }
    }
  }

  // References
  const sink: ScanSink = { found: [], diagnostics };
  scanContentXml(ode, limits, sink);
  const editableCount = sink.found.length;
  for (const [path, source2] of texts) {
    const kind = scannable(path, sniffs.get(path)!);
    if (kind === 'html') scanHtmlFile(path, source2.text, entryRole(path) === 'page' ? 'published' : 'resource', limits, sink);
    else if (kind === 'css') scanCssFile(path, source2.text, entryRole(path) === 'runtime' ? 'runtime' : 'resource', limits, sink);
  }
  const searchText = texts.get('search_index.js')?.text;
  if (searchText !== undefined) scanSearchIndex('search_index.js', searchText, limits, sink);
  void editableCount;

  const userScope = (p: string): boolean => entryRole(p) === 'user-asset';
  const index = new EntryIndex(
    files.map((f) => f.name),
    userScope,
  );
  const references = resolveAll(sink.found, index);
  diagnostics.push(...referenceDiagnostics(references));

  // Other package checks.
  if (ode.hasDoctype && ode.xml.doctype?.externalId?.includes('content.dtd') && !archive.byName.has('content.dtd')) {
    diagnostics.push(diagnostic('content-dtd-missing', 'content.xml declares content.dtd but the file is absent', { resource: 'content.dtd' }));
  }
  const shot = sniffs.get('screenshot.png');
  if (shot && shot.format !== 'png') {
    diagnostics.push(diagnostic('screenshot-invalid', 'screenshot.png is not a PNG file', { resource: 'screenshot.png' }));
  }
  const ppShot = ode.properties.find((p) => p.key === 'pp_screenshot');
  if (ppShot && ppShot.value.text.length > 0) {
    diagnostics.push(
      diagnostic('pp-screenshot-duplicate', `content.xml embeds a ${ppShot.value.text.length}-character base64 screenshot that eXeLearning never reads`, {
        location: { entry: 'content.xml', field: 'odeProperty:pp_screenshot' },
      }),
    );
  }
  const totalUncompressed = files.reduce((s, f) => s + f.uncompressedSize, 0);
  if (files.some((f) => f.uncompressedSize > HOSTED.entry) || totalUncompressed > HOSTED.total || archive.entries.length > HOSTED.entries) {
    diagnostics.push(
      diagnostic('limits-host-policy', 'The package exceeds the import limits of hosted eXeLearning (200 MiB per file, 500 MiB total, 10000 entries)'),
    );
  }

  // Duplicates among self-contained binary user assets.
  const duplicates = await findDuplicates(archive, files, sniffs, signal);
  for (const g of duplicates) {
    diagnostics.push(
      diagnostic('duplicate-content', `${g.paths.length} identical ${g.format} files (${g.size} bytes each)`, {
        resource: g.paths[0]!,
        details: { paths: g.paths },
      }),
    );
  }

  // Media probing (optional).
  const probes = new Map<string, ProbeResult>();
  let mediaNote: string | undefined;
  let mediaEngine: string | undefined;
  // Videos, and the audio formats the audio policy can re-encode, are inspected with ffprobe.
  const videos = files.filter((f) => {
    const s = sniffs.get(f.name);
    return entryRole(f.name) === 'user-asset' && (s?.kind === 'video' || (s?.kind === 'audio' && PROBED_AUDIO.has(s.format)));
  });
  if (options.media && videos.length > 0) {
    const info = await options.media.engine.info();
    mediaEngine = info.engine;
    if (!info.video.available) {
      mediaNote = info.video.reason ?? 'Video inspection unavailable';
      diagnostics.push(diagnostic('media-engine-unavailable', `Videos and audio were not inspected: ${mediaNote}`));
    } else {
      let n = 0;
      for (const v of videos) {
        throwIfCancelled(signal);
        n++;
        progress({ stage: 'probe', resource: v.name, item: n, items: videos.length });
        if (v.uncompressedSize > limits.maxVideoBytes) continue;
        let resource;
        try {
          resource = await options.media.store.fromEntry(archive, v, extname(v.name) || 'bin', signal);
          probes.set(v.name, await options.media.engine.probe(resource, { resourcePath: v.name, timeoutMs: 120_000, ...(signal ? { signal } : {}) }));
        } catch (error) {
          if (error instanceof ElpxError && error.code === 'cancelled') throw error;
          diagnostics.push(diagnostic('media-probe-failed', `${displayName(v.name)}: ${errorMessage(error)}`, { resource: v.name }));
        } finally {
          // A failed temporary-file cleanup must not abort the analysis or replace a cancellation.
          await resource?.dispose().catch(() => undefined);
        }
      }
    }
  } else if (videos.length > 0) {
    mediaNote = 'Videos and audio were not inspected (no media engine)';
  }

  const inventory = buildInventory(archive, sniffs, references, images, probes, duplicates, ode, diagnostics);
  for (const e of inventory) {
    if (e.role === 'user-asset' && e.extensionMatches === false) {
      diagnostics.push(
        diagnostic('extension-mismatch', `${displayName(e.path)} contains ${e.format.toUpperCase()} data`, { resource: e.path, details: { format: e.format } }),
      );
    }
  }
  const pkg = packageSummary(ode, archive, texts);
  if (pkg.legacyFolders.files > 0) {
    const { files: n, folders } = pkg.legacyFolders;
    diagnostics.push(
      diagnostic(
        'legacy-resource-folders',
        `${n} ${n === 1 ? 'file is' : 'files are'} stored in ${folders} eXeLearning 3 editor ${folders === 1 ? 'folder' : 'folders'} (content/resources/<ODE-ID>/)`,
        { details: { files: n, folders } },
      ),
    );
  }
  const totals = {
    entries: archive.entries.length,
    files: files.length,
    uncompressedBytes: totalUncompressed,
    userAssetBytes: sumBy(inventory, (e) => e.role === 'user-asset'),
    imageBytes: sumBy(inventory, (e) => e.role === 'user-asset' && e.kind === 'image'),
    videoBytes: sumBy(inventory, (e) => e.role === 'user-asset' && e.kind === 'video'),
    audioBytes: sumBy(inventory, (e) => e.role === 'user-asset' && e.kind === 'audio'),
  };
  const result: AnalysisResult = {
    ...baseResult(inputName, source.size, inputSha, true, totals, inventory, references.map(toRecord), duplicates, diagnostics),
    package: pkg,
    media: { probed: probes.size > 0, ...(mediaEngine ? { engine: mediaEngine } : {}), ...(mediaNote ? { note: mediaNote } : {}) },
  };
  progress({ stage: 'done' });
  return { result, archive, ode, ...(manifest ? { manifest } : {}), texts, references, probes, images };
}

function withArchive(a: Analysis, archive: ZipArchive): Analysis {
  return { ...a, archive };
}

function sumBy(list: readonly InventoryEntry[], pred: (e: InventoryEntry) => boolean): number {
  return list.reduce((s, e) => (pred(e) ? s + e.size : s), 0);
}

function baseResult(
  name: string,
  size: number,
  sha256: string,
  ok: boolean,
  totals: AnalysisResult['totals'],
  entries: InventoryEntry[],
  references: AnalysisResult['references'],
  duplicates: DuplicateGroup[],
  diagnostics: Diagnostic[],
): AnalysisResult {
  return {
    schema: 'elpx-optimizer/analysis',
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION, upstream: UPSTREAM_VERSION },
    input: { name: safeDisplayName(name), size, sha256 },
    ok,
    totals,
    entries,
    references,
    duplicates,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    media: { probed: false },
  };
}

/** Keeps only the file name part of a user-supplied name, for display. */
export function safeDisplayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return (name.split(/[\\/]/).pop() ?? 'input').replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 255) || 'input';
}

/** Converts an error into a fatal diagnostic. */
function errorDiagnostic(error: unknown, fallback: DiagnosticCode = 'zip-structure'): Diagnostic {
  if (error instanceof ElpxError) {
    const known: DiagnosticCode[] = [
      'zip-structure',
      'zip-security',
      'zip-unsupported',
      'zip-limit',
      'zip-integrity',
      'content-xml-invalid',
      'xml-security',
      'legacy-elp',
      'not-a-zip',
    ];
    const code = (known as string[]).includes(error.code) ? (error.code as DiagnosticCode) : error.code === 'limit-exceeded' ? 'zip-limit' : fallback;
    const entry = typeof error.details?.['entry'] === 'string' ? (error.details['entry'] as string) : undefined;
    const line = typeof error.details?.['line'] === 'number' ? (error.details['line'] as number) : undefined;
    return diagnostic(code, error.message, {
      severity: 'fatal',
      ...(entry ? { resource: entry } : {}),
      ...(line ? { location: { line } } : {}),
    });
  }
  return diagnostic(fallback, errorMessage(error), { severity: 'fatal' });
}

/** Reads one entry fully (CRC verified), sniffs it and keeps what later stages need. */
async function inspectEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  limits: Limits,
  signal: CancelSignal | undefined,
  sniffs: Map<string, SniffResult>,
  texts: Map<string, TextSource>,
  images: Map<string, ImageInfo>,
): Promise<void> {
  const role = entryRole(entry.name);
  const ext = extname(entry.name);
  const wantText =
    entry.name !== 'content.xml' &&
    (role === 'page' ||
      entry.name === 'search_index.js' ||
      entry.name === MANIFEST_PATH ||
      (ext === 'css' && (role === 'runtime' || role === 'user-asset')) ||
      (role === 'user-asset' && ['html', 'htm', 'xhtml', 'svg'].includes(ext)));
  const wantImage = (role === 'user-asset' || entry.name === 'screenshot.png') && IMAGE_EXTENSIONS.has(ext);
  const keep = (wantText && entry.uncompressedSize <= limits.maxTextEntryBytes) || (wantImage && entry.uncompressedSize <= limits.maxImageBytes);
  const parts: Uint8Array[] = [];
  let head: Uint8Array | undefined;
  let headBytes = 0;
  for await (const chunk of readEntry(archive, entry, signal ? { signal } : {})) {
    if (headBytes < SNIFF_BYTES) {
      head = head ? concat2(head, chunk.subarray(0, SNIFF_BYTES - headBytes)) : chunk.slice(0, SNIFF_BYTES);
      headBytes = head.length;
    }
    if (keep) parts.push(chunk.slice());
  }
  const sniffed = sniff(head ?? new Uint8Array(0), entry.name);
  sniffs.set(entry.name, sniffed);
  if (!keep) return;
  const bytes = parts.length === 1 ? parts[0]! : concatAll(parts);
  if (wantText && sniffed.kind !== 'unknown') {
    try {
      texts.set(entry.name, { entry: entry.name, text: utf8DecodeStrict(bytes, entry.name) });
    } catch {
      // Not UTF-8: left unscanned (treated as opaque).
    }
  }
  if (wantImage && sniffed.kind === 'image') images.set(entry.name, inspectImage(bytes, sniffed.format));
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Resolves found references against the archive entries. */
function resolveAll(found: readonly FoundReference[], index: EntryIndex): ReferenceInternal[] {
  const out: ReferenceInternal[] = [];
  let id = 0;
  for (const f of found) {
    const entry = f.location.entry ?? '';
    const ctx: ResolveContext =
      f.representation === 'editable' || f.representation === 'search-index'
        ? { mode: 'editable', source: entry, basenameFallback: false }
        : { mode: 'file', source: entry, basenameFallback: false };
    const r = resolveReference(f.value, ctx, index);
    const rewritable = f.kind === 'explicit' && f.lift !== undefined;
    out.push({
      id: id++,
      value: f.value,
      form: r.form,
      status: r.status,
      ...(r.target !== undefined ? { target: r.target } : {}),
      ...(r.candidates !== undefined ? { candidates: r.candidates } : {}),
      ...(r.lenient !== undefined ? { lenient: r.lenient } : {}),
      ...(r.percentEncoded ? { percentEncoded: true } : {}),
      kind: f.kind,
      representation: f.representation,
      location: f.location,
      via: f.via,
      rewritable,
      ...(rewritable && f.lift ? { site: { entry, start: f.start, end: f.end, lift: f.lift } } : {}),
      ...(f.element ? { element: f.element } : {}),
      ...(rewritable && f.removal ? { removal: f.removal } : {}),
    });
  }
  return out;
}

function toRecord(r: ReferenceInternal): AnalysisResult['references'][number] {
  const { site, element, removal, ...record } = r;
  void site;
  void element;
  void removal;
  return record;
}

/** Diagnostics derived from reference resolution (deduplicated per location and value). */
function referenceDiagnostics(refs: readonly ReferenceInternal[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of refs) {
    const loc = r.location;
    const shown = displayName(r.value.length > 200 ? `${r.value.slice(0, 200)}…` : r.value);
    if (r.kind === 'dynamic') {
      if (r.status === 'resolved' && r.target)
        out.push(
          diagnostic('dynamic-reference', `Possible reference to ${displayName(r.target)} in ${r.via.join(' › ') || 'code'}`, {
            resource: r.target,
            location: loc,
          }),
        );
      continue;
    }
    switch (r.status) {
      case 'missing':
        out.push(
          diagnostic('missing-resource', `Missing resource "${shown}"`, {
            ...(r.candidates?.[0] ? { resource: r.candidates[0] } : {}),
            location: loc,
            details: { reference: r.value, form: r.form },
            ...(r.form === 'stale-editor-path' || r.representation === 'runtime' ? { severity: 'warning' as const } : {}),
          }),
        );
        break;
      case 'ambiguous':
        out.push(
          diagnostic('ambiguous-reference', `"${shown}" could refer to ${r.candidates?.length ?? 0} files`, {
            location: loc,
            details: { candidates: r.candidates },
          }),
        );
        break;
      case 'unmapped':
        out.push(diagnostic('asset-uri-unmapped', `Internal reference "${shown}" has no mapping in the package`, { location: loc }));
        break;
      case 'external':
        out.push(diagnostic('external-reference', `External URL ${shown} (not checked)`, { location: loc, details: { url: r.value } }));
        break;
      case 'unresolvable':
        out.push(diagnostic('root-relative-reference', `"${shown}" cannot be resolved inside the package`, { location: loc }));
        break;
      case 'resolved':
        if (r.lenient === 'stale-editor-path') {
          out.push(
            diagnostic('stale-editor-path', `Editor upload path "${shown}" is only resolved when eXeLearning renders the page`, {
              resource: r.target!,
              location: loc,
            }),
          );
        } else if (r.lenient && r.lenient !== 'multiple-prefixes') {
          out.push(
            diagnostic('lenient-resolution', `"${shown}" only matches ${displayName(r.target!)} by ${r.lenient}`, {
              resource: r.target!,
              location: loc,
              details: { rule: r.lenient },
            }),
          );
        } else if (r.lenient === 'multiple-prefixes') {
          out.push(
            diagnostic('ambiguous-reference', `"${shown}" matches several files; eXeLearning uses ${displayName(r.target!)}`, {
              resource: r.target!,
              location: loc,
              severity: 'info',
              details: { candidates: r.candidates },
            }),
          );
        }
        if (r.percentEncoded) out.push(diagnostic('percent-encoded-reference', `"${shown}" is percent-encoded`, { resource: r.target!, location: loc }));
        break;
      default:
        break;
    }
  }
  return out;
}

/** Removes exact duplicates (same code, resource, location and message). */
function dedupeDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of list) {
    const key = `${d.code}|${d.resource ?? ''}|${JSON.stringify(d.location ?? {})}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** Groups byte-identical user assets: size+CRC, then SHA-256, then byte comparison. */
async function findDuplicates(
  archive: ZipArchive,
  files: readonly ZipEntry[],
  sniffs: ReadonlyMap<string, SniffResult>,
  signal: CancelSignal | undefined,
): Promise<DuplicateGroup[]> {
  const buckets = new Map<string, ZipEntry[]>();
  for (const f of files) {
    const s = sniffs.get(f.name);
    if (entryRole(f.name) !== 'user-asset' || f.uncompressedSize === 0 || !s || !DEDUP_KINDS.has(s.kind)) continue;
    const key = `${f.uncompressedSize}:${f.crc32}:${s.format}:${extname(f.name)}`;
    const list = buckets.get(key);
    if (list) list.push(f);
    else buckets.set(key, [f]);
  }
  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const byHash = new Map<string, ZipEntry[]>();
    for (const f of bucket) {
      const h = new Sha256();
      for await (const chunk of readEntry(archive, f, signal ? { signal } : {})) h.update(chunk);
      const hex = h.digestHex();
      const list = byHash.get(hex);
      if (list) list.push(f);
      else byHash.set(hex, [f]);
    }
    for (const [hex, members] of byHash) {
      if (members.length < 2) continue;
      const first = members[0]!;
      const confirmed = [first];
      for (const other of members.slice(1)) if (await sameBytes(archive, first, other, signal)) confirmed.push(other);
      if (confirmed.length < 2) continue;
      groups.push({
        id: groups.length + 1,
        sha256: hex,
        size: first.uncompressedSize,
        format: sniffs.get(first.name)!.format,
        paths: confirmed.map((e) => e.name),
      });
    }
  }
  return groups;
}

/** Compares two entries byte by byte (streaming). */
async function sameBytes(archive: ZipArchive, a: ZipEntry, b: ZipEntry, signal: CancelSignal | undefined): Promise<boolean> {
  if (a.uncompressedSize !== b.uncompressedSize) return false;
  const ia = readEntry(archive, a, signal ? { signal } : {})[Symbol.asyncIterator]();
  const ib = readEntry(archive, b, signal ? { signal } : {})[Symbol.asyncIterator]();
  let bufA: Uint8Array = new Uint8Array(0);
  let bufB: Uint8Array = new Uint8Array(0);
  for (;;) {
    if (bufA.length === 0) {
      const n = await ia.next();
      if (!n.done) bufA = n.value;
    }
    if (bufB.length === 0) {
      const n = await ib.next();
      if (!n.done) bufB = n.value;
    }
    if (bufA.length === 0 || bufB.length === 0) return bufA.length === bufB.length;
    const len = Math.min(bufA.length, bufB.length);
    if (!bytesEqual(bufA.subarray(0, len), bufB.subarray(0, len))) return false;
    bufA = bufA.subarray(len);
    bufB = bufB.subarray(len);
  }
}

/** Builds the inventory with usage classification. */
function buildInventory(
  archive: ZipArchive,
  sniffs: ReadonlyMap<string, SniffResult>,
  refs: readonly ReferenceInternal[],
  images: ReadonlyMap<string, ImageInfo>,
  probes: ReadonlyMap<string, ProbeResult>,
  duplicates: readonly DuplicateGroup[],
  ode: OdeDocument,
  diagnostics: Diagnostic[],
): InventoryEntry[] {
  const strong = new Map<string, number>();
  const weak = new Map<string, string[]>();
  const from = new Map<string, Set<string>>();
  const reps = new Map<string, Set<string>>();
  const sensitive = new Set<string>();
  const addWeak = (path: string, reason: string): void => {
    const list = weak.get(path) ?? [];
    if (!list.includes(reason)) list.push(reason);
    weak.set(path, list);
  };
  for (const r of refs) {
    if (r.status === 'resolved' && r.target) {
      const t = r.target;
      if (r.kind === 'explicit' && (!r.lenient || r.lenient === 'multiple-prefixes')) strong.set(t, (strong.get(t) ?? 0) + 1);
      else addWeak(t, r.kind === 'dynamic' ? 'possible reference in script or obfuscated data' : `lenient match (${r.lenient})`);
      (from.get(t) ?? from.set(t, new Set()).get(t)!).add(r.location.entry ?? '');
      (reps.get(t) ?? reps.set(t, new Set()).get(t)!).add(r.representation);
      if (r.location.ideviceType && RESOLUTION_SENSITIVE_TYPES.has(r.location.ideviceType)) sensitive.add(t);
      if (r.lenient === 'multiple-prefixes') for (const c of r.candidates ?? []) if (c !== t) addWeak(c, 'alternative match of an ambiguous reference');
    } else if ((r.status === 'missing' || r.status === 'ambiguous') && r.kind === 'explicit') {
      // A missing reference may still be satisfied by lenient lookups elsewhere; protect same-named files.
      const names = new Set((r.candidates ?? []).map((c) => basename(c)));
      for (const f of archive.entries) {
        if (!f.isDirectory && entryRole(f.name) === 'user-asset' && names.has(basename(f.name)))
          addWeak(f.name, 'same file name as a missing or ambiguous reference');
      }
    } else if (r.status === 'unmapped') {
      const tail =
        r.value
          .replace(/^asset:\/\//, '')
          .split('/')
          .pop() ?? '';
      if (tail) for (const f of archive.entries) if (!f.isDirectory && basename(f.name) === tail) addWeak(f.name, 'possible target of an asset:// reference');
    }
  }
  // Opaque bundles: folders of user assets that contain HTML or scripts.
  const bundles = new Set<string>();
  for (const e of archive.entries) {
    if (e.isDirectory || entryRole(e.name) !== 'user-asset') continue;
    if (/\.(html?|xhtml|js|mjs|swf|json|xml)$/i.test(e.name) && e.name.includes('/')) {
      const dir = e.name.slice(0, e.name.lastIndexOf('/') + 1);
      if (dir !== 'content/resources/' && dir !== 'custom/' && !/^content\/resources\/[0-9]{14}[A-Z0-9]{6}\/$/.test(dir)) bundles.add(dir);
    }
  }
  for (const b of bundles)
    diagnostics.push(diagnostic('opaque-bundle', `Folder ${displayName(b)} contains HTML or scripts; its files are protected`, { resource: b }));
  // Files referenced by only one representation (runtime stylesheets count as neither).
  const hasPages = archive.byName.has('index.html');
  for (const e of archive.entries) {
    if (e.isDirectory || entryRole(e.name) !== 'user-asset') continue;
    const where = [...(reps.get(e.name) ?? [])].filter((r) => r !== 'runtime');
    if (where.length === 0) continue;
    const editable = where.every((r) => r === 'editable' || r === 'search-index');
    if (editable && hasPages) {
      diagnostics.push(
        diagnostic('reference-editable-only', `${displayName(e.name)} is referenced from content.xml but not from the exported pages`, { resource: e.name }),
      );
    } else if (where.includes('published') && !where.includes('editable') && !where.includes('search-index')) {
      diagnostics.push(
        diagnostic(
          'reference-published-only',
          `${displayName(e.name)} is referenced from the exported pages but not from content.xml; eXeLearning drops it on the next export`,
          { resource: e.name },
        ),
      );
    }
  }
  const dupOf = new Map<string, number>();
  for (const g of duplicates) for (const p of g.paths) dupOf.set(p, g.id);
  const pages = new Set(ode.pages.map((p) => p.id));
  void pages;
  return archive.entries.map((e): InventoryEntry => {
    const s = sniffs.get(e.name) ?? { kind: 'unknown' as const, format: e.isDirectory ? 'directory' : 'unknown', mime: 'application/octet-stream' };
    const role = e.isDirectory ? 'other' : entryRole(e.name);
    const reasons: string[] = [];
    let usage: Usage = 'not-applicable';
    if (role === 'user-asset') {
      const bundle = [...bundles].find((b) => e.name.startsWith(b));
      if (strong.has(e.name)) {
        usage = 'used';
      } else if (bundle) {
        usage = 'protected';
        reasons.push(`inside ${bundle}, which contains HTML or scripts`);
      } else if (e.name.startsWith('custom/')) {
        usage = 'protected';
        reasons.push('legacy File Manager folder (references use altered names)');
      } else if (weak.has(e.name)) {
        usage = 'uncertain';
        reasons.push(...weak.get(e.name)!);
      } else {
        usage = 'unreferenced';
        reasons.push('no reference found in content.xml, pages, search index or stylesheets');
      }
      if (usage === 'used' && weak.has(e.name)) reasons.push(...weak.get(e.name)!);
    }
    const imageInfo = images.get(e.name);
    const probe = probes.get(e.name);
    // Containers such as WebM/MP4 also hold audio-only recordings (eXeLearning's recorder writes
    // .webm): once probed, a file without a real video stream is audio, not video.
    const audioOnly =
      s.kind === 'video' &&
      probe !== undefined &&
      !probe.streams.some((x) => x.type === 'video' && !x.attachedPic) &&
      probe.streams.some((x) => x.type === 'audio');
    const ext = extensionMatches(e.name, s);
    return {
      path: e.name,
      isDirectory: e.isDirectory,
      size: e.uncompressedSize,
      compressedSize: e.compressedSize,
      method: e.method === 0 ? 'stored' : 'deflate',
      role,
      kind: audioOnly ? 'audio' : s.kind,
      format: s.format,
      mime: s.mime,
      ...(ext !== undefined ? { extensionMatches: ext } : {}),
      usage,
      usageReasons: reasons,
      references: strong.get(e.name) ?? 0,
      referencedFrom: [...(from.get(e.name) ?? [])].sort(),
      representations: [...(reps.get(e.name) ?? [])].sort() as InventoryEntry['representations'],
      resolutionSensitive: sensitive.has(e.name),
      ...(dupOf.has(e.name) ? { duplicateGroup: dupOf.get(e.name)! } : {}),
      ...(imageInfo ? { image: imageSummary(imageInfo) } : {}),
      ...(probe && s.kind === 'video' ? { video: videoSummary(probe) } : {}),
      ...(probe && (audioOnly || s.kind === 'audio') ? audioSummary(probe) : {}),
    };
  });
}

/** Summarizes the first audio stream of a probe. */
function audioSummary(p: ProbeResult): { audio?: AudioSummary } {
  const a = p.streams.find((x) => x.type === 'audio');
  if (!a) return {};
  const duration = a.duration ?? p.duration;
  const bitRate = a.bitRate ?? p.bitRate;
  return {
    audio: {
      codec: a.codec,
      ...(duration !== undefined ? { duration } : {}),
      ...(a.channels !== undefined ? { channels: a.channels } : {}),
      ...(a.sampleRate !== undefined ? { sampleRate: a.sampleRate } : {}),
      ...(bitRate !== undefined ? { bitRate } : {}),
    },
  };
}

function imageSummary(i: ImageInfo): ImageSummary {
  return {
    animated: i.animated,
    hasIcc: i.hasIcc,
    hasExif: i.hasExif,
    hasXmp: i.hasXmp,
    ...(i.width !== undefined ? { width: i.width } : {}),
    ...(i.height !== undefined ? { height: i.height } : {}),
    ...(i.hasAlpha !== undefined ? { hasAlpha: i.hasAlpha } : {}),
    ...(i.orientation !== undefined ? { orientation: i.orientation } : {}),
    ...(i.colorModel !== undefined ? { colorModel: i.colorModel } : {}),
    ...(i.bitDepth !== undefined ? { bitDepth: i.bitDepth } : {}),
    ...(i.jpegQuality !== undefined ? { jpegQuality: i.jpegQuality } : {}),
    ...(i.lossless !== undefined ? { lossless: i.lossless } : {}),
  };
}

/** Summarizes a probe for the inventory. */
export function videoSummary(p: ProbeResult): VideoSummary {
  const v = p.streams.find((s) => s.type === 'video' && !s.attachedPic);
  const duration = effectiveDuration(p);
  return {
    container: p.formatName,
    ...(duration !== undefined ? { duration } : {}),
    ...(v?.width !== undefined ? { width: v.width } : {}),
    ...(v?.height !== undefined ? { height: v.height } : {}),
    ...(v ? { videoCodec: v.codec } : {}),
    ...(v?.frameRate !== undefined ? { frameRate: Math.round(v.frameRate * 1000) / 1000 } : {}),
    ...(p.bitRate !== undefined ? { bitRate: p.bitRate } : {}),
    ...(v ? { rotation: v.rotation } : {}),
    audio: p.streams
      .filter((s) => s.type === 'audio')
      .map((s) => ({ codec: s.codec, ...(s.channels !== undefined ? { channels: s.channels } : {}), ...(s.language ? { language: s.language } : {}) })),
    subtitles: p.streams.filter((s) => s.type === 'subtitle').length,
    chapters: p.chapters,
    otherStreams: p.streams.filter((s) => s.type === 'data' || s.type === 'attachment' || s.type === 'unknown' || (s.type === 'video' && s.attachedPic)).length,
  };
}

function packageSummary(ode: OdeDocument, archive: ZipArchive, texts: ReadonlyMap<string, TextSource>): PackageSummary {
  const types: Record<string, number> = {};
  for (const c of ode.components) types[c.type || 'unknown'] = (types[c.type || 'unknown'] ?? 0) + 1;
  const title = ode.properties.find((p) => p.key === 'pp_title')?.value.text;
  const exe = ode.resources['exe_version'] ?? ode.resources['eXeVersion'];
  return {
    variant: ode.variant,
    ...(title ? { title } : {}),
    ...(ode.resources['odeId'] ? { odeId: ode.resources['odeId'] } : {}),
    ...(exe ? { exeVersion: exe } : {}),
    hasDoctype: ode.hasDoctype,
    pages: ode.pages.length,
    components: ode.components.length,
    ideviceTypes: types,
    hasScreenshot: archive.byName.has('screenshot.png'),
    hasManifest: archive.byName.has(MANIFEST_PATH),
    hasSearchIndex: texts.has('search_index.js'),
    hasPublishedHtml: archive.byName.has('index.html'),
    legacyFolders: countLegacyFolders(archive),
  };
}

/** Counts user files in eXeLearning 3 editor folders. */
function countLegacyFolders(archive: ZipArchive): { folders: number; files: number } {
  const folders = new Set<string>();
  let files = 0;
  for (const e of archive.entries) {
    const legacy = e.isDirectory ? undefined : legacyFolderOf(e.name);
    if (!legacy) continue;
    folders.add(legacy.folder);
    files++;
  }
  return { folders: folders.size, files };
}
