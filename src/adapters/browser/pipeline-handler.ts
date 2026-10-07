import { analyzeArchive } from '../../core/analyze/analyze.js';
import type { Analysis } from '../../core/analyze/model.js';
import { CancelledError, ElpxError, errorMessage } from '../../core/errors.js';
import { BROWSER_LIMITS, type Limits } from '../../core/limits.js';
import type { ProgressEvent } from '../../core/media/engine.js';
import { normalizeOptions } from '../../core/plan/options.js';
import { buildOptimizationPlan, type OptimizationPlan } from '../../core/plan/plan.js';
import { optimizeArchive } from '../../core/optimize/optimize.js';
import { readEntry, readEntryBytes } from '../../core/zip/reader.js';
import { BlobByteSource, BlobOutputTarget, BlobStore } from './blob-io.js';
import { BrowserMediaEngine, type BrowserEngineOptions } from './browser-media-engine.js';
import type { FfmpegAssets, ThreadingPreference } from './ffmpeg-loader.js';
import { optimizedFileName, type ClientMessage, type EngineStatus, type WorkerMessage } from './protocol.js';

/** Dependencies of the pipeline (real ones in the worker, fakes in tests). */
export interface PipelineDeps {
  readonly assets: FfmpegAssets;
  readonly limits?: Limits;
  readonly imageConcurrency?: number;
  readonly engineFactory?: (options: BrowserEngineOptions) => BrowserMediaEngine;
}

/** Largest compressed entry inflated for a preview (stored entries are sliced without copying). */
export const PREVIEW_MAX_INFLATE = 256 * 1024 * 1024;

/** Applies a page-requested video size limit, never above the base limit; invalid values are ignored. */
function withVideoLimit(base: Limits, maxVideoBytes: number | undefined): Limits {
  if (maxVideoBytes === undefined || !Number.isSafeInteger(maxVideoBytes) || maxVideoBytes <= 0) return base;
  return { ...base, maxVideoBytes: Math.min(base.maxVideoBytes, maxVideoBytes) };
}

/**
 * The pipeline state machine that runs inside the worker: it keeps the
 * selected File, the analysis and the last plan, and executes the plan with
 * the browser adapters. Only static app assets are ever fetched; the File is
 * read locally.
 */
export function createPipelineHandler(deps: PipelineDeps, post: (m: WorkerMessage) => void): (m: ClientMessage) => Promise<void> {
  const baseLimits = deps.limits ?? BROWSER_LIMITS;
  // Limits of the current analysis; plan and optimize must use the same ones.
  let limits: Limits = baseLimits;
  let file: File | undefined;
  let analysis: Analysis | undefined;
  let plan: OptimizationPlan | undefined;
  const store = new BlobStore();
  let engine: BrowserMediaEngine | undefined;
  let threading: ThreadingPreference = 'auto';
  let controller: AbortController | undefined;
  let playbackCounter = 0;
  const pendingPlayback = new Map<number, (r: 'playable' | 'not-playable' | 'unsupported') => void>();

  const playbackProbe = (blob: Blob, mime: string): Promise<'playable' | 'not-playable' | 'unsupported'> =>
    new Promise((resolve) => {
      const requestId = ++playbackCounter;
      pendingPlayback.set(requestId, resolve);
      post({ type: 'playback-check', requestId, blob, mime });
    });

  const postEngine = (state: EngineStatus['state'], message: string | undefined): void => {
    const decision = engine?.threadingDecision;
    post({ type: 'engine', status: { state, ...(decision ? { mode: decision.mode, reason: decision.reason } : {}), ...(message ? { message } : {}) } });
  };

  const getEngine = (): BrowserMediaEngine => {
    if (!engine) {
      const options: BrowserEngineOptions = {
        store,
        assets: deps.assets,
        threading,
        playbackProbe,
        onLoad: (e) => postEngine(e.fraction === 1 ? 'ready' : 'loading', e.message),
        onLoadError: (message) => postEngine('error', message),
        onLoadCancelled: () => postEngine('idle', undefined),
      };
      engine = deps.engineFactory ? deps.engineFactory(options) : new BrowserMediaEngine(options);
    }
    return engine;
  };

  const progress = (id: number) => (event: ProgressEvent) => post({ type: 'progress', id, event });

  const fail = (id: number, error: unknown): void => {
    if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) {
      post({ type: 'cancelled', id });
      return;
    }
    post({ type: 'error', id, code: error instanceof ElpxError ? error.code : 'internal', message: errorMessage(error) });
  };

  return async (message: ClientMessage): Promise<void> => {
    switch (message.type) {
      case 'cancel':
        controller?.abort();
        return;
      case 'playback-result': {
        const resolve = pendingPlayback.get(message.requestId);
        pendingPlayback.delete(message.requestId);
        resolve?.(message.result);
        return;
      }
      case 'analyze': {
        controller = new AbortController();
        await store.disposeAll();
        if (message.threading && message.threading !== threading) {
          // A different core is needed; the loaded one is released.
          threading = message.threading;
          await engine?.dispose();
          engine = undefined;
        }
        file = message.file;
        limits = withVideoLimit(baseLimits, message.maxVideoBytes);
        analysis = undefined;
        plan = undefined;
        try {
          const result = await analyzeArchive(new BlobByteSource(file), {
            limits,
            inputName: file.name,
            signal: controller.signal,
            onProgress: progress(message.id),
            media: { engine: getEngine(), store },
          });
          analysis = result;
          post({ type: 'analysis', id: message.id, result: result.result });
        } catch (error) {
          fail(message.id, error);
        }
        return;
      }
      case 'plan': {
        try {
          if (!analysis) throw new ElpxError('internal', 'Analyze a project first');
          const options = normalizeOptions(message.options);
          plan = buildOptimizationPlan(analysis, options, await getEngine().info(), limits);
          post({ type: 'plan', id: message.id, plan });
        } catch (error) {
          fail(message.id, error);
        }
        return;
      }
      case 'preview': {
        try {
          const archive = analysis?.archive;
          if (!analysis || !archive || !file) throw new ElpxError('internal', 'Analyze a project first');
          const info = analysis.result.entries.find((e) => e.path === message.path);
          const entry = archive.byName.get(message.path);
          if (!info || !entry || (info.kind !== 'image' && info.kind !== 'video' && info.kind !== 'audio' && info.format !== 'pdf')) {
            throw new ElpxError('invalid-options', 'Only images, audio, video and PDFs can be previewed');
          }
          let blob: Blob;
          if (entry.method === 0) {
            // CRC and sizes were verified during analysis; the stored bytes are the content.
            blob = file.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize, info.mime);
          } else {
            if (entry.uncompressedSize > PREVIEW_MAX_INFLATE) throw new ElpxError('limit-exceeded', 'Too large to preview');
            const parts: BlobPart[] = [];
            for await (const chunk of readEntry(archive, entry)) parts.push(chunk.slice());
            blob = new Blob(parts, { type: info.mime });
          }
          post({ type: 'preview', id: message.id, blob });
        } catch (error) {
          fail(message.id, error);
        }
        return;
      }
      case 'read': {
        try {
          const archive = analysis?.archive;
          if (!archive) throw new ElpxError('internal', 'Analyze a project first');
          const entry = archive.byName.get(message.path);
          const blob = entry && !entry.isDirectory ? new Blob([(await readEntryBytes(archive, entry, PREVIEW_MAX_INFLATE)).slice()]) : undefined;
          post({ type: 'read', id: message.id, ...(blob ? { blob } : {}) });
        } catch (error) {
          fail(message.id, error);
        }
        return;
      }
      case 'optimize': {
        controller = new AbortController();
        try {
          if (!analysis || !file || !plan) throw new ElpxError('internal', 'Analyze and plan first');
          if (plan.planHash !== message.planHash) throw new ElpxError('plan-mismatch', 'The confirmed plan is no longer current; review it again');
          const target = new BlobOutputTarget();
          const fileName = optimizedFileName(file.name);
          const outcome = await optimizeArchive(
            new BlobByteSource(file),
            analysis,
            plan,
            {
              engine: getEngine(),
              store,
              limits,
              imageConcurrency: deps.imageConcurrency ?? getEngine().imageConcurrency,
              createOutput: () => Promise.resolve(target),
            },
            {
              signal: controller.signal,
              onProgress: progress(message.id),
              outputName: fileName,
              ...(message.screenshot ? { screenshot: new Uint8Array(await message.screenshot.arrayBuffer()) } : {}),
            },
          );
          if (outcome.report.status === 'cancelled') {
            post({ type: 'cancelled', id: message.id });
            return;
          }
          const output = outcome.output ? target.blob : undefined;
          post({ type: 'result', id: message.id, report: outcome.report, ...(output ? { output } : {}), fileName });
        } catch (error) {
          fail(message.id, error);
        } finally {
          await store.disposeAll();
          // Image workers stay loaded for the next job (they are needed to keep working when the
          // server is no longer reachable); they are terminated on cancellation and page unload.
        }
        return;
      }
    }
  };
}
