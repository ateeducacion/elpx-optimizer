import { stat } from 'node:fs/promises';
import type { SharpConstructor } from 'sharp';
import { cpus } from 'node:os';
import { ElpxError } from '../../core/errors.js';
import { throwIfCancelled } from '../../core/cancel.js';
import type { EngineInfo, ImageVerification, JobContext, MediaEngine, StoredResource } from '../../core/media/engine.js';
import type { ImageCapabilities, ImageJob } from '../../core/media/image-policy.js';
import { FFPROBE_ARGS, parseProbeJson, type ProbeResult } from '../../core/media/probe.js';
import { buildDecodeCheckArgs, buildVideoArgs, type VideoCapabilities, type VideoJob } from '../../core/media/video-policy.js';
import { buildAudioArgs, type AudioCapabilities, type AudioJob } from '../../core/media/audio-policy.js';
import { runProcess } from './process.js';
import { FileResource, type NodeResourceStore } from './resource-store.js';
import { listEncoders, resolveTools, toolVersion, type ToolOverrides } from './tools.js';

type Sharp = SharpConstructor;

/** Options for the native engine. */
export interface NativeEngineOptions {
  tools?: ToolOverrides;
  /** Encoder threads per FFmpeg process (default: min(4, cores - 1)). */
  threads?: number;
  /** Maximum decoded image area for sharp. */
  maxImagePixels?: number;
  /** Override for loading sharp (tests). */
  loadSharp?: () => Promise<Sharp>;
}

/** Loads sharp lazily so inspecting projects never requires it. */
async function defaultLoadSharp(): Promise<Sharp> {
  const mod = (await import('sharp')) as unknown as { default: Sharp };
  return mod.default;
}

/**
 * Native media engine: FFmpeg/ffprobe processes for video and sharp
 * (libvips with mozjpeg, libspng, libwebp) for images. Every process runs
 * with an argument vector, a private working directory, a minimal
 * environment, a timeout and process-group cancellation.
 */
export class NativeMediaEngine implements MediaEngine {
  private infoPromise: Promise<EngineInfo> | undefined;
  private sharp: Sharp | undefined;
  private ffmpeg: string | undefined;
  private ffprobe: string | undefined;

  constructor(
    private readonly store: NodeResourceStore,
    private readonly options: NativeEngineOptions = {},
  ) {}

  info(): Promise<EngineInfo> {
    this.infoPromise ??= this.detect();
    return this.infoPromise;
  }

  private async detect(): Promise<EngineInfo> {
    const notes: string[] = [];
    const versions: Record<string, string> = {};
    const tools = await resolveTools(this.options.tools);
    let video: VideoCapabilities = { available: false, encoders: [], engineClass: 'native', slowEncoders: [], reason: 'ffmpeg/ffprobe not found' };
    let audio: AudioCapabilities = { available: false, encoders: [], reason: 'ffmpeg/ffprobe not found' };
    if (tools.ffmpeg && tools.ffprobe) {
      const [fv, pv, encoders] = await Promise.all([toolVersion(tools.ffmpeg), toolVersion(tools.ffprobe), listEncoders(tools.ffmpeg)]);
      if (fv && pv) {
        this.ffmpeg = tools.ffmpeg;
        this.ffprobe = tools.ffprobe;
        versions['ffmpeg'] = fv;
        versions['ffprobe'] = pv;
        const wanted = ['libx264', 'aac', 'libvpx-vp9', 'libopus'].filter((e) => encoders.includes(e));
        video = wanted.includes('libx264')
          ? { available: true, encoders: wanted, engineClass: 'native', slowEncoders: [] }
          : { available: false, encoders: wanted, engineClass: 'native', slowEncoders: [], reason: 'ffmpeg lacks the libx264 encoder' };
        const audioEncoders = ['libmp3lame', 'aac'].filter((e) => encoders.includes(e));
        audio =
          audioEncoders.length > 0
            ? { available: true, encoders: audioEncoders }
            : { available: false, encoders: [], reason: 'ffmpeg lacks the libmp3lame and aac encoders' };
      } else {
        video = { ...video, reason: 'ffmpeg or ffprobe could not be executed' };
        audio = { ...audio, reason: 'ffmpeg or ffprobe could not be executed' };
      }
    } else {
      notes.push(`Missing: ${[!tools.ffmpeg && 'ffmpeg', !tools.ffprobe && 'ffprobe'].filter(Boolean).join(', ')}`);
    }
    let image: ImageCapabilities = { available: false, encoders: {}, canResize: false, reason: 'sharp could not be loaded' };
    try {
      const sharp = await (this.options.loadSharp ?? defaultLoadSharp)();
      this.sharp = sharp;
      const v = sharp.versions as Record<string, string | undefined>;
      versions['sharp'] = v['sharp'] ?? 'unknown';
      versions['libvips'] = v['vips'] ?? 'unknown';
      const jpegLib = v['mozjpeg'] ? `mozjpeg ${v['mozjpeg']}` : 'libjpeg';
      image = {
        available: true,
        encoders: {
          jpeg: `${jpegLib} (sharp)`,
          png: `libpng ${v['png'] ?? ''} (sharp)`.replace('  ', ' '),
          webp: `libwebp ${v['webp'] ?? ''} (sharp)`.replace('  ', ' '),
        },
        canResize: true,
      };
    } catch (error) {
      notes.push(`sharp unavailable: ${(error as Error).message.split('\n')[0]}`);
    }
    return { engine: 'native', versions, video, image, audio, notes };
  }

  /** Resolved ffmpeg path (after info()), for diagnostics and the doctor smoke test. */
  get ffmpegPath(): string | undefined {
    return this.ffmpeg;
  }

  private threads(): number {
    return this.options.threads ?? Math.max(1, Math.min(4, cpus().length - 1));
  }

  private requireVideo(): { ffmpeg: string; ffprobe: string } {
    if (!this.ffmpeg || !this.ffprobe) throw new ElpxError('media-engine-unavailable', 'ffmpeg/ffprobe are not available');
    return { ffmpeg: this.ffmpeg, ffprobe: this.ffprobe };
  }

  private file(resource: StoredResource): FileResource {
    if (!(resource instanceof FileResource)) throw new ElpxError('internal', 'Native engine needs file resources');
    return resource;
  }

  async probe(resource: StoredResource, ctx: JobContext): Promise<ProbeResult> {
    await this.info();
    const { ffprobe } = this.requireVideo();
    const file = this.file(resource);
    const result = await runProcess(ffprobe, [...FFPROBE_ARGS, '-protocol_whitelist', 'file', file.path], {
      cwd: this.store.dir,
      timeoutMs: Math.min(ctx.timeoutMs, 120_000),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (result.code !== 0) throw new ElpxError('media-failed', `ffprobe failed: ${firstLine(result.stderr)}`);
    try {
      return parseProbeJson(result.stdout);
    } catch (error) {
      throw new ElpxError('media-failed', (error as Error).message);
    }
  }

  async transcodeVideo(resource: StoredResource, job: VideoJob, ctx: JobContext): Promise<StoredResource> {
    await this.info();
    const { ffmpeg } = this.requireVideo();
    const input = this.file(resource);
    const ext = job.container === 'webm' ? 'webm' : job.container === 'mov' ? 'mov' : 'mp4';
    await this.store.ensureSpace(input.size);
    const out = this.store.newPath(ext);
    const args = buildVideoArgs(job, input.path, out.path, { threads: this.threads(), progressPipe: true });
    const total = job.expected.duration;
    const result = await runProcess(ffmpeg, args, {
      cwd: this.store.dir,
      timeoutMs: ctx.timeoutMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (!m || !ctx.onProgress) return;
        const seconds = Number(m[1]) / 1e6;
        ctx.onProgress({
          stage: 'transcode',
          resource: ctx.resourcePath,
          processedSeconds: seconds,
          totalSeconds: total,
          fraction: Math.min(0.99, seconds / total),
        });
      },
    }).catch(async (error: unknown) => {
      await this.store.adopt(out.path, out.name, 0).dispose();
      throw error;
    });
    if (result.code !== 0) {
      await this.store.adopt(out.path, out.name, 0).dispose();
      throw new ElpxError('media-failed', `ffmpeg failed: ${firstLine(result.stderr)}`);
    }
    const size = (await stat(out.path)).size;
    return this.store.adopt(out.path, out.name, size);
  }

  async transcodeAudio(resource: StoredResource, job: AudioJob, ctx: JobContext): Promise<StoredResource> {
    await this.info();
    const { ffmpeg } = this.requireVideo();
    const input = this.file(resource);
    await this.store.ensureSpace(input.size);
    const out = this.store.newPath(job.target);
    const total = job.expected.duration;
    const result = await runProcess(ffmpeg, buildAudioArgs(job, input.path, out.path, { progressPipe: true }), {
      cwd: this.store.dir,
      timeoutMs: ctx.timeoutMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (!m || !ctx.onProgress) return;
        const seconds = Number(m[1]) / 1e6;
        ctx.onProgress({
          stage: 'transcode',
          resource: ctx.resourcePath,
          processedSeconds: seconds,
          totalSeconds: total,
          fraction: Math.min(0.99, seconds / total),
        });
      },
    }).catch(async (error: unknown) => {
      await this.store.adopt(out.path, out.name, 0).dispose();
      throw error;
    });
    if (result.code !== 0) {
      await this.store.adopt(out.path, out.name, 0).dispose();
      throw new ElpxError('media-failed', `ffmpeg failed: ${firstLine(result.stderr)}`);
    }
    const size = (await stat(out.path)).size;
    return this.store.adopt(out.path, out.name, size);
  }

  async decodeCheck(resource: StoredResource, job: Pick<VideoJob, 'demuxer'>, ctx: JobContext): Promise<void> {
    await this.info();
    const { ffmpeg } = this.requireVideo();
    const file = this.file(resource);
    const result = await runProcess(ffmpeg, buildDecodeCheckArgs(job, file.path), {
      cwd: this.store.dir,
      timeoutMs: ctx.timeoutMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (result.code !== 0 || result.stderr.trim() !== '') {
      throw new ElpxError('media-failed', `decode check failed: ${firstLine(result.stderr) || `exit ${result.code}`}`);
    }
  }

  private requireSharp(): Sharp {
    if (!this.sharp) throw new ElpxError('media-engine-unavailable', 'sharp is not available');
    return this.sharp;
  }

  async encodeImage(input: Uint8Array, job: ImageJob, ctx: JobContext): Promise<Uint8Array> {
    await this.info();
    throwIfCancelled(ctx.signal);
    const sharp = this.requireSharp();
    let img = sharp(input, {
      failOn: 'error',
      animated: false,
      limitInputPixels: this.options.maxImagePixels ?? 100_000_000,
    }).keepIccProfile();
    if (job.resize) img = img.resize(job.resize.width, job.resize.height, { fit: 'fill', kernel: 'lanczos3' });
    if (job.format === 'jpeg') img = img.jpeg({ quality: job.quality ?? 82, mozjpeg: true });
    else if (job.format === 'png') img = img.png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: false });
    else img = job.mode === 'lossless' ? img.webp({ lossless: true, effort: 6, exact: true }) : img.webp({ quality: job.quality ?? 82, effort: 6 });
    const out = await withTimeout(img.toBuffer(), ctx.timeoutMs, 'image encoding');
    throwIfCancelled(ctx.signal);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }

  async verifyImage(original: Uint8Array, candidate: Uint8Array, job: ImageJob, ctx: JobContext): Promise<ImageVerification> {
    await this.info();
    const sharp = this.requireSharp();
    const problems: string[] = [];
    const decode = (bytes: Uint8Array) => sharp(bytes, { failOn: 'error', limitInputPixels: this.options.maxImagePixels ?? 100_000_000 }).keepIccProfile();
    let meta;
    try {
      meta = await withTimeout(decode(candidate).metadata(), ctx.timeoutMs, 'image verification');
      await withTimeout(decode(candidate).raw().toBuffer(), ctx.timeoutMs, 'image verification');
    } catch (error) {
      return { ok: false, width: 0, height: 0, hasAlpha: false, problems: [`candidate cannot be decoded: ${(error as Error).message}`] };
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const hasAlpha = meta.hasAlpha === true;
    if (width !== job.expected.width || height !== job.expected.height) {
      problems.push(`size ${width}x${height} instead of ${job.expected.width}x${job.expected.height}`);
    }
    if (job.expected.hasAlpha && !hasAlpha) problems.push('transparency was lost');
    let identicalPixels: boolean | undefined;
    if (job.mode === 'lossless' && !job.resize) {
      const a = await decode(original).ensureAlpha().raw().toBuffer();
      const b = await decode(candidate).ensureAlpha().raw().toBuffer();
      identicalPixels = a.equals(b);
      if (!identicalPixels) problems.push('lossless re-encoding changed pixel values');
    }
    return { ok: problems.length === 0, width, height, hasAlpha, ...(identicalPixels !== undefined ? { identicalPixels } : {}), problems };
  }

  async dispose(): Promise<void> {
    // Processes are per job; nothing persistent to release.
  }
}

/** First non-empty line of tool output, trimmed for messages. */
function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300);
}

/** Rejects when a promise does not settle within the timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ElpxError('media-failed', `${what} exceeded the time limit`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
