import type { Analysis, InventoryEntry } from '../analyze/model.js';
import type { Diagnostic } from '../diagnostics.js';
import type { Limits } from '../limits.js';
import type { EngineInfo } from '../media/engine.js';
import { decideImage, type ImageJob, type ImageSkipReason } from '../media/image-policy.js';
import { decideVideo, type VideoJob, type VideoSkipReason } from '../media/video-policy.js';
import { decideAudio, type AudioJob, type AudioSkipReason } from '../media/audio-policy.js';
import { decidePdf, type PdfJob, type PdfSkipReason } from '../media/pdf-policy.js';
import { sha256Hex } from '../io/hash.js';
import { MANIFEST_PATH } from '../format/manifest.js';
import { IMAGE_EXTENSIONS } from '../analyze/analyze.js';
import { extname } from '../zip/names.js';
import { planRestructure, type RestructurePlan } from '../refs/restructure.js';
import { PLAN_SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from '../version.js';
import { canonicalJson, type NormalizedOptions } from './options.js';
import { SCREENSHOT_PATH } from '../format/screenshot.js';

/**
 * The optimization plan: an explicit, versioned list of operations derived
 * from an analysis, normalized options and engine capabilities. The CLI's
 * --dry-run and the web preview show exactly this object; execution
 * re-checks the input hash and the options before doing anything.
 */

export type PlanOperation =
  | {
      readonly id: string;
      readonly op: 'transcode-video';
      readonly path: string;
      readonly size: number;
      readonly lossy: true;
      readonly conversions: readonly string[];
      readonly job: VideoJob;
      readonly estimatedBytes?: number;
    }
  | {
      readonly id: string;
      readonly op: 'recompress-image';
      readonly path: string;
      readonly size: number;
      readonly lossy: boolean;
      readonly conversions: readonly string[];
      readonly job: ImageJob;
      readonly estimatedBytes?: number;
    }
  | {
      readonly id: string;
      readonly op: 'transcode-audio';
      readonly path: string;
      readonly size: number;
      readonly lossy: true;
      readonly conversions: readonly string[];
      readonly job: AudioJob;
      /** New path when the format (and so the extension) changes. */
      readonly to?: string;
      readonly estimatedBytes?: number;
    }
  | {
      readonly id: string;
      readonly op: 'optimize-pdf';
      readonly path: string;
      readonly size: number;
      /** True when images may be converted to JPEG. */
      readonly lossy: boolean;
      readonly conversions: readonly string[];
      readonly job: PdfJob;
      readonly estimatedBytes?: number;
    }
  | { readonly id: string; readonly op: 'remove-unused'; readonly path: string; readonly size: number; readonly reason: string }
  | {
      readonly id: string;
      readonly op: 'deduplicate';
      readonly keep: string;
      readonly remove: readonly string[];
      readonly size: number;
      readonly references: number;
    }
  | {
      readonly id: string;
      readonly op: 'move-resource';
      readonly path: string;
      readonly to: string;
      readonly size: number;
      readonly references: number;
    }
  | {
      readonly id: string;
      readonly op: 'rename-resource';
      readonly path: string;
      readonly to: string;
      readonly size: number;
      readonly references: number;
    }
  | {
      readonly id: string;
      readonly op: 'remove-missing-reference';
      /** The missing path (or the reference itself when it is not a package path). */
      readonly path: string;
      readonly references: number;
      readonly actions: { readonly element: number; readonly attribute: number; readonly value: number };
      readonly entries: readonly string[];
    }
  | { readonly id: string; readonly op: 'rewrite-references'; readonly path: string; readonly edits: number; readonly reason: string }
  | { readonly id: string; readonly op: 'update-manifest'; readonly path: string; readonly reason: string }
  | {
      readonly id: string;
      readonly op: 'replace-screenshot';
      readonly path: string;
      /** Size of the current screenshot.png (0 when the package has none and it is added). */
      readonly size: number;
      readonly after: number;
      readonly added: boolean;
    };

export interface SkippedResource {
  readonly path: string;
  readonly kind: 'video' | 'image' | 'audio' | 'pdf' | 'unused' | 'duplicate' | 'flatten' | 'missing-reference' | 'rename';
  readonly reason: VideoSkipReason | ImageSkipReason | AudioSkipReason | PdfSkipReason | 'excluded' | 'not-a-user-asset' | 'not-probed' | 'kept' | string;
  readonly detail: string;
}

export interface OptimizationPlan {
  readonly schema: 'elpx-optimizer/plan';
  readonly schemaVersion: number;
  readonly tool: { readonly name: string; readonly version: string };
  readonly input: { readonly name: string; readonly size: number; readonly sha256: string };
  readonly options: NormalizedOptions;
  readonly optionsHash: string;
  readonly engine: {
    readonly engine: EngineInfo['engine'];
    readonly versions: EngineInfo['versions'];
    readonly video: { readonly available: boolean; readonly encoders: readonly string[]; readonly reason?: string };
    readonly image: { readonly available: boolean; readonly encoders: EngineInfo['image']['encoders']; readonly reason?: string };
  };
  readonly operations: readonly PlanOperation[];
  readonly skipped: readonly SkippedResource[];
  readonly risks: readonly string[];
  /** Rough, unmeasured estimate of the saved bytes (labelled as such everywhere). */
  readonly estimate: { readonly kind: 'estimate'; readonly savedBytes: number; readonly note: string };
  readonly blocking: readonly Diagnostic[];
  readonly planHash: string;
}

/** Builds the plan. Pure: does not touch the archive. */
export function buildOptimizationPlan(analysis: Analysis, options: NormalizedOptions, engine: EngineInfo, limits: Limits): OptimizationPlan {
  const result = analysis.result;
  const optionsHash = sha256Hex(canonicalJson(options));
  const operations: PlanOperation[] = [];
  const skipped: SkippedResource[] = [];
  const risks: string[] = [];
  const blocking = result.ok ? [] : result.diagnostics.filter((d) => d.severity === 'fatal');
  const excluded = new Set(options.exclude);
  let estimate = 0;

  if (result.ok) {
    const removedByCleanup = new Set<string>();
    if (options.removeUnused === 'safe') {
      for (const e of result.entries) {
        if (e.isDirectory || e.role !== 'user-asset') continue;
        if (e.usage === 'unreferenced' && !excluded.has(e.path)) {
          removedByCleanup.add(e.path);
          operations.push({ id: `remove:${e.path}`, op: 'remove-unused', path: e.path, size: e.size, reason: e.usageReasons.join('; ') });
        } else if (e.usage === 'uncertain' || e.usage === 'protected') {
          skipped.push({ path: e.path, kind: 'unused', reason: 'kept', detail: `${e.usage}: ${e.usageReasons.join('; ')}` });
        }
      }
    }
    // Audio decisions come first: a change of format is a rename that the restructuring verifies.
    const audioJobs = new Map<string, AudioJob>();
    for (const e of result.entries) {
      if (e.isDirectory || e.role !== 'user-asset' || e.kind !== 'audio' || removedByCleanup.has(e.path)) continue;
      if (excluded.has(e.path)) {
        skipped.push({ path: e.path, kind: 'audio', reason: 'excluded', detail: 'Kept as original by request' });
        continue;
      }
      const job = planAudio(analysis, e, options, engine, limits, skipped);
      if (job) audioJobs.set(e.path, job);
    }
    const convert = new Map([...audioJobs].filter(([, job]) => job.rename).map(([path, job]) => [path, job.target]));
    const restructure = restructurePlan(analysis, options, removedByCleanup, convert);
    for (const [path, job] of audioJobs) {
      if (restructure.merged.has(path)) continue;
      const to = job.rename ? restructure.renames.get(path) : undefined;
      // A conversion whose references cannot follow the new name is reported by the restructuring.
      if (job.rename && to === undefined) continue;
      const size = result.entries.find((x) => x.path === path)!.size;
      operations.push({
        id: `audio:${path}`,
        op: 'transcode-audio',
        path,
        size,
        lossy: true,
        conversions: job.conversions,
        job,
        ...(to !== undefined ? { to } : {}),
        ...(job.expected.duration !== undefined ? { estimatedBytes: Math.min(size, Math.round((job.bitrateKbps * 1000 * job.expected.duration) / 8)) } : {}),
      });
    }
    const sizeOf = new Map(result.entries.map((x) => [x.path, x.size]));
    for (const m of restructure.merges) {
      operations.push({
        id: `dedup:${m.keep}`,
        op: 'deduplicate',
        keep: m.keep,
        remove: m.remove,
        size: (sizeOf.get(m.keep) ?? 0) * m.remove.length,
        references: Object.values(m.rewritten).reduce((a, b) => a + b, 0),
      });
    }
    for (const m of restructure.moves) {
      operations.push({ id: `move:${m.from}`, op: 'move-resource', path: m.from, to: m.to, size: sizeOf.get(m.from) ?? 0, references: m.references });
    }
    for (const m of restructure.renamed) {
      operations.push({ id: `rename:${m.from}`, op: 'rename-resource', path: m.from, to: m.to, size: sizeOf.get(m.from) ?? 0, references: m.references });
    }
    for (const u of restructure.unlinks) {
      operations.push({ id: `unlink:${u.key}`, op: 'remove-missing-reference', path: u.key, references: u.references, actions: u.actions, entries: u.entries });
    }
    for (const s of restructure.skipped) {
      if (s.kind === 'convert')
        skipped.push({ path: s.path, kind: 'audio', reason: 'kept', detail: `Not converted: its references cannot follow a new name (${s.reason})` });
      else skipped.push({ path: s.path, kind: s.kind, reason: 'kept', detail: s.reason });
    }
    for (const [entry, list] of restructure.edits) {
      operations.push({
        id: `rewrite:${entry}`,
        op: 'rewrite-references',
        path: entry,
        edits: list.length,
        reason: rewriteReason(entry, restructure, analysis),
      });
    }
    const removedPaths = new Set<string>([...removedByCleanup, ...restructure.merged]);
    for (const e of result.entries) {
      if (e.isDirectory) continue;
      const isScreenshot = e.path === 'screenshot.png';
      if (e.role !== 'user-asset' && !(isScreenshot && options.images.includeScreenshot && !options.screenshot)) continue;
      if (e.kind !== 'video' && e.kind !== 'image') continue;
      if (removedPaths.has(e.path)) continue;
      if (excluded.has(e.path)) {
        skipped.push({ path: e.path, kind: e.kind, reason: 'excluded', detail: 'Kept as original by request' });
        continue;
      }
      if (e.kind === 'video') planVideo(analysis, e, options, engine, limits, operations, skipped);
      else planImage(analysis, e, options, engine, limits, operations, skipped, isScreenshot);
    }
    for (const e of result.entries) {
      if (e.isDirectory || e.role !== 'user-asset' || e.format !== 'pdf' || removedPaths.has(e.path)) continue;
      if (excluded.has(e.path)) {
        skipped.push({ path: e.path, kind: 'pdf', reason: 'excluded', detail: 'Kept as original by request' });
        continue;
      }
      const caps = engine.pdf ?? { available: false, reason: 'This engine does not process PDFs' };
      const decision = decidePdf({ size: e.size, ...(analysis.pdfs?.has(e.path) ? { info: analysis.pdfs.get(e.path)! } : {}) }, options.pdf, caps, limits);
      if (decision.action === 'skip') {
        skipped.push({ path: e.path, kind: 'pdf', reason: decision.reason, detail: decision.detail });
        continue;
      }
      operations.push({
        id: `pdf:${e.path}`,
        op: 'optimize-pdf',
        path: e.path,
        size: e.size,
        lossy: decision.job.images,
        conversions: decision.job.conversions,
        job: decision.job,
        estimatedBytes: Math.round(e.size * (decision.job.images ? 0.8 : 0.95)),
      });
    }
    if (options.screenshot) {
      const current = result.entries.find((e) => e.path === SCREENSHOT_PATH);
      if (excluded.has(SCREENSHOT_PATH)) skipped.push({ path: SCREENSHOT_PATH, kind: 'image', reason: 'excluded', detail: 'Kept as original by request' });
      else
        operations.push({
          id: `screenshot:${SCREENSHOT_PATH}`,
          op: 'replace-screenshot',
          path: SCREENSHOT_PATH,
          size: current?.size ?? 0,
          after: options.screenshot.size,
          added: current === undefined,
        });
    }
    const removals = operations.some(
      (o) =>
        o.op === 'remove-unused' ||
        o.op === 'deduplicate' ||
        o.op === 'move-resource' ||
        o.op === 'rename-resource' ||
        (o.op === 'transcode-audio' && o.to !== undefined) ||
        (o.op === 'replace-screenshot' && o.added),
    );
    if (removals && analysis.manifest) {
      operations.push({ id: `manifest:${MANIFEST_PATH}`, op: 'update-manifest', path: MANIFEST_PATH, reason: 'list the final set of entries' });
    }
    for (const op of operations) {
      if (op.op === 'transcode-video' || op.op === 'recompress-image' || op.op === 'transcode-audio' || op.op === 'optimize-pdf')
        estimate += Math.max(0, op.size - (op.estimatedBytes ?? op.size));
      else if (op.op === 'remove-unused' || op.op === 'deduplicate') estimate += op.size;
    }
    if (operations.some((o) => o.op === 'transcode-video' || o.op === 'transcode-audio' || (o.op === 'recompress-image' && o.lossy))) {
      risks.push('Lossy re-encoding changes image, audio or video quality; originals are kept when a result is not valid or not smaller.');
    }
    if (operations.some((o) => o.op === 'optimize-pdf' && o.lossy)) {
      risks.push('Images inside PDFs may be converted to JPEG (lossy); text, fonts, links and forms are not re-rendered.');
    }
    if (operations.some((o) => o.op === 'transcode-audio' && o.to !== undefined)) {
      risks.push('WAV, AIFF and FLAC recordings become MP3 files with the .mp3 extension; their references are rewritten.');
    }
    if (operations.some((o) => (o.op === 'transcode-video' && o.job.scale) || (o.op === 'recompress-image' && o.job.resize))) {
      risks.push('Some media will be downscaled.');
    }
    if (operations.some((o) => o.op === 'remove-unused'))
      risks.push('Unreferenced files will be removed; only files with no reference of any kind are selected.');
    if (operations.some((o) => o.op === 'deduplicate')) risks.push('Duplicate files will be merged and their references rewritten.');
    if (operations.some((o) => o.op === 'move-resource')) {
      risks.push('Files in eXeLearning 3 folders will be moved to content/resources/ and their references rewritten.');
    }
    if (operations.some((o) => o.op === 'rename-resource')) {
      risks.push('Files get clean names (lower case, no spaces, accents or copy markers) and their references are rewritten.');
    }
    if (operations.some((o) => o.op === 'remove-missing-reference')) {
      risks.push('References to missing files will be taken out: images and media players are deleted, links keep their text.');
    }
  }
  operations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const plan = {
    schema: 'elpx-optimizer/plan' as const,
    schemaVersion: PLAN_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    input: { name: result.input.name, size: result.input.size, sha256: result.input.sha256 },
    options,
    optionsHash,
    engine: {
      engine: engine.engine,
      versions: engine.versions,
      video: { available: engine.video.available, encoders: engine.video.encoders, ...(engine.video.reason ? { reason: engine.video.reason } : {}) },
      image: { available: engine.image.available, encoders: engine.image.encoders, ...(engine.image.reason ? { reason: engine.image.reason } : {}) },
    },
    operations,
    skipped,
    risks,
    estimate: { kind: 'estimate' as const, savedBytes: estimate, note: 'Rough estimate before processing; real savings are measured after encoding.' },
    blocking,
  };
  return { ...plan, planHash: sha256Hex(canonicalJson({ ...plan, estimate: undefined })) };
}

/**
 * Replays the restructuring decisions for these options (also used by
 * execution, where `convert` only holds the conversions that succeeded).
 */
export function restructurePlan(
  analysis: Analysis,
  options: NormalizedOptions,
  removed: ReadonlySet<string>,
  convert: ReadonlyMap<string, string> = new Map(),
  convertNames?: ReadonlyMap<string, string>,
  frozen?: ReadonlySet<string>,
): RestructurePlan {
  return planRestructure(analysis, {
    deduplicate: options.deduplicate === 'exact',
    flatten: options.flatten === 'legacy',
    removeMissing: options.missingReferences === 'remove',
    normalizeNames: options.normalizeNames === 'slug',
    excluded: new Set(options.exclude),
    removed,
    convert,
    ...(convertNames ? { convertNames } : {}),
    ...(frozen ? { frozen } : {}),
  });
}

/** Decides an audio job, or records why the file is left unchanged. */
function planAudio(
  analysis: Analysis,
  e: InventoryEntry,
  options: NormalizedOptions,
  engine: EngineInfo,
  limits: Limits,
  skipped: SkippedResource[],
): AudioJob | undefined {
  const caps = engine.audio ?? { available: false, encoders: [], reason: 'This engine does not process audio' };
  const probe = analysis.probes.get(e.path);
  if (!options.audio.enabled) {
    skipped.push({ path: e.path, kind: 'audio', reason: 'audio-disabled', detail: 'Audio optimization is disabled' });
    return undefined;
  }
  if (!probe) {
    if (!caps.available) skipped.push({ path: e.path, kind: 'audio', reason: 'engine-unavailable', detail: caps.reason ?? 'No audio engine' });
    else if (e.size > limits.maxVideoBytes)
      skipped.push({ path: e.path, kind: 'audio', reason: 'exceeds-size-limit', detail: `File is larger than ${limits.maxVideoBytes} bytes` });
    else skipped.push({ path: e.path, kind: 'audio', reason: 'not-probed', detail: 'The audio file could not be inspected' });
    return undefined;
  }
  const decision = decideAudio({ format: e.format, size: e.size, probe }, options.audio, caps, limits);
  if (decision.action === 'skip') {
    skipped.push({ path: e.path, kind: 'audio', reason: decision.reason, detail: decision.detail });
    return undefined;
  }
  return decision.job;
}

/** Explains why an entry's references are rewritten. */
function rewriteReason(entry: string, restructure: RestructurePlan, analysis: Analysis): string {
  const reasons = new Set<string>();
  for (const r of analysis.references) {
    if (r.site?.entry !== entry) continue;
    const target = r.status === 'resolved' ? r.target : undefined;
    if (target && restructure.merged.has(target)) reasons.add('references to removed duplicates');
    else if (target && restructure.conversions.some((c) => c.from === target)) reasons.add('references to converted audio');
    else if (target && restructure.renamed.some((c) => c.from === target)) reasons.add('references to renamed files');
    else if (target && restructure.renames.has(target)) reasons.add('references to moved files');
  }
  if (restructure.unlinks.some((u) => u.entries.includes(entry))) reasons.add('references to missing files taken out');
  return [...reasons].join('; ');
}

function planVideo(
  analysis: Analysis,
  e: InventoryEntry,
  options: NormalizedOptions,
  engine: EngineInfo,
  limits: Limits,
  operations: PlanOperation[],
  skipped: SkippedResource[],
): void {
  const probe = analysis.probes.get(e.path);
  if (!options.video.enabled) {
    skipped.push({ path: e.path, kind: 'video', reason: 'video-disabled', detail: 'Video optimization is disabled' });
    return;
  }
  if (!probe) {
    if (!engine.video.available) {
      skipped.push({ path: e.path, kind: 'video', reason: 'engine-unavailable', detail: engine.video.reason ?? 'No video engine' });
    } else if (e.size > limits.maxVideoBytes) {
      // The analysis does not probe videos above the limit; report that instead of a probe failure.
      skipped.push({ path: e.path, kind: 'video', reason: 'exceeds-size-limit', detail: `File is larger than ${limits.maxVideoBytes} bytes` });
    } else {
      skipped.push({ path: e.path, kind: 'video', reason: 'not-probed', detail: 'The video could not be inspected' });
    }
    return;
  }
  const decision = decideVideo({ format: e.format, size: e.size, probe }, options.video, engine.video, limits);
  if (decision.action === 'skip') {
    skipped.push({ path: e.path, kind: 'video', reason: decision.reason, detail: decision.detail });
    return;
  }
  operations.push({
    id: `video:${e.path}`,
    op: 'transcode-video',
    path: e.path,
    size: e.size,
    lossy: true,
    conversions: decision.job.conversions,
    job: decision.job,
    estimatedBytes: estimateVideoBytes(decision.job, e.size),
  });
}

/** Very rough size estimate from typical x264 bits per pixel at a given CRF. */
function estimateVideoBytes(job: VideoJob, size: number): number {
  const fps = job.expected.frameRate ?? 25;
  const bpp = 0.1 * Math.pow(0.89, job.crf - 18);
  const videoBits = bpp * job.expected.width * job.expected.height * fps * job.expected.duration;
  const audioBits = job.expected.audio.reduce((s, a) => s + (a.bitrateKbps ?? 128) * 1000 * job.expected.duration, 0);
  return Math.min(size, Math.round((videoBits + audioBits) / 8));
}

function planImage(
  analysis: Analysis,
  e: InventoryEntry,
  options: NormalizedOptions,
  engine: EngineInfo,
  limits: Limits,
  operations: PlanOperation[],
  skipped: SkippedResource[],
  isScreenshot: boolean,
): void {
  const info = analysis.images.get(e.path);
  const decision = decideImage(
    { format: e.format, size: e.size, info, extensionMatches: e.extensionMatches, resolutionSensitive: e.resolutionSensitive || isScreenshot },
    isScreenshot ? { ...options.images, jpegQuality: 100, maxDimension: undefined } : options.images,
    engine.image,
    limits,
  );
  if (decision.action === 'skip') {
    if (decision.reason === 'corrupt' && !info) {
      // Never inspected by the analysis (so not known to be corrupt): say why.
      if (!IMAGE_EXTENSIONS.has(extname(e.path))) {
        skipped.push({ path: e.path, kind: 'image', reason: 'unsupported-format', detail: 'Images without a recognised file extension are left unchanged' });
        return;
      }
      if (e.size > limits.maxImageBytes) {
        skipped.push({ path: e.path, kind: 'image', reason: 'exceeds-size-limit', detail: `Larger than ${limits.maxImageBytes} bytes` });
        return;
      }
    }
    skipped.push({ path: e.path, kind: 'image', reason: decision.reason, detail: decision.detail });
    return;
  }
  if (isScreenshot && decision.job.mode !== 'lossless') {
    skipped.push({ path: e.path, kind: 'image', reason: 'kept', detail: 'screenshot.png is only optimized losslessly' });
    return;
  }
  const ratio = decision.job.mode === 'lossless' ? 0.9 : Math.min(0.95, (decision.job.quality ?? 80) / 100);
  operations.push({
    id: `image:${e.path}`,
    op: 'recompress-image',
    path: e.path,
    size: e.size,
    lossy: decision.job.mode === 'lossy',
    conversions: decision.job.conversions,
    job: decision.job,
    estimatedBytes: Math.round(e.size * ratio),
  });
}
