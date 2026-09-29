import { CancelledError, ElpxError, errorMessage } from '../errors.js';
import { throwIfCancelled, type CancelSignal } from '../cancel.js';
import { diagnosticKey, type Diagnostic } from '../diagnostics.js';
import type { Limits } from '../limits.js';
import type { ByteSource } from '../io/byte-source.js';
import { streamRange } from '../io/byte-source.js';
import type { ByteSink } from '../io/byte-sink.js';
import { Sha256 } from '../io/hash.js';
import { utf8Encode } from '../io/text.js';
import { readEntryBytes, type ZipEntry } from '../zip/reader.js';
import { ZipWriter, metaFromEntry, type EntryMeta } from '../zip/writer.js';
import { extname } from '../zip/names.js';
import { analyzeArchive } from '../analyze/analyze.js';
import type { Analysis } from '../analyze/model.js';
import { parseContentXml } from '../format/content-xml.js';
import { MANIFEST_PATH, manifestDiff, parseManifest, renderManifest } from '../format/manifest.js';
import type { EngineInfo, MediaEngine, ProgressListener, ResourceStore, StoredResource } from '../media/engine.js';
import { inspectImage } from '../media/image-inspect.js';
import { extractMetadata, injectMetadata } from '../media/image-metadata.js';
import { isWorthReplacing, validateVideoCandidate } from '../media/video-policy.js';
import { AUDIO_MIME, audioDemuxer, validateAudioCandidate } from '../media/audio-policy.js';
import { checkPdf, inspectPdf, rewritePdf, validatePdfCandidate } from '../media/pdf-policy.js';
import { applyTextEdits } from '../refs/rewrite.js';
import { buildOptimizationPlan, restructurePlan, type OptimizationPlan, type PlanOperation } from '../plan/plan.js';
import { canonicalJson } from '../plan/options.js';
import { sha256Hex } from '../io/hash.js';
import { buildReport, type OperationResult, type OptimizationReport, type Validation } from '../report/report.js';

/** Where the optimized archive is written. */
export interface OutputTarget {
  readonly sink: ByteSink;
  /** Closes the sink and returns a reader over the written bytes. */
  finish(): Promise<ByteSource>;
  /** Replaces the output with a byte-for-byte copy of the input. */
  useOriginal(source: ByteSource): Promise<ByteSource>;
  /** Deletes the output. */
  discard(): Promise<void>;
}

/** Adapter bundle for one runtime. */
export interface Platform {
  readonly engine: MediaEngine;
  readonly store: ResourceStore;
  readonly limits: Limits;
  readonly imageConcurrency: number;
  createOutput(): Promise<OutputTarget>;
}

export interface OptimizeRunOptions {
  readonly signal?: CancelSignal;
  readonly onProgress?: ProgressListener;
  /** Output name used in the report (display only). */
  readonly outputName: string;
}

export interface OptimizeOutcome {
  readonly report: OptimizationReport;
  /** The delivered archive (present unless the run failed). */
  readonly output?: ByteSource;
  readonly target?: OutputTarget;
}

/**
 * Executes a plan. The input is never modified. Every candidate is
 * validated; failures keep the original resource. The packaged result is
 * reopened, fully re-analyzed and compared with the input before it is
 * delivered; if there is no net benefit, a byte copy of the input is
 * delivered with status "no-improvement".
 */
export async function optimizeArchive(
  source: ByteSource,
  analysis: Analysis,
  plan: OptimizationPlan,
  platform: Platform,
  run: OptimizeRunOptions,
): Promise<OptimizeOutcome> {
  const { signal } = run;
  const progress = run.onProgress ?? (() => undefined);
  const engineInfo = await platform.engine.info();
  const validations: Validation[] = [];
  const results: OperationResult[] = [];
  const base = { plan, engineInfo, analysis, validations, results };

  // 1. Re-validate that the plan belongs to this input, options and engine.
  if (!analysis.result.ok || !analysis.archive) {
    return { report: buildReport({ ...base, status: 'invalid-input' }) };
  }
  if (plan.input.sha256 !== analysis.result.input.sha256 || plan.input.size !== source.size) {
    throw new ElpxError('plan-mismatch', 'The plan was made for a different input file');
  }
  if (plan.optionsHash !== sha256Hex(canonicalJson(plan.options))) throw new ElpxError('plan-mismatch', 'The plan options were modified');
  const replay = buildOptimizationPlan(analysis, plan.options, engineInfo, platform.limits);
  // The stored hash only proves anything if the operations that will run are the ones it covers.
  if (replay.planHash !== plan.planHash || canonicalJson(replay.operations) !== canonicalJson(plan.operations)) {
    throw new ElpxError('plan-mismatch', 'The plan does not match this input, options and engine');
  }
  validations.push({ name: 'plan-matches-input', ok: true, detail: `input sha256 ${plan.input.sha256.slice(0, 16)}…, plan ${plan.planHash.slice(0, 16)}…` });

  const archive = analysis.archive;
  const replacements = new Map<string, StoredResource>();
  const removed = new Set<string>();
  const newTexts = new Map<string, string>();
  let target: OutputTarget | undefined;
  try {
    // 2. Media.
    const videoOps = plan.operations.filter((o): o is Extract<PlanOperation, { op: 'transcode-video' }> => o.op === 'transcode-video');
    const imageOps = plan.operations.filter((o): o is Extract<PlanOperation, { op: 'recompress-image' }> => o.op === 'recompress-image');
    let n = 0;
    for (const op of videoOps) {
      throwIfCancelled(signal);
      n++;
      const thresholds = { minSavingsPercent: plan.options.video.minSavingsPercent, minSavingsBytes: plan.options.video.minSavingsBytes };
      const r = await runVideo(op, archive.byName.get(op.path)!, analysis, platform, engineInfo, {
        signal,
        progress,
        thresholds,
        item: n,
        items: videoOps.length,
      });
      results.push(r.result);
      if (r.candidate) replacements.set(op.path, r.candidate);
    }
    // Audio: a converted file (e.g. WAV → MP3) is renamed below, so its references follow it.
    const audioOps = plan.operations.filter((o): o is Extract<PlanOperation, { op: 'transcode-audio' }> => o.op === 'transcode-audio');
    const converted = new Map<string, string>();
    // Audio encoders are single-threaded: natively, several files run at once (the browser engine queues them).
    let nextAudio = 0;
    const audioWorker = async (): Promise<void> => {
      while (nextAudio < audioOps.length) {
        throwIfCancelled(signal);
        const item = ++nextAudio;
        const op = audioOps[item - 1]!;
        const thresholds = { minSavingsPercent: plan.options.audio.minSavingsPercent, minSavingsBytes: plan.options.audio.minSavingsBytes };
        const r = await runAudio(op, archive.byName.get(op.path)!, analysis, platform, engineInfo, {
          signal,
          progress,
          thresholds,
          item,
          items: audioOps.length,
        });
        results.push(r.result);
        if (r.candidate) {
          replacements.set(op.path, r.candidate);
          if (op.job.rename) converted.set(op.path, op.job.target);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(platform.imageConcurrency, audioOps.length)) }, audioWorker));
    let next = 0;
    let finished = 0;
    const worker = async (): Promise<void> => {
      while (next < imageOps.length) {
        throwIfCancelled(signal);
        const op = imageOps[next++]!;
        const thresholds = { minSavingsPercent: plan.options.images.minSavingsPercent, minSavingsBytes: plan.options.images.minSavingsBytes };
        const r = await runImage(op, archive.byName.get(op.path)!, analysis, platform, { signal, progress, thresholds });
        finished++;
        progress({ stage: 'encode-image', resource: op.path, item: finished, items: imageOps.length, fraction: Math.min(0.99, finished / imageOps.length) });
        results.push(r.result);
        if (r.candidate) replacements.set(op.path, r.candidate);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(platform.imageConcurrency, imageOps.length)) }, worker));
    // PDFs, one at a time (qpdf holds the file and its output in memory).
    const pdfOps = plan.operations.filter((o): o is Extract<PlanOperation, { op: 'optimize-pdf' }> => o.op === 'optimize-pdf');
    let p = 0;
    for (const op of pdfOps) {
      throwIfCancelled(signal);
      p++;
      const thresholds = { minSavingsPercent: plan.options.pdf.minSavingsPercent, minSavingsBytes: plan.options.pdf.minSavingsBytes };
      const r = await runPdf(op, archive.byName.get(op.path)!, analysis, platform, { signal, progress, thresholds, item: p, items: pdfOps.length });
      results.push(r.result);
      if (r.candidate) replacements.set(op.path, r.candidate);
    }

    // 3. Cleanup, deduplication and reference rewriting.
    for (const op of plan.operations) {
      if (op.op === 'remove-unused') {
        removed.add(op.path);
        results.push({ id: op.id, op: op.op, path: op.path, status: 'applied', before: op.size, after: 0, detail: op.reason });
      }
    }
    // Converted files keep the names the plan showed (a name freed by a failed conversion is not reused).
    const plannedNames = new Map(audioOps.filter((op) => op.to !== undefined && converted.has(op.path)).map((op) => [op.path, op.to!]));
    // A file whose planned conversion did not happen stays exactly as it was: the plan showed no other move or rename for it.
    const frozen = new Set(audioOps.filter((op) => op.to !== undefined && !converted.has(op.path)).map((op) => op.path));
    const restructure = restructurePlan(analysis, plan.options, new Set(removed), converted, plannedNames, frozen);
    for (const [path, target] of converted) {
      const i = results.findIndex((r) => r.op === 'transcode-audio' && r.path === path);
      const to = restructure.renames.get(path);
      // Names are chosen again from the conversions that succeeded: report the one used, not the planned one.
      if (to !== undefined) results[i] = { ...results[i]!, detail: `converted to ${target.toUpperCase()} and renamed to ${to}` };
      if (to !== undefined || restructure.merged.has(path)) continue;
      // Defensive: a converted file whose rename did not hold keeps its original bytes and name.
      await replacements.get(path)?.dispose();
      replacements.delete(path);
      results[i] = { ...results[i]!, status: 'reverted', detail: 'its references could not follow the new name; the original was kept' };
    }
    for (const d of restructure.merges) {
      for (const p of d.remove) {
        removed.add(p);
        replacements.get(p)?.dispose();
        replacements.delete(p);
      }
      const size = analysis.result.entries.find((e) => e.path === d.keep)?.size ?? 0;
      results.push({
        id: `dedup:${d.keep}`,
        op: 'deduplicate',
        path: d.keep,
        status: 'applied',
        before: size * (d.remove.length + 1),
        after: size,
        detail: `removed ${d.remove.join(', ')}`,
      });
    }
    for (const m of restructure.moves) {
      results.push({
        id: `move:${m.from}`,
        op: 'move-resource',
        path: m.from,
        status: 'applied',
        detail: `moved to ${m.to}; ${m.references} ${m.references === 1 ? 'reference' : 'references'} rewritten`,
      });
    }
    for (const m of restructure.renamed) {
      results.push({
        id: `rename:${m.from}`,
        op: 'rename-resource',
        path: m.from,
        status: 'applied',
        detail: `renamed to ${m.to}; ${m.references} ${m.references === 1 ? 'reference' : 'references'} rewritten`,
      });
    }
    for (const u of restructure.unlinks) {
      results.push({
        id: `unlink:${u.key}`,
        op: 'remove-missing-reference',
        path: u.key,
        status: 'applied',
        detail: `${u.references} ${u.references === 1 ? 'reference' : 'references'} taken out of ${u.entries.join(', ')}`,
      });
    }
    for (const d of restructure.emptiedDirectories) removed.add(d);
    const renames = restructure.renames;
    for (const [entry, text] of applyTextEdits(analysis.texts, restructure.edits)) {
      newTexts.set(entry, text);
      results.push({
        id: `rewrite:${entry}`,
        op: 'rewrite-references',
        path: entry,
        status: 'applied',
        detail: `${restructure.edits.get(entry)!.length} references rewritten or taken out`,
      });
    }
    const xml = newTexts.get('content.xml');
    if (xml !== undefined) {
      parseContentXml(xml, platform.limits.maxXmlDepth);
      validations.push({ name: 'content-xml-well-formed-after-rewrite', ok: true });
    }
    const finalNames = archive.entries.filter((e) => !e.isDirectory && !removed.has(e.name)).map((e) => renames.get(e.name) ?? e.name);
    // The manifest lists files only: dropping empty directory entries does not change it (nor does the plan list it).
    const filesChanged = renames.size > 0 || [...removed].some((p) => !p.endsWith('/'));
    if (filesChanged && analysis.manifest) {
      newTexts.set(MANIFEST_PATH, renderManifest(analysis.manifest, finalNames));
      results.push({
        id: `manifest:${MANIFEST_PATH}`,
        op: 'update-manifest',
        path: MANIFEST_PATH,
        status: 'applied',
        detail: `${finalNames.length} files listed`,
      });
    }

    // 4. Package.
    throwIfCancelled(signal);
    target = await platform.createOutput();
    const writer = new ZipWriter(target.sink, signal ? { signal } : {});
    let written = 0;
    for (const entry of archive.entries) {
      throwIfCancelled(signal);
      if (removed.has(entry.name)) continue;
      const replacement = replacements.get(entry.name);
      const text = newTexts.get(entry.name);
      const newName = renames.get(entry.name);
      const meta = newName === undefined ? metaFromEntry(entry) : renamedMeta(entry, newName);
      if (replacement) {
        const data = await replacement.open();
        try {
          await writer.addStoredSource(meta, data);
        } finally {
          await data.close?.();
        }
      } else if (text !== undefined) {
        await writer.addBytes(meta, utf8Encode(text), entry.method === 0 ? 0 : 8);
      } else {
        await writer.copyEntry(archive, entry, newName === undefined ? undefined : meta);
      }
      written++;
      progress({
        stage: 'package',
        resource: entry.name,
        item: written,
        items: finalNames.length,
        fraction: Math.min(0.99, written / Math.max(1, finalNames.length)),
      });
    }
    await writer.finish();
    const outSource = await target.finish();
    validations.push({ name: 'zip-written', ok: true, detail: `${written} entries, ${outSource.size} bytes` });

    // 5. Verify the packaged result from scratch.
    progress({ stage: 'verify', message: 'Re-opening and validating the result' });
    const check = await analyzeArchive(outSource, { limits: platform.limits, inputName: run.outputName, ...(signal ? { signal } : {}) });
    const verification = compareWithBaseline(analysis, check, removed, renames, replacements, newTexts);
    validations.push(...verification);
    const failed = verification.filter((v) => !v.ok);
    if (failed.length > 0) {
      await target.discard();
      const detail = failed.map((v) => `${v.name}: ${v.detail ?? ''}`).join('; ');
      return { report: buildReport({ ...base, status: 'failed', error: `The optimized package failed validation (${detail}); nothing was delivered` }) };
    }

    // 6. Net benefit. Moving files and taking out broken references are wanted changes even when
    // the package does not get smaller.
    const applied = results.filter((r) => r.status === 'applied');
    const sizeAfter = outSource.size;
    const structural = applied.some((r) => r.op === 'move-resource' || r.op === 'rename-resource' || r.op === 'remove-missing-reference');
    if (applied.length === 0 || (sizeAfter >= source.size && !structural)) {
      const copy = await target.useOriginal(source);
      const outSha = await hashSource(copy, signal);
      validations.push({ name: 'no-improvement-copy', ok: outSha === analysis.result.input.sha256, detail: 'Delivered a byte-for-byte copy of the input' });
      return {
        report: buildReport({ ...base, status: 'no-improvement', output: { name: run.outputName, size: copy.size, sha256: outSha }, after: check }),
        output: copy,
        target,
      };
    }
    const outSha = await hashSource(outSource, signal);
    const anyFailed = results.some((r) => r.status === 'failed');
    return {
      report: buildReport({
        ...base,
        status: anyFailed ? 'partial' : 'optimized',
        output: { name: run.outputName, size: sizeAfter, sha256: outSha },
        after: check,
      }),
      output: outSource,
      target,
    };
  } catch (error) {
    await target?.discard().catch(() => undefined);
    if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) {
      return { report: buildReport({ ...base, status: 'cancelled', error: 'Cancelled by the user; nothing was delivered' }) };
    }
    throw error;
  } finally {
    for (const r of replacements.values()) await r.dispose().catch(() => undefined);
    await platform.store.disposeAll().catch(() => undefined);
  }
}

/** Streams a source through SHA-256. */
async function hashSource(source: ByteSource, signal: CancelSignal | undefined): Promise<string> {
  const h = new Sha256();
  for await (const chunk of streamRange(source, 0, source.size, signal ? { signal } : {})) h.update(chunk);
  return h.digestHex();
}

interface StepContext {
  signal: CancelSignal | undefined;
  progress: ProgressListener;
  /** Minimum savings for a candidate to replace the original. */
  thresholds: { minSavingsPercent: number; minSavingsBytes: number };
  item?: number;
  items?: number;
}

/** Runs one video job with validation; returns the accepted candidate, if any. */
async function runVideo(
  op: Extract<PlanOperation, { op: 'transcode-video' }>,
  entry: ZipEntry,
  analysis: Analysis,
  platform: Platform,
  engineInfo: EngineInfo,
  step: StepContext,
): Promise<{ result: OperationResult; candidate?: StoredResource }> {
  const base = { id: op.id, op: op.op, path: op.path, before: op.size, lossy: true, conversions: op.conversions } as const;
  const ctx = {
    resourcePath: op.path,
    timeoutMs: platform.limits.videoTimeoutMs,
    ...(step.signal ? { signal: step.signal } : {}),
    onProgress: step.progress,
  };
  let input: StoredResource | undefined;
  let candidate: StoredResource | undefined;
  try {
    step.progress({ stage: 'extract', resource: op.path, ...(step.item ? { item: step.item, items: step.items! } : {}) });
    input = await platform.store.fromEntry(analysis.archive!, entry, extname(op.path) || 'bin', step.signal);
    step.progress({ stage: 'transcode', resource: op.path, processedSeconds: 0, totalSeconds: op.job.expected.duration });
    candidate = await platform.engine.transcodeVideo(input, op.job, ctx);
    step.progress({ stage: 'validate', resource: op.path, message: 'Inspecting the new video' });
    const probe = await platform.engine.probe(candidate, ctx);
    const check = validateVideoCandidate(op.job, probe);
    if (!check.ok) return reject(`candidate rejected: ${check.problems.join('; ')}`);
    const checks = ['streams, duration and size match the plan'];
    step.progress({ stage: 'validate', resource: op.path, message: 'Decoding the new video' });
    await platform.engine.decodeCheck(candidate, op.job, ctx);
    checks.push('full decode without errors');
    if (platform.engine.playbackCheck) {
      const mime = op.job.container === 'webm' ? 'video/webm' : 'video/mp4';
      const before = await platform.engine.playbackCheck(input, mime, ctx);
      const after = await platform.engine.playbackCheck(candidate, mime, ctx);
      if (before === 'playable' && after !== 'playable') return reject('the new video does not play in this browser');
      checks.push(
        after === 'unsupported'
          ? `playback: ${mime} not supported by this browser (original: ${before})`
          : `playback in this browser: ${after} (original: ${before})`,
      );
    }
    if (!isWorthReplacing(op.size, candidate.size, step.thresholds)) {
      return reject(`not smaller enough (${op.size} → ${candidate.size} bytes)`);
    }
    // A temporary file that cannot be deleted must not throw away a valid candidate.
    await input.dispose().catch(() => undefined);
    return { result: { ...base, status: 'applied', after: candidate.size, engine: engineInfo.engine, checks }, candidate };
  } catch (error) {
    await input?.dispose().catch(() => undefined);
    await candidate?.dispose().catch(() => undefined);
    if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) throw error;
    return { result: { ...base, status: 'failed', detail: errorMessage(error) } };
  }

  async function reject(detail: string): Promise<{ result: OperationResult }> {
    await input?.dispose().catch(() => undefined);
    await candidate?.dispose().catch(() => undefined);
    return { result: { ...base, status: 'reverted', ...(candidate ? { after: candidate.size } : {}), detail } };
  }
}

/** Runs one audio job with validation; returns the accepted candidate, if any. */
async function runAudio(
  op: Extract<PlanOperation, { op: 'transcode-audio' }>,
  entry: ZipEntry,
  analysis: Analysis,
  platform: Platform,
  engineInfo: EngineInfo,
  step: StepContext,
): Promise<{ result: OperationResult; candidate?: StoredResource }> {
  const base = { id: op.id, op: op.op, path: op.path, before: op.size, lossy: true, conversions: op.conversions } as const;
  const ctx = {
    resourcePath: op.path,
    timeoutMs: platform.limits.videoTimeoutMs,
    ...(step.signal ? { signal: step.signal } : {}),
    onProgress: step.progress,
  };
  let input: StoredResource | undefined;
  let candidate: StoredResource | undefined;
  const reject = async (detail: string): Promise<{ result: OperationResult }> => {
    await input?.dispose().catch(() => undefined);
    await candidate?.dispose().catch(() => undefined);
    return { result: { ...base, status: 'reverted', ...(candidate ? { after: candidate.size } : {}), detail } };
  };
  try {
    if (!platform.engine.transcodeAudio) throw new ElpxError('media-engine-unavailable', 'This engine does not process audio');
    step.progress({ stage: 'extract', resource: op.path, ...(step.item ? { item: step.item, items: step.items! } : {}) });
    input = await platform.store.fromEntry(analysis.archive!, entry, extname(op.path) || 'bin', step.signal);
    const total = op.job.expected.duration;
    step.progress({ stage: 'transcode', resource: op.path, processedSeconds: 0, ...(total !== undefined ? { totalSeconds: total } : {}) });
    candidate = await platform.engine.transcodeAudio(input, op.job, ctx);
    step.progress({ stage: 'validate', resource: op.path, message: 'Inspecting the new audio' });
    const check = validateAudioCandidate(op.job, await platform.engine.probe(candidate, ctx));
    if (!check.ok) return await reject(`candidate rejected: ${check.problems.join('; ')}`);
    const checks = ['stream, duration, channels and sample rate match the plan'];
    await platform.engine.decodeCheck(candidate, { demuxer: audioDemuxer(op.job.target) }, ctx);
    checks.push('full decode without errors');
    if (platform.engine.playbackCheck) {
      const mime = AUDIO_MIME[op.job.target];
      const original = analysis.result.entries.find((e) => e.path === op.path)?.mime ?? mime;
      const before = await platform.engine.playbackCheck(input, original, ctx);
      const after = await platform.engine.playbackCheck(candidate, mime, ctx);
      if (before === 'playable' && after !== 'playable') return await reject('the new audio does not play in this browser');
      checks.push(after === 'unsupported' ? `playback: ${mime} not supported by this browser` : `playback in this browser: ${after} (original: ${before})`);
    }
    if (!isWorthReplacing(op.size, candidate.size, step.thresholds)) return await reject(`not smaller enough (${op.size} → ${candidate.size} bytes)`);
    await input.dispose().catch(() => undefined);
    const detail = op.to !== undefined ? `converted to ${op.job.target.toUpperCase()} and renamed to ${op.to}` : undefined;
    return { result: { ...base, status: 'applied', after: candidate.size, engine: engineInfo.engine, checks, ...(detail ? { detail } : {}) }, candidate };
  } catch (error) {
    await input?.dispose().catch(() => undefined);
    await candidate?.dispose().catch(() => undefined);
    if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) throw error;
    return { result: { ...base, status: 'failed', detail: errorMessage(error) } };
  }
}

/**
 * Runs one PDF job: the image pass (when allowed) and then the lossless pass;
 * the first candidate that passes qpdf --check without warnings, keeps the
 * page count and saves enough is used. Otherwise the original is kept.
 */
async function runPdf(
  op: Extract<PlanOperation, { op: 'optimize-pdf' }>,
  entry: ZipEntry,
  analysis: Analysis,
  platform: Platform,
  step: StepContext,
): Promise<{ result: OperationResult; candidate?: StoredResource }> {
  const base = { id: op.id, op: op.op, path: op.path, before: op.size, conversions: op.conversions } as const;
  const engine = platform.engine;
  if (!engine.runQpdf) return { result: { ...base, status: 'failed', detail: 'This engine does not process PDFs' } };
  const runner = { runQpdf: engine.runQpdf.bind(engine) };
  const ctx = { resourcePath: op.path, timeoutMs: platform.limits.videoTimeoutMs, ...(step.signal ? { signal: step.signal } : {}) };
  const notes: string[] = [];
  try {
    const original = await readEntryBytes(analysis.archive!, entry, platform.limits.maxPdfBytes, step.signal ? { signal: step.signal } : {});
    const passes: ('images' | 'lossless')[] = op.job.images ? ['images', 'lossless'] : ['lossless'];
    for (const pass of passes) {
      throwIfCancelled(step.signal);
      step.progress({ stage: 'pdf', resource: op.path, ...(step.item ? { item: step.item, items: step.items! } : {}), message: `qpdf, ${pass} pass` });
      try {
        const candidate = await rewritePdf(runner, original, op.job, pass, ctx);
        await checkPdf(runner, candidate, ctx);
        const info = await inspectPdf(runner, candidate, ctx);
        const problems = validatePdfCandidate(op.job, info);
        if (problems.length > 0) {
          notes.push(`${pass} pass rejected: ${problems.join('; ')}`);
          continue;
        }
        if (!isWorthReplacing(op.size, candidate.length, step.thresholds)) {
          notes.push(`${pass} pass not smaller enough (${op.size} → ${candidate.length} bytes)`);
          continue;
        }
        const stored = await platform.store.fromBytes(candidate, 'pdf');
        const checks = ['qpdf --check without warnings', `${info.pages} pages, as in the original`];
        return {
          result: {
            ...base,
            lossy: pass === 'images',
            status: 'applied',
            after: candidate.length,
            checks,
            ...(notes.length > 0 ? { detail: `lossless pass kept (${notes.join('; ')})` } : {}),
          },
          candidate: stored,
        };
      } catch (error) {
        if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) throw error;
        notes.push(`${pass} pass: ${errorMessage(error)}`);
      }
    }
    return { result: { ...base, lossy: false, status: 'reverted', detail: notes.join('; ') } };
  } catch (error) {
    if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) throw error;
    return { result: { ...base, status: 'failed', detail: errorMessage(error) } };
  }
}

/** Runs one image job with validation. */
async function runImage(
  op: Extract<PlanOperation, { op: 'recompress-image' }>,
  entry: ZipEntry,
  analysis: Analysis,
  platform: Platform,
  step: StepContext,
): Promise<{ result: OperationResult; candidate?: StoredResource }> {
  const base = { id: op.id, op: op.op, path: op.path, before: op.size, lossy: op.lossy, conversions: op.conversions } as const;
  const ctx = { resourcePath: op.path, timeoutMs: platform.limits.imageTimeoutMs, ...(step.signal ? { signal: step.signal } : {}) };
  try {
    const original = await readEntryBytes(analysis.archive!, entry, platform.limits.maxImageBytes, step.signal ? { signal: step.signal } : {});
    const encoded = await platform.engine.encodeImage(original, op.job, ctx);
    const withMeta = injectMetadata(encoded, extractMetadata(original, op.job.format, op.job.metadata), op.job.resize ?? {});
    const info = inspectImage(withMeta, op.job.format);
    if (info.error || info.format !== op.job.format)
      return { result: { ...base, status: 'reverted', detail: `candidate is not a valid ${op.job.format}: ${info.error ?? info.format}` } };
    if (info.animated) return { result: { ...base, status: 'reverted', detail: 'candidate is animated' } };
    const verification = await platform.engine.verifyImage(original, withMeta, op.job, ctx);
    if (!verification.ok)
      return { result: { ...base, status: 'reverted', after: withMeta.length, detail: `candidate rejected: ${verification.problems.join('; ')}` } };
    if (!isWorthReplacing(op.size, withMeta.length, step.thresholds)) {
      return { result: { ...base, status: 'reverted', after: withMeta.length, detail: `not smaller enough (${op.size} → ${withMeta.length} bytes)` } };
    }
    const candidate = await platform.store.fromBytes(withMeta, extname(op.path) || 'bin');
    const checks = ['decodes with the same size and format', ...(verification.identicalPixels ? ['pixel-identical to the original'] : [])];
    return { result: { ...base, status: 'applied', after: withMeta.length, checks }, candidate };
  } catch (error) {
    if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) throw error;
    return { result: { ...base, status: 'failed', detail: errorMessage(error) } };
  }
}

/** Diagnostics that indicate a regression when they appear only after optimization. */
const REGRESSION_CODES = new Set([
  'missing-resource',
  'ambiguous-reference',
  'lenient-resolution',
  'asset-uri-unmapped',
  'content-xml-invalid',
  'ode-structure',
  'json-properties-malformed',
  'screenshot-invalid',
  'extension-mismatch',
  'manifest-invalid',
]);

/** Writer metadata for an entry stored under a new name (UTF-8 flagged when the name needs it). */
function renamedMeta(entry: ZipEntry, name: string): EntryMeta {
  const meta = metaFromEntry(entry);
  return { ...meta, rawName: utf8Encode(name), utf8: meta.utf8 || [...name].some((c) => c.charCodeAt(0) > 0x7f) };
}

/** Counts explicit references that resolve, ignoring those inside removed entries. */
function resolvedCount(analysis: Analysis, removed: ReadonlySet<string>): number {
  return analysis.result.references.filter((r) => r.kind === 'explicit' && r.status === 'resolved' && !removed.has(r.location.entry ?? '')).length;
}

/** Compares the re-analysis of the output with the input analysis. */
function compareWithBaseline(
  before: Analysis,
  after: Analysis,
  removed: ReadonlySet<string>,
  renames: ReadonlyMap<string, string>,
  replaced: ReadonlyMap<string, StoredResource>,
  texts: ReadonlyMap<string, string>,
): Validation[] {
  const out: Validation[] = [];
  out.push({
    name: 'output-analyzable',
    ok: after.result.ok,
    detail: after.result.ok
      ? 'ZIP structure, CRCs and content.xml are valid'
      : (after.result.diagnostics.find((d) => d.severity === 'fatal')?.message ?? 'fatal'),
  });
  if (!after.result.ok) return out;
  const expected = before.result.entries.filter((e) => !removed.has(e.path)).map((e) => renames.get(e.path) ?? e.path);
  const actual = after.result.entries.map((e) => e.path);
  out.push({
    name: 'entry-set',
    ok: expected.length === actual.length && expected.every((p, i) => p === actual[i]),
    detail: `${actual.length} entries (${removed.size} removed, ${renames.size} moved)`,
  });
  const originalName = new Map([...renames].map(([from, to]) => [to, from]));
  const beforeEntries = new Map(before.archive!.entries.map((e) => [e.name, e]));
  let changed = 0;
  let unexpected = 0;
  for (const e of after.archive!.entries) {
    const name = originalName.get(e.name) ?? e.name;
    const b = beforeEntries.get(name);
    if (!b) continue;
    const same = b.crc32 === e.crc32 && b.uncompressedSize === e.uncompressedSize;
    const shouldChange = replaced.has(name) || texts.has(name);
    if (!same) changed++;
    if (!same && !shouldChange) unexpected++;
  }
  out.push({ name: 'unchanged-entries-preserved', ok: unexpected === 0, detail: `${changed} entries changed as planned, ${unexpected} unexpected changes` });
  const beforeKeys = new Set(before.result.diagnostics.map(diagnosticKey));
  // A moved file keeps its diagnostics (e.g. an extension mismatch): compare them under its original name.
  const keyBefore = (d: Diagnostic): string => {
    const original = d.resource === undefined ? undefined : originalName.get(d.resource);
    return diagnosticKey(original === undefined ? d : { ...d, resource: original });
  };
  const introduced: Diagnostic[] = after.result.diagnostics.filter(
    (d) => REGRESSION_CODES.has(d.code) && !beforeKeys.has(keyBefore(d)) && !(d.resource && removed.has(d.resource)),
  );
  out.push({
    name: 'no-new-problems',
    ok: introduced.length === 0,
    detail:
      introduced.length === 0
        ? 'No new missing, ambiguous or structural problems'
        : introduced
            .slice(0, 5)
            .map((d) => `${d.code}: ${d.message}`)
            .join('; '),
  });
  const beforeResolved = new Set(before.result.references.filter((r) => r.status === 'resolved').map((r) => `${r.location.entry}|${r.value}`));
  const lost = after.result.references.filter((r) => r.status !== 'resolved' && beforeResolved.has(`${r.location.entry}|${r.value}`));
  const resolvedBefore = resolvedCount(before, removed);
  const resolvedAfter = resolvedCount(after, new Set());
  const kept = lost.length === 0 && resolvedAfter >= resolvedBefore;
  out.push({
    name: 'references-still-resolve',
    ok: kept,
    detail: kept
      ? `${after.result.references.length} references checked, ${resolvedAfter} resolve (${resolvedBefore} before)`
      : `${lost.length} references no longer resolve; ${resolvedAfter} resolve (${resolvedBefore} before)`,
  });
  const pagesBefore = before.ode!.pages.length;
  const pagesAfter = after.ode!.pages.length;
  const compsBefore = before.ode!.components.map((c) => c.id).join(',');
  const compsAfter = after.ode!.components.map((c) => c.id).join(',');
  out.push({
    name: 'structure-and-ids-preserved',
    ok: pagesBefore === pagesAfter && compsBefore === compsAfter,
    detail: `${pagesAfter} pages, ${after.ode!.components.length} components`,
  });
  const manifestText = texts.get(MANIFEST_PATH);
  if (manifestText !== undefined) {
    const m = parseManifest(manifestText);
    const ok = !('error' in m) && manifestDiff(m, actual).missing.length === 0 && manifestDiff(m, actual).unlisted.length === 0;
    out.push({
      name: 'manifest-matches-entries',
      ok,
      detail: ok ? 'libs/elpx-manifest.js lists exactly the final entries' : 'manifest differs from the entries',
    });
  }
  return out;
}
