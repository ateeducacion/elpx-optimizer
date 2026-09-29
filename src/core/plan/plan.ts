import type { Analysis, InventoryEntry } from '../analyze/model.js';
import type { Diagnostic } from '../diagnostics.js';
import type { Limits } from '../limits.js';
import type { EngineInfo } from '../media/engine.js';
import { decideImage, type ImageJob, type ImageSkipReason } from '../media/image-policy.js';
import { decideVideo, type VideoJob, type VideoSkipReason } from '../media/video-policy.js';
import { sha256Hex } from '../io/hash.js';
import { MANIFEST_PATH } from '../format/manifest.js';
import { IMAGE_EXTENSIONS } from '../analyze/analyze.js';
import { extname } from '../zip/names.js';
import { planDeduplication } from '../refs/rewrite.js';
import { PLAN_SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from '../version.js';
import { canonicalJson, type NormalizedOptions } from './options.js';

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
  | { readonly id: string; readonly op: 'remove-unused'; readonly path: string; readonly size: number; readonly reason: string }
  | {
      readonly id: string;
      readonly op: 'deduplicate';
      readonly keep: string;
      readonly remove: readonly string[];
      readonly size: number;
      readonly references: number;
    }
  | { readonly id: string; readonly op: 'rewrite-references'; readonly path: string; readonly edits: number; readonly reason: string }
  | { readonly id: string; readonly op: 'update-manifest'; readonly path: string; readonly reason: string };

export interface SkippedResource {
  readonly path: string;
  readonly kind: 'video' | 'image' | 'unused' | 'duplicate';
  readonly reason: VideoSkipReason | ImageSkipReason | 'excluded' | 'not-a-user-asset' | 'not-probed' | 'kept' | string;
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
    if (options.deduplicate === 'exact') {
      const dedup = planDeduplication(analysis, excluded, removedByCleanup);
      for (const d of dedup.decisions) {
        if (d.remove.length > 0) {
          const size = result.entries.find((x) => x.path === d.keep)?.size ?? 0;
          operations.push({
            id: `dedup:${d.keep}`,
            op: 'deduplicate',
            keep: d.keep,
            remove: d.remove,
            size: size * d.remove.length,
            references: Object.values(d.rewritten).reduce((a, b) => a + b, 0),
          });
        }
        for (const s of d.skipped) skipped.push({ path: s.path, kind: 'duplicate', reason: 'kept', detail: s.reason });
      }
      for (const [entry, list] of dedup.edits) {
        operations.push({ id: `rewrite:${entry}`, op: 'rewrite-references', path: entry, edits: list.length, reason: 'references to removed duplicates' });
      }
    }
    const removedPaths = new Set<string>(removedByCleanup);
    for (const op of operations) if (op.op === 'deduplicate') for (const p of op.remove) removedPaths.add(p);
    for (const e of result.entries) {
      if (e.isDirectory) continue;
      const isScreenshot = e.path === 'screenshot.png';
      if (e.role !== 'user-asset' && !(isScreenshot && options.images.includeScreenshot)) continue;
      if (e.kind !== 'video' && e.kind !== 'image') continue;
      if (removedPaths.has(e.path)) continue;
      if (excluded.has(e.path)) {
        skipped.push({ path: e.path, kind: e.kind, reason: 'excluded', detail: 'Kept as original by request' });
        continue;
      }
      if (e.kind === 'video') planVideo(analysis, e, options, engine, limits, operations, skipped);
      else planImage(analysis, e, options, engine, limits, operations, skipped, isScreenshot);
    }
    const removals = operations.some((o) => o.op === 'remove-unused' || o.op === 'deduplicate');
    if (removals && analysis.manifest) {
      operations.push({ id: `manifest:${MANIFEST_PATH}`, op: 'update-manifest', path: MANIFEST_PATH, reason: 'list the final set of entries' });
    }
    for (const op of operations) {
      if (op.op === 'transcode-video' || op.op === 'recompress-image') estimate += Math.max(0, op.size - (op.estimatedBytes ?? op.size));
      else if (op.op === 'remove-unused' || op.op === 'deduplicate') estimate += op.size;
    }
    if (operations.some((o) => o.op === 'transcode-video' || (o.op === 'recompress-image' && o.lossy))) {
      risks.push('Lossy re-encoding changes image/video quality; originals are kept when a result is not valid or not smaller.');
    }
    if (operations.some((o) => (o.op === 'transcode-video' && o.job.scale) || (o.op === 'recompress-image' && o.job.resize))) {
      risks.push('Some media will be downscaled.');
    }
    if (operations.some((o) => o.op === 'remove-unused'))
      risks.push('Unreferenced files will be removed; only files with no reference of any kind are selected.');
    if (operations.some((o) => o.op === 'deduplicate')) risks.push('Duplicate files will be merged and their references rewritten.');
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
