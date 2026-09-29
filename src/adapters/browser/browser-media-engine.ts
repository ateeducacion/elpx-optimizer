import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { CancelledError, ElpxError, errorMessage } from '../../core/errors.js';
import { onCancel, throwIfCancelled } from '../../core/cancel.js';
import type { EngineInfo, ImageVerification, JobContext, MediaEngine, ProgressListener, QpdfResult, StoredResource } from '../../core/media/engine.js';
import type { ImageJob } from '../../core/media/image-policy.js';
import { FFPROBE_ARGS, parseProbeJson, type ProbeResult } from '../../core/media/probe.js';
import { buildDecodeCheckArgs, buildVideoArgs, type VideoJob } from '../../core/media/video-policy.js';
import { AUDIO_MIME, buildAudioArgs, type AudioJob } from '../../core/media/audio-policy.js';
import { BlobResource, type BlobStore } from './blob-io.js';
import {
  chooseThreading,
  currentEnvironment,
  PINNED_AUDIO_ENCODERS,
  PINNED_CORE_ENCODERS,
  parseEncoderList,
  type FfmpegAssets,
  type ThreadingDecision,
  type ThreadingPreference,
} from './ffmpeg-loader.js';
import { CODEC_VERSIONS, verifyWithCodecs, type ImageCodecs } from './image-codecs.js';
import { ImagePool, imageWorkerCount, type ImageWorkerLike } from './image-pool.js';
import { QPDF_VERSION } from './qpdf-version.js';

/** The subset of a Worker used for the qpdf worker (a fake in tests). */
export interface PdfWorkerLike {
  postMessage(message: { id: number; args: readonly string[]; input: Uint8Array }, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: { id: number; result?: QpdfResult; error?: string } }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

/** FFmpeg runs per instance before a fresh one is loaded (the core is cached, so a reload is quick). */
export const JOBS_PER_INSTANCE = 60;

/** The subset of @ffmpeg/ffmpeg's FFmpeg class the engine uses (injectable for tests). */
export interface FfmpegLike {
  load(config: { coreURL: string; wasmURL: string; workerURL?: string; classWorkerURL?: string }): Promise<unknown>;
  exec(args: string[], timeout?: number): Promise<number>;
  ffprobe(args: string[], timeout?: number): Promise<number>;
  readFile(path: string, encoding?: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<unknown>;
  createDir(path: string): Promise<unknown>;
  deleteDir(path: string): Promise<unknown>;
  mount(type: FFFSType, options: { blobs?: { name: string; data: Blob }[] }, mountPoint: string): Promise<unknown>;
  unmount(mountPoint: string): Promise<unknown>;
  on(event: 'log', cb: (e: { type: string; message: string }) => void): void;
  on(event: 'progress', cb: (e: { progress: number; time: number }) => void): void;
  terminate(): void;
}

export interface BrowserEngineOptions {
  readonly store: BlobStore;
  readonly assets: FfmpegAssets;
  readonly threading?: ThreadingPreference;
  /** Main-thread playback check (the worker has no <video> element). */
  readonly playbackProbe?: (blob: Blob, mime: string) => Promise<'playable' | 'not-playable' | 'unsupported'>;
  /** In-process image codecs (tests); by default images are processed in a pool of workers. */
  readonly codecs?: ImageCodecs;
  /** Starts one image worker (injectable for tests). */
  readonly createImageWorker?: () => ImageWorkerLike;
  /** Number of image workers (default: from the device's core count). */
  readonly imageWorkers?: number;
  readonly createFfmpeg?: () => FfmpegLike;
  /** Starts the qpdf worker (injectable for tests). */
  readonly createPdfWorker?: () => PdfWorkerLike;
  /** Engine-load progress (separate from transcoding progress). */
  readonly onLoad?: ProgressListener;
  /** FFmpeg could not be loaded (the failure is not cached: the next job tries again). */
  readonly onLoadError?: (message: string) => void;
}

/**
 * Browser media engine: the real FFmpeg (ffmpeg.wasm) in its own Web Worker
 * for probing, transcoding and decode checks, and WASM image codecs. Inputs
 * are mounted with WORKERFS (read from the Blob on demand, not copied into
 * the WASM heap); outputs are written to MEMFS, copied out and deleted.
 * Cancelling or timing out terminates the FFmpeg worker; it is recreated for
 * the next job.
 */
export class BrowserMediaEngine implements MediaEngine {
  private ff: FfmpegLike | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly log: string[] = [];
  private progressHandler: ((e: { progress: number; time: number }) => void) | undefined;
  private jobCounter = 0;
  private jobsSinceLoad = 0;
  private readonly threading: ThreadingDecision;
  private readonly codecs: ImageCodecs | undefined;
  private pool: ImagePool | undefined;
  private detectedEncoders: string[] | undefined;
  /** Images that can be processed at the same time (one per image worker). */
  readonly imageConcurrency: number;

  constructor(private readonly options: BrowserEngineOptions) {
    const env = currentEnvironment();
    this.threading = chooseThreading(options.threading ?? 'auto', env);
    this.codecs = options.codecs;
    this.imageConcurrency = this.codecs ? 1 : (options.imageWorkers ?? imageWorkerCount(env.hardwareConcurrency, env.deviceMemoryGiB));
  }

  info(): Promise<EngineInfo> {
    const wasm = typeof WebAssembly === 'object' && typeof Worker !== 'undefined';
    return Promise.resolve({
      engine: 'browser',
      versions: {
        '@ffmpeg/ffmpeg': '0.12.15',
        '@ffmpeg/core': this.threading.mode === 'multi' ? '0.12.10 (core-mt)' : '0.12.10 (single-thread)',
        ...CODEC_VERSIONS,
      },
      video: wasm
        ? { available: true, encoders: [...PINNED_CORE_ENCODERS], engineClass: 'browser', slowEncoders: ['libvpx-vp9'] }
        : { available: false, encoders: [], engineClass: 'browser', slowEncoders: [], reason: 'WebAssembly or Web Workers are not available' },
      image: {
        available: wasm,
        encoders: { jpeg: CODEC_VERSIONS['@jsquash/jpeg'], png: CODEC_VERSIONS['@jsquash/oxipng'], webp: CODEC_VERSIONS['@jsquash/webp'] },
        canResize: true,
        ...(wasm ? {} : { reason: 'WebAssembly is not available' }),
      },
      audio: wasm
        ? { available: true, encoders: [...PINNED_AUDIO_ENCODERS] }
        : { available: false, encoders: [], reason: 'WebAssembly or Web Workers are not available' },
      pdf: wasm
        ? { available: true, engine: `qpdf ${QPDF_VERSION} (WebAssembly)` }
        : { available: false, reason: 'WebAssembly or Web Workers are not available' },
      notes: [`FFmpeg core: ${this.threading.mode}-thread (${this.threading.reason})`],
    });
  }

  /** Threading decision (for display). */
  get threadingDecision(): ThreadingDecision {
    return this.threading;
  }

  /** Encoders reported by the loaded core (after a load), for capability tests. */
  get encodersFromCore(): readonly string[] | undefined {
    return this.detectedEncoders;
  }

  /** Loads FFmpeg on first use; reports engine-load progress. Jobs are serialized by run(), so loads never overlap. */
  private async ensureLoaded(): Promise<FfmpegLike> {
    if (this.ff) return this.ff;
    const onLoad = this.options.onLoad ?? (() => undefined);
    onLoad({ stage: 'engine-load', message: `Loading FFmpeg (${this.threading.mode}-thread)` });
    const ff = this.options.createFfmpeg ? this.options.createFfmpeg() : (new FFmpeg() as unknown as FfmpegLike);
    ff.on('log', (e) => {
      this.log.push(e.message);
      if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    });
    ff.on('progress', (e) => this.progressHandler?.(e));
    const assets = this.options.assets;
    const config =
      this.threading.mode === 'multi'
        ? { coreURL: assets.multi.core, wasmURL: assets.multi.wasm, workerURL: assets.multi.worker, classWorkerURL: assets.classWorker }
        : { coreURL: assets.single.core, wasmURL: assets.single.wasm, classWorkerURL: assets.classWorker };
    try {
      await ff.load(config);
      this.log.length = 0;
      const code = await ff.exec(['-hide_banner', '-encoders']);
      this.detectedEncoders = code === 0 || this.log.length > 0 ? parseEncoderList(this.log) : undefined;
    } catch (error) {
      ff.terminate();
      const message = errorMessage(error);
      this.options.onLoadError?.(message);
      throw new ElpxError('media-engine-unavailable', `FFmpeg could not be loaded: ${message}`);
    }
    this.log.length = 0;
    this.ff = ff;
    onLoad({ stage: 'engine-load', message: 'FFmpeg ready', fraction: 1 });
    return ff;
  }

  /** Terminates FFmpeg; the next job loads a fresh instance. */
  private reset(): void {
    this.ff?.terminate();
    this.ff = undefined;
    this.jobsSinceLoad = 0;
  }

  /**
   * Runs one FFmpeg job at a time with real cancellation and a time limit:
   * both terminate the FFmpeg worker, so the codec actually stops.
   */
  private run<T>(ctx: JobContext, fn: (ff: FfmpegLike, id: number) => Promise<T>): Promise<T> {
    const attempt = async (retry: boolean): Promise<T> => {
      throwIfCancelled(ctx.signal);
      // ffmpeg.wasm does not give back all memory between runs: a fresh instance every few jobs
      // keeps long sequences (hundreds of small recordings) from running out of memory.
      if (this.ff && this.jobsSinceLoad >= JOBS_PER_INSTANCE) this.reset();
      const ff = await this.ensureLoaded();
      // Cancelled while loading: keep the loaded core for the next job.
      throwIfCancelled(ctx.signal);
      const id = ++this.jobCounter;
      this.jobsSinceLoad++;
      let stopped: 'cancel' | 'timeout' | undefined;
      const stop = (why: 'cancel' | 'timeout'): void => {
        if (stopped) return;
        stopped = why;
        this.reset();
      };
      const disposeCancel = onCancel(ctx.signal, () => stop('cancel'));
      const timer = setTimeout(() => stop('timeout'), ctx.timeoutMs);
      this.log.length = 0;
      try {
        return await fn(ff, id);
      } catch (error) {
        if (stopped === 'cancel') throw new CancelledError();
        if (stopped === 'timeout') throw new ElpxError('media-failed', 'FFmpeg exceeded the time limit in the browser');
        const text = `${errorMessage(error)} ${this.log.slice(-5).join(' ')}`;
        // ffmpeg.wasm logs a bare "Aborted()" after any failure; only memory aborts mean OOM.
        if (/memory|OOM|out of bounds/i.test(text)) {
          this.reset();
          // Once more on a fresh instance: the memory may have been exhausted by earlier jobs.
          if (retry) return attempt(false);
          throw new ElpxError('media-failed', 'The browser ran out of memory for this file; the original is kept (the CLI can process larger files)');
        }
        throw error instanceof ElpxError ? error : new ElpxError('media-failed', errorMessage(error));
      } finally {
        clearTimeout(timer);
        disposeCancel();
        this.progressHandler = undefined;
      }
    };
    const task = (): Promise<T> => attempt(true);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private blobOf(resource: StoredResource): Blob {
    if (!(resource instanceof BlobResource)) throw new ElpxError('internal', 'Browser engine needs Blob resources');
    return resource.blob;
  }

  /** Mounts a Blob read-only via WORKERFS and returns its path; the caller unmounts. */
  private async mount(ff: FfmpegLike, id: number, blob: Blob, name: string): Promise<{ path: string; release: () => Promise<void> }> {
    const dir = `/in${id}`;
    await ff.createDir(dir);
    await ff.mount(FFFSType.WORKERFS, { blobs: [{ name, data: blob }] }, dir);
    return {
      path: `${dir}/${name}`,
      release: async () => {
        await ff.unmount(dir).catch(() => undefined);
        await ff.deleteDir(dir).catch(() => undefined);
      },
    };
  }

  private lastError(): string {
    const lines = this.log.filter((l) => l.trim() !== '' && !/^\s*(frame|size|time)=|^Aborted\(\)$/.test(l));
    return lines.slice(-3).join(' | ').slice(0, 300);
  }

  probe(resource: StoredResource, ctx: JobContext): Promise<ProbeResult> {
    const blob = this.blobOf(resource);
    return this.run(ctx, async (ff, id) => {
      const input = await this.mount(ff, id, blob, resource.name);
      const out = `/probe${id}.json`;
      try {
        await ff.ffprobe([...FFPROBE_ARGS, '-protocol_whitelist', 'file', input.path, '-o', out]);
        // ffprobe.wasm returns a non-zero code even on success; the JSON is authoritative.
        const json = await ff.readFile(out, 'utf8').catch(() => '');
        if (typeof json !== 'string' || json.trim() === '') throw new ElpxError('media-failed', `ffprobe failed: ${this.lastError() || 'no output'}`);
        return parseProbeJson(json);
      } finally {
        await ff.deleteFile(out).catch(() => undefined);
        await input.release();
      }
    });
  }

  transcodeVideo(resource: StoredResource, job: VideoJob, ctx: JobContext): Promise<StoredResource> {
    const blob = this.blobOf(resource);
    return this.run(ctx, async (ff, id) => {
      const input = await this.mount(ff, id, blob, resource.name);
      const ext = job.container === 'webm' ? 'webm' : job.container === 'mov' ? 'mov' : 'mp4';
      const out = `/out${id}.${ext}`;
      const total = job.expected.duration;
      this.progressHandler = (e) => {
        const seconds = e.time / 1e6;
        if (!ctx.onProgress || !(seconds >= 0)) return;
        ctx.onProgress({
          stage: 'transcode',
          resource: ctx.resourcePath,
          processedSeconds: seconds,
          totalSeconds: total,
          fraction: Math.min(0.99, seconds / total),
        });
      };
      try {
        const threads = this.threading.mode === 'multi' && this.threading.threads ? { threads: this.threading.threads } : {};
        const code = await ff.exec(buildVideoArgs(job, input.path, out, threads));
        if (code !== 0) throw new ElpxError('media-failed', `ffmpeg.wasm failed (code ${code}): ${this.lastError()}`);
        const data = await ff.readFile(out);
        if (!(data instanceof Uint8Array) || data.length === 0) throw new ElpxError('media-failed', 'ffmpeg.wasm produced no output');
        return this.options.store.adopt(new Blob([data as Uint8Array<ArrayBuffer>], { type: ext === 'webm' ? 'video/webm' : 'video/mp4' }), ext);
      } finally {
        await ff.deleteFile(out).catch(() => undefined);
        await input.release();
      }
    });
  }

  transcodeAudio(resource: StoredResource, job: AudioJob, ctx: JobContext): Promise<StoredResource> {
    const blob = this.blobOf(resource);
    return this.run(ctx, async (ff, id) => {
      const input = await this.mount(ff, id, blob, resource.name);
      const out = `/out${id}.${job.target}`;
      const total = job.expected.duration;
      this.progressHandler = (e) => {
        const seconds = e.time / 1e6;
        if (!ctx.onProgress || !(seconds >= 0)) return;
        ctx.onProgress({
          stage: 'transcode',
          resource: ctx.resourcePath,
          processedSeconds: seconds,
          ...(total ? { totalSeconds: total, fraction: Math.min(0.99, seconds / total) } : {}),
        });
      };
      try {
        const code = await ff.exec(buildAudioArgs(job, input.path, out));
        if (code !== 0) throw new ElpxError('media-failed', `ffmpeg.wasm failed (code ${code}): ${this.lastError()}`);
        const data = await ff.readFile(out);
        if (!(data instanceof Uint8Array) || data.length === 0) throw new ElpxError('media-failed', 'ffmpeg.wasm produced no output');
        return this.options.store.adopt(new Blob([data as Uint8Array<ArrayBuffer>], { type: AUDIO_MIME[job.target] }), job.target);
      } finally {
        await ff.deleteFile(out).catch(() => undefined);
        await input.release();
      }
    });
  }

  decodeCheck(resource: StoredResource, job: Pick<VideoJob, 'demuxer'>, ctx: JobContext): Promise<void> {
    const blob = this.blobOf(resource);
    return this.run(ctx, async (ff, id) => {
      const input = await this.mount(ff, id, blob, resource.name);
      try {
        const code = await ff.exec(buildDecodeCheckArgs(job, input.path));
        if (code !== 0) throw new ElpxError('media-failed', `decode check failed: ${this.lastError() || `code ${code}`}`);
      } finally {
        await input.release();
      }
    });
  }

  async playbackCheck(resource: StoredResource, mime: string, _ctx: JobContext): Promise<'playable' | 'not-playable' | 'unsupported'> {
    if (!this.options.playbackProbe) return 'unsupported';
    return this.options.playbackProbe(this.blobOf(resource), mime);
  }

  /** The image worker pool, started on first use. */
  private images(): ImagePool {
    this.pool ??= new ImagePool(this.options.createImageWorker ?? startImageWorker, this.imageConcurrency);
    return this.pool;
  }

  async encodeImage(input: Uint8Array, job: ImageJob, ctx: JobContext): Promise<Uint8Array> {
    throwIfCancelled(ctx.signal);
    if (!this.codecs) return this.images().encode(job, input, ctx);
    const out = await withTimeout(this.codecs.encode(job, input), ctx.timeoutMs);
    throwIfCancelled(ctx.signal);
    return out;
  }

  verifyImage(original: Uint8Array, candidate: Uint8Array, job: ImageJob, ctx: JobContext): Promise<ImageVerification> {
    if (!this.codecs) return this.images().verify(original, candidate, job, ctx);
    return verifyWithCodecs(this.codecs, original, candidate, job, (p) => withTimeout(p, ctx.timeoutMs));
  }

  private pdfWorker: PdfWorkerLike | undefined;
  private pdfCounter = 0;
  private readonly pdfPending = new Map<number, { resolve: (r: QpdfResult) => void; reject: (e: Error) => void }>();

  /** Stops the qpdf worker, failing its pending runs with `error`. */
  private stopPdfWorker(error: Error): void {
    this.pdfWorker?.terminate();
    this.pdfWorker = undefined;
    for (const p of this.pdfPending.values()) p.reject(error);
    this.pdfPending.clear();
  }

  /** The qpdf worker, started on first use. */
  private pdf(): PdfWorkerLike {
    if (this.pdfWorker) return this.pdfWorker;
    const worker = (this.options.createPdfWorker ?? startPdfWorker)();
    worker.onmessage = (e) => {
      const pending = this.pdfPending.get(e.data.id);
      if (!pending) return;
      this.pdfPending.delete(e.data.id);
      if (e.data.result) pending.resolve(e.data.result);
      else pending.reject(new ElpxError('media-failed', `qpdf could not run: ${e.data.error ?? 'unknown error'}`));
    };
    worker.onerror = (e) => this.stopPdfWorker(new ElpxError('media-failed', `qpdf worker failed: ${e.message ?? 'unknown error'}`));
    this.pdfWorker = worker;
    return worker;
  }

  /** Runs qpdf in its worker; a timeout or a cancellation terminates the worker (it restarts on the next run). */
  async runQpdf(args: readonly string[], input: Uint8Array, ctx: JobContext): Promise<QpdfResult> {
    throwIfCancelled(ctx.signal);
    const worker = this.pdf();
    const id = ++this.pdfCounter;
    return new Promise<QpdfResult>((resolve, reject) => {
      const timer = setTimeout(() => this.stopPdfWorker(new ElpxError('media-failed', 'qpdf exceeded the time limit in the browser')), ctx.timeoutMs);
      const disposeCancel = onCancel(ctx.signal, () => this.stopPdfWorker(new CancelledError()));
      const settle = (): void => {
        clearTimeout(timer);
        disposeCancel();
      };
      this.pdfPending.set(id, {
        resolve: (r) => {
          settle();
          resolve(r);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      });
      const copy = input.slice();
      worker.postMessage({ id, args, input: copy }, [copy.buffer]);
    });
  }

  /** Stops the image workers, releasing their memory; they are started again when needed. */
  releaseImageWorkers(): void {
    this.pool?.dispose();
    this.pool = undefined;
  }

  async dispose(): Promise<void> {
    this.reset();
    this.releaseImageWorkers();
    this.stopPdfWorker(new CancelledError());
  }
}

/** Starts the qpdf worker (emitted by Vite as its own module worker). */
function startPdfWorker(): PdfWorkerLike {
  return new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module', name: 'elpx-pdf' }) as unknown as PdfWorkerLike;
}

/** Starts one image worker (emitted by Vite as its own module worker). */
function startImageWorker(): ImageWorkerLike {
  return new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module', name: 'elpx-image' }) as unknown as ImageWorkerLike;
}

/** Rejects if the promise does not settle in time (codecs cannot be interrupted mid-call). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ElpxError('media-failed', 'image processing exceeded the time limit')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
