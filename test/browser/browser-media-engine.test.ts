import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FFmpeg, type FFFSType } from '@ffmpeg/ffmpeg';
import videoUrl from '../fixtures/media/inefficient.mp4?url';
import truncatedUrl from '../fixtures/media/truncated.mp4?url';
import toneWavUrl from '../fixtures/media/tone.wav?url';
import tone320Url from '../fixtures/media/tone-320.mp3?url';
import audioOnlyUrl from '../fixtures/media/audio-only.m4a?url';
import toneOpusUrl from '../fixtures/media/tone-opus.webm?url';
import recordingUrl from '../fixtures/media/recording-opus.webm?url';
import { BlobResource, BlobStore } from '../../src/adapters/browser/blob-io.js';
import { BrowserMediaEngine, JOBS_PER_INSTANCE, type BrowserEngineOptions, type FfmpegLike } from '../../src/adapters/browser/browser-media-engine.js';
import { FFMPEG_ASSETS } from '../../src/adapters/browser/ffmpeg-assets.js';
import { PINNED_AUDIO_ENCODERS, PINNED_CORE_ENCODERS, type FfmpegAssets } from '../../src/adapters/browser/ffmpeg-loader.js';
import type { ImageCodecs } from '../../src/adapters/browser/image-codecs.js';
import { imageWorkerCount, type ImageRequest, type ImageResponse, type ImageWorkerLike } from '../../src/adapters/browser/image-pool.js';
import { decideAudio, validateAudioCandidate, type AudioJob } from '../../src/core/media/audio-policy.js';
import { CancelledError } from '../../src/core/errors.js';
import { BROWSER_LIMITS } from '../../src/core/limits.js';
import type { ProgressEvent, StoredResource } from '../../src/core/media/engine.js';
import type { ImageJob } from '../../src/core/media/image-policy.js';
import { decideVideo, validateVideoCandidate, type VideoJob } from '../../src/core/media/video-policy.js';
import { normalizeOptions, type OptionsInput } from '../../src/core/plan/options.js';
import { delay, fixtureBytes } from './helpers.js';

const ctx = { resourcePath: 'content/resources/media/clase.mp4', timeoutMs: 120_000 };

/** Plans the re-encoding of a probed video exactly as the core would. */
async function planVideo(engine: BrowserMediaEngine, resource: StoredResource, video: NonNullable<OptionsInput['video']>): Promise<VideoJob> {
  const probe = await engine.probe(resource, ctx);
  const decision = decideVideo({ format: 'mp4', size: resource.size, probe }, normalizeOptions({ video }).video, (await engine.info()).video, BROWSER_LIMITS);
  if (decision.action !== 'transcode') throw new Error(`not transcodable: ${decision.detail}`);
  return decision.job;
}

/** Real FFmpeg instances that count their terminations. */
function countingFactory(): { create: () => FfmpegLike; terminated: () => number } {
  let terminated = 0;
  return {
    create: () => {
      const ff = new FFmpeg();
      const terminate = ff.terminate;
      ff.terminate = () => {
        terminated++;
        terminate();
      };
      return ff as unknown as FfmpegLike;
    },
    terminated: () => terminated,
  };
}

describe('BrowserMediaEngine with the real ffmpeg.wasm', () => {
  let blob: Blob;

  beforeAll(async () => {
    blob = new Blob([(await fixtureBytes(videoUrl)) as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
  });

  it('loads the pinned core, detects its encoders and probes (the JSON is authoritative)', async () => {
    const loads: ProgressEvent[] = [];
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single', onLoad: (e) => loads.push(e) });
    expect(engine.threadingDecision).toEqual({ mode: 'single', reason: 'single-thread core selected' });
    expect(engine.encodersFromCore).toBeUndefined();
    const probe = await engine.probe(store.adopt(blob, 'mp4'), ctx);
    expect(probe.streams.map((s) => `${s.type}:${s.codec}`)).toEqual(['video:h264', 'audio:aac']);
    expect(probe.streams[0]).toMatchObject({ width: 640, height: 360 });
    expect(probe.duration).toBeCloseTo(4, 1);
    expect(loads).toEqual([
      { stage: 'engine-load', message: 'Loading FFmpeg (single-thread)' },
      { stage: 'engine-load', message: 'FFmpeg ready', fraction: 1 },
    ]);
    const encoders = engine.encodersFromCore!;
    expect(encoders).toEqual(expect.arrayContaining([...PINNED_CORE_ENCODERS]));
    expect(encoders).not.toContain('=');
    const info = await engine.info();
    expect(info.video).toEqual({ available: true, encoders: [...PINNED_CORE_ENCODERS], engineClass: 'browser', slowEncoders: ['libvpx-vp9'] });
    expect(info.versions['@ffmpeg/core']).toBe('0.12.10 (single-thread)');
    expect(info.notes[0]).toMatch(/^FFmpeg core: single-thread/);
    await engine.dispose();
  });

  it('transcodes a real video with a planned job, reporting progress, and the candidate validates and decodes', async () => {
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single' });
    const input = store.adopt(blob, 'mp4');
    const job = await planVideo(engine, input, { x264Preset: 'ultrafast' });
    expect(job).toMatchObject({ container: 'mp4', encoder: 'libx264', x264Preset: 'ultrafast', expected: { width: 640, height: 360 } });
    const events: ProgressEvent[] = [];
    const candidate = await engine.transcodeVideo(input, job, { ...ctx, onProgress: (e) => events.push(e) });
    expect(candidate).toBeInstanceOf(BlobResource);
    expect((candidate as BlobResource).blob.type).toBe('video/mp4');
    expect(candidate.name).toMatch(/^r\d+\.mp4$/);
    expect(candidate.size).toBeGreaterThan(0);
    expect(candidate.size).toBeLessThan(blob.size);
    const seconds = events.map((e) => e.processedSeconds!);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ stage: 'transcode', resource: ctx.resourcePath, totalSeconds: job.expected.duration });
    expect(Math.max(...seconds)).toBeGreaterThan(0);
    expect(Math.max(...events.map((e) => e.fraction!))).toBeLessThanOrEqual(0.99);
    const check = validateVideoCandidate(job, await engine.probe(candidate, ctx));
    expect(check).toEqual({ ok: true, problems: [] });
    await engine.decodeCheck(candidate, job, ctx);
    await engine.dispose();
  });

  it.each([
    // [format, fixture, forced, MIME type, output name]
    ['wav', toneWavUrl, true, 'audio/mpeg', /\.mp3$/],
    ['mp3', tone320Url, true, 'audio/mpeg', /\.mp3$/],
    ['m4a', audioOnlyUrl, true, 'audio/mp4', /\.m4a$/],
  ] as const)('re-encodes %s audio with a planned job, reporting progress, and the candidate validates', async (format, url, force, type, name) => {
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single' });
    const input = store.adopt(new Blob([(await fixtureBytes(url)) as Uint8Array<ArrayBuffer>]), format);
    const probe = await engine.probe(input, ctx);
    const info = await engine.info();
    expect(info.audio).toEqual({ available: true, encoders: [...PINNED_AUDIO_ENCODERS] });
    // The pinned audio encoders are really in the core.
    expect(engine.encodersFromCore).toEqual(expect.arrayContaining([...PINNED_AUDIO_ENCODERS]));
    const decision = decideAudio({ format, size: input.size, probe }, normalizeOptions({ audio: { force } }).audio, info.audio!, BROWSER_LIMITS);
    expect(decision.action, JSON.stringify(decision)).toBe('transcode');
    const job = (decision as { job: AudioJob }).job;
    expect(job.expected.duration).toBeGreaterThan(0);
    const events: ProgressEvent[] = [];
    const candidate = await engine.transcodeAudio(input, job, { ...ctx, onProgress: (e) => events.push(e) });
    expect(candidate).toBeInstanceOf(BlobResource);
    expect((candidate as BlobResource).blob.type).toBe(type);
    expect(candidate.name).toMatch(name);
    expect(candidate.size).toBeGreaterThan(0);
    expect(candidate.size).toBeLessThan(input.size);
    expect(validateAudioCandidate(job, await engine.probe(candidate, ctx))).toEqual({ ok: true, problems: [] });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ stage: 'transcode', resource: ctx.resourcePath, totalSeconds: job.expected.duration });
    expect(Math.max(...events.map((e) => e.fraction!))).toBeLessThanOrEqual(0.99);
    await engine.dispose();
  });

  // Known problem, reported: the pinned core's libopus crashes ("memory access out of bounds") when it
  // encodes stereo at -compression_level 5 or more (FFmpeg's default is 10); levels 0-4 and mono work.
  // Remove `.fails` once the audio arguments cap the level for libopus.
  it.fails('re-encodes stereo Opus in WebM (217 kb/s, re-encoded without forcing)', async () => {
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single' });
    const input = store.adopt(new Blob([(await fixtureBytes(toneOpusUrl)) as Uint8Array<ArrayBuffer>]), 'webm');
    const probe = await engine.probe(input, ctx);
    const decision = decideAudio({ format: 'webm', size: input.size, probe }, normalizeOptions({}).audio, (await engine.info()).audio!, BROWSER_LIMITS);
    expect(decision).toMatchObject({ action: 'transcode', job: { target: 'webm', encoder: 'libopus', channels: 2 } });
    const job = (decision as { job: AudioJob }).job;
    try {
      const candidate = await engine.transcodeAudio(input, job, ctx);
      expect((candidate as BlobResource).blob.type).toBe('audio/webm');
      expect(candidate.size).toBeLessThan(input.size);
      expect(validateAudioCandidate(job, await engine.probe(candidate, ctx))).toEqual({ ok: true, problems: [] });
    } finally {
      await engine.dispose();
    }
  });

  it('re-encodes a browser recording without a duration in its header', async () => {
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single' });
    const input = store.adopt(new Blob([(await fixtureBytes(recordingUrl)) as Uint8Array<ArrayBuffer>]), 'webm');
    const probe = await engine.probe(input, ctx);
    expect(probe.duration).toBeUndefined();
    const decision = decideAudio({ format: 'webm', size: input.size, probe }, normalizeOptions({}).audio, (await engine.info()).audio!, BROWSER_LIMITS);
    expect(decision).toMatchObject({ action: 'transcode', job: { target: 'webm', encoder: 'libopus', channels: 1, expected: {} } });
    const job = (decision as { job: AudioJob }).job;
    const events: ProgressEvent[] = [];
    const candidate = await engine.transcodeAudio(input, job, { ...ctx, onProgress: (e) => events.push(e) });
    expect((candidate as BlobResource).blob.type).toBe('audio/webm');
    expect(candidate.size).toBeLessThan(input.size);
    // The new file has a duration (about 3 s) and validates.
    const out = await engine.probe(candidate, ctx);
    expect(out.duration).toBeCloseTo(3, 0);
    expect(validateAudioCandidate(job, out)).toEqual({ ok: true, problems: [] });
    // Progress reports the time only: there is no total to compare with.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e).toMatchObject({ stage: 'transcode', resource: ctx.resourcePath });
      expect(e.totalSeconds).toBeUndefined();
      expect(e.fraction).toBeUndefined();
    }
    await engine.dispose();
  });

  it('rejects a truncated video in the decode check', async () => {
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single' });
    const job = await planVideo(engine, store.adopt(blob, 'mp4'), { x264Preset: 'ultrafast' });
    const truncated = store.adopt(new Blob([(await fixtureBytes(truncatedUrl)) as Uint8Array<ArrayBuffer>]), 'mp4');
    const failure = engine.decodeCheck(truncated, job, ctx);
    // A corrupt file is a decode failure (not memory exhaustion), without the trailing "Aborted()" noise.
    await expect(failure).rejects.toMatchObject({ code: 'media-failed', message: expect.stringMatching(/^decode check failed: .*partial file/) });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringMatching(/memory|Aborted/) });
    // FFmpeg is still usable afterwards.
    expect((await engine.probe(store.adopt(blob, 'mp4'), ctx)).streams).toHaveLength(2);
    await engine.dispose();
  });

  it('cancels a running transcode by terminating FFmpeg, and the next job reloads it', async () => {
    const counting = countingFactory();
    const loads: ProgressEvent[] = [];
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single', createFfmpeg: counting.create, onLoad: (e) => loads.push(e) });
    const input = store.adopt(blob, 'mp4');
    const job = await planVideo(engine, input, { x264Preset: 'veryslow', maxResolution: 'original' });
    const controller = new AbortController();
    let abortedAt = 0;
    const running = engine.transcodeVideo(input, job, {
      ...ctx,
      signal: controller.signal,
      onProgress: (e) => {
        if (!abortedAt && e.processedSeconds! > 0) {
          abortedAt = performance.now();
          controller.abort();
        }
      },
    });
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(abortedAt).toBeGreaterThan(0);
    // The codec stops at once: terminating the worker does not wait for the encoder.
    expect(performance.now() - abortedAt).toBeLessThan(2000);
    expect(counting.terminated()).toBe(1);
    const readyBefore = loads.filter((e) => e.fraction === 1).length;
    const after = await engine.probe(input, ctx);
    expect(after.streams).toHaveLength(2);
    expect(loads.filter((e) => e.fraction === 1).length).toBe(readyBefore + 1);
    await engine.dispose();
    expect(counting.terminated()).toBe(2);
  });

  it('reports a core that cannot be downloaded, and loads it on the next job', async () => {
    let attempts = 0;
    const missing = new URL('/__missing__/ffmpeg-core.wasm', location.href).href;
    const assets: FfmpegAssets = {
      ...FFMPEG_ASSETS,
      single: {
        core: FFMPEG_ASSETS.single.core,
        get wasm() {
          return attempts++ === 0 ? missing : FFMPEG_ASSETS.single.wasm;
        },
      },
    };
    const errors: string[] = [];
    const loads: ProgressEvent[] = [];
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets, threading: 'single', onLoad: (e) => loads.push(e), onLoadError: (m) => errors.push(m) });
    await expect(engine.probe(store.adopt(blob, 'mp4'), ctx)).rejects.toMatchObject({
      code: 'media-engine-unavailable',
      message: expect.stringMatching(/^FFmpeg could not be loaded: .*CompileError/),
    });
    expect(errors).toEqual([expect.stringMatching(/CompileError/)]);
    expect(loads.map((e) => e.message)).toEqual(['Loading FFmpeg (single-thread)']);
    // The failure is not cached.
    expect((await engine.probe(store.adopt(blob, 'mp4'), ctx)).streams).toHaveLength(2);
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    expect(loads.map((e) => e.message)).toEqual(['Loading FFmpeg (single-thread)', 'Loading FFmpeg (single-thread)', 'FFmpeg ready']);
    await engine.dispose();
  });

  it('stops a job that exceeds its time limit, and recovers', async () => {
    const counting = countingFactory();
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single', createFfmpeg: counting.create });
    const input = store.adopt(blob, 'mp4');
    const job = await planVideo(engine, input, { x264Preset: 'ultrafast' });
    await expect(engine.transcodeVideo(input, job, { ...ctx, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'media-failed',
      message: 'FFmpeg exceeded the time limit in the browser',
    });
    expect(counting.terminated()).toBe(1);
    expect((await engine.probe(input, ctx)).streams).toHaveLength(2);
    await engine.dispose();
  });
});

type Behaviour = Partial<{
  load: () => Promise<unknown>;
  exec: (args: string[], ff: FakeFfmpeg) => Promise<number>;
  ffprobe: (args: string[], ff: FakeFfmpeg) => Promise<number>;
  readFile: (path: string, encoding?: string) => Promise<Uint8Array | string>;
  fsFails: boolean;
}>;

/**
 * Scriptable stand-in for @ffmpeg/ffmpeg: records calls, emits logs and
 * progress on demand and, like the real class, rejects pending calls when
 * terminated.
 */
class FakeFfmpeg implements FfmpegLike {
  readonly calls: string[][] = [];
  loadConfig: unknown;
  terminated = false;
  private logCb: ((e: { type: string; message: string }) => void) | undefined;
  private progressCb: ((e: { progress: number; time: number }) => void) | undefined;
  private readonly rejects = new Set<(e: Error) => void>();

  constructor(private readonly behaviour: Behaviour = {}) {}

  /** Emits FFmpeg log lines. */
  log(...lines: string[]): void {
    for (const message of lines) this.logCb?.({ type: 'stderr', message });
  }

  /** Emits a progress event (time in microseconds). */
  progress(time: number): void {
    this.progressCb?.({ progress: 0, time });
  }

  /** A call that only ends when the instance is terminated. */
  hang(): Promise<number> {
    return new Promise((_, reject) => this.rejects.add(reject));
  }

  load(config: unknown): Promise<unknown> {
    this.loadConfig = config;
    return this.behaviour.load ? this.behaviour.load() : Promise.resolve(true);
  }

  exec(args: string[]): Promise<number> {
    this.calls.push(args);
    if (args.includes('-encoders')) {
      this.log(' V....D libx264              libx264 H.264', ' A....D aac                  AAC');
      return Promise.resolve(0);
    }
    return this.behaviour.exec ? this.behaviour.exec(args, this) : Promise.resolve(0);
  }

  ffprobe(args: string[]): Promise<number> {
    this.calls.push(['ffprobe', ...args]);
    return this.behaviour.ffprobe ? this.behaviour.ffprobe(args, this) : Promise.resolve(1);
  }

  readFile(path: string, encoding?: string): Promise<Uint8Array | string> {
    if (this.behaviour.readFile) return this.behaviour.readFile(path, encoding);
    return Promise.resolve(
      encoding === 'utf8'
        ? JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 2, height: 2 }], format: { duration: '1' } })
        : new Uint8Array([1, 2, 3]),
    );
  }

  private fs(name: string): Promise<unknown> {
    this.calls.push([name]);
    return this.behaviour.fsFails ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve(true);
  }

  deleteFile(): Promise<unknown> {
    return this.fs('deleteFile');
  }

  createDir(): Promise<unknown> {
    return Promise.resolve(true);
  }

  deleteDir(): Promise<unknown> {
    return this.fs('deleteDir');
  }

  mount(_type: FFFSType, options: { blobs?: { name: string; data: Blob }[] }, mountPoint: string): Promise<unknown> {
    this.calls.push(['mount', mountPoint, ...(options.blobs ?? []).map((b) => b.name)]);
    return Promise.resolve(true);
  }

  unmount(): Promise<unknown> {
    return this.fs('unmount');
  }

  on(event: 'log' | 'progress', cb: (e: never) => void): void {
    if (event === 'log') this.logCb = cb as (e: { type: string; message: string }) => void;
    else this.progressCb = cb as (e: { progress: number; time: number }) => void;
  }

  terminate(): void {
    this.terminated = true;
    for (const reject of this.rejects) reject(new Error('called FFmpeg.terminate()'));
    this.rejects.clear();
  }
}

const JOB: VideoJob = {
  container: 'mp4',
  demuxer: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoIndex: 0,
  videoCodec: 'h264',
  encoder: 'libx264',
  crf: 23,
  x264Preset: 'veryfast',
  scale: undefined,
  expected: { width: 2, height: 2, duration: 4, frameRate: 25, audio: [], subtitleIndexes: [], chapters: 0 },
  conversions: [],
  droppedStreams: [],
};

const AUDIO_JOB: AudioJob = {
  demuxer: 'wav',
  audioIndex: 0,
  sourceFormat: 'wav',
  target: 'mp3',
  encoder: 'libmp3lame',
  codec: 'mp3',
  bitrateKbps: 128,
  channels: 2,
  sampleRate: 44_100,
  rename: true,
  expected: { duration: 4 },
  conversions: ['WAV (pcm_s16le) converted to MP3 at 128 kb/s (lossy); the file is renamed to .mp3'],
};

describe('BrowserMediaEngine error handling (injected FFmpeg)', () => {
  const store = new BlobStore();
  const resource = (): BlobResource => store.adopt(new Blob(['video']), 'mp4');

  /** Engine over fakes created with the given behaviour; returns every instance created. */
  function fakeEngine(behaviour: Behaviour = {}, extra: Partial<BrowserEngineOptions> = {}): { engine: BrowserMediaEngine; instances: FakeFfmpeg[] } {
    const instances: FakeFfmpeg[] = [];
    const engine = new BrowserMediaEngine({
      store,
      assets: FFMPEG_ASSETS,
      threading: 'single',
      codecs: { decode: () => Promise.reject(new Error('unused')), encode: () => Promise.reject(new Error('unused')) },
      createFfmpeg: () => {
        const ff = new FakeFfmpeg(behaviour);
        instances.push(ff);
        return ff;
      },
      ...extra,
    });
    return { engine, instances };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a failed load to media-engine-unavailable and retries on the next job', async () => {
    let attempt = 0;
    const { engine, instances } = fakeEngine({ load: () => (attempt++ === 0 ? Promise.reject(new Error('404 core')) : Promise.resolve(true)) });
    await expect(engine.probe(resource(), ctx)).rejects.toMatchObject({ code: 'media-engine-unavailable', message: 'FFmpeg could not be loaded: 404 core' });
    expect(instances[0]!.terminated).toBe(true);
    expect(engine.encodersFromCore).toBeUndefined();
    await expect(engine.probe(resource(), ctx)).resolves.toMatchObject({ streams: [{ codec: 'h264' }] });
    expect(instances).toHaveLength(2);
    expect(engine.encodersFromCore).toEqual(['libx264', 'aac']);
    expect(instances[1]!.loadConfig).toEqual({
      coreURL: FFMPEG_ASSETS.single.core,
      wasmURL: FFMPEG_ASSETS.single.wasm,
      classWorkerURL: FFMPEG_ASSETS.classWorker,
    });
  });

  it('treats a core that loads but cannot run as unavailable, and reports it', async () => {
    const instances: FakeFfmpeg[] = [];
    const errors: string[] = [];
    const engine = new BrowserMediaEngine({
      store,
      assets: FFMPEG_ASSETS,
      threading: 'single',
      onLoadError: (m) => errors.push(m),
      createFfmpeg: () => {
        const ff = new FakeFfmpeg();
        if (instances.length === 0) ff.exec = () => Promise.reject(new Error('worker died'));
        instances.push(ff);
        return ff;
      },
    });
    await expect(engine.probe(resource(), ctx)).rejects.toMatchObject({ code: 'media-engine-unavailable', message: 'FFmpeg could not be loaded: worker died' });
    expect(errors).toEqual(['worker died']);
    expect(instances[0]!.terminated).toBe(true);
    await engine.probe(resource(), ctx);
    expect(instances).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it('leaves the encoder list unknown when the core prints nothing', async () => {
    const instances: FakeFfmpeg[] = [];
    const engine = new BrowserMediaEngine({
      store,
      assets: FFMPEG_ASSETS,
      threading: 'single',
      createFfmpeg: () => {
        const ff = new FakeFfmpeg();
        ff.exec = () => Promise.resolve(1);
        instances.push(ff);
        return ff;
      },
    });
    await engine.probe(resource(), ctx);
    expect(engine.encodersFromCore).toBeUndefined();
  });

  it('parses the encoder list even when `-encoders` exits non-zero', async () => {
    const engine = new BrowserMediaEngine({
      store,
      assets: FFMPEG_ASSETS,
      threading: 'single',
      createFfmpeg: () => {
        const ff = new FakeFfmpeg();
        ff.exec = () => {
          ff.log(' A....D libopus              libopus Opus');
          return Promise.resolve(1);
        };
        return ff;
      },
    });
    await engine.probe(resource(), ctx);
    expect(engine.encodersFromCore).toEqual(['libopus']);
  });

  it('uses the multi-thread core when the page is cross-origin isolated', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('SharedArrayBuffer', ArrayBuffer);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
    const { engine, instances } = fakeEngine({}, { threading: 'auto' });
    vi.unstubAllGlobals();
    expect(engine.threadingDecision).toMatchObject({ mode: 'multi', threads: 4 });
    expect((await engine.info()).versions['@ffmpeg/core']).toBe('0.12.10 (core-mt)');
    await engine.transcodeVideo(resource(), JOB, ctx);
    expect(instances[0]!.loadConfig).toEqual({
      coreURL: FFMPEG_ASSETS.multi.core,
      wasmURL: FFMPEG_ASSETS.multi.wasm,
      workerURL: FFMPEG_ASSETS.multi.worker,
      classWorkerURL: FFMPEG_ASSETS.classWorker,
    });
    const args = instances[0]!.calls.find((c) => c.includes('-c:v'))!;
    expect(args[args.indexOf('-threads') + 1]).toBe('4');
  });

  it('defaults to automatic threading (single-thread without isolation)', async () => {
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, codecs: { decode: vi.fn(), encode: vi.fn() } });
    expect(engine.threadingDecision.mode).toBe(crossOriginIsolated ? 'multi' : 'single');
  });

  it('reports video and images as unavailable without WebAssembly or workers', async () => {
    const { engine } = fakeEngine();
    vi.stubGlobal('Worker', undefined);
    const info = await engine.info();
    expect(info.video).toEqual({
      available: false,
      encoders: [],
      engineClass: 'browser',
      slowEncoders: [],
      reason: 'WebAssembly or Web Workers are not available',
    });
    expect(info.image).toMatchObject({ available: false, reason: 'WebAssembly is not available' });
  });

  it('mounts inputs read-only, cleans up even when cleanup fails, and keeps the log bounded', async () => {
    const { engine, instances } = fakeEngine({
      fsFails: true,
      exec: (_args, ff) => {
        ff.log(...Array.from({ length: 450 }, (_, i) => `line ${i}`));
        return Promise.resolve(0);
      },
    });
    const r = resource();
    const out = await engine.transcodeVideo(r, JOB, ctx);
    expect(out.size).toBe(3);
    const ff = instances[0]!;
    expect(ff.calls).toContainEqual(['mount', '/in1', r.name]);
    expect(ff.calls.filter((c) => c.length === 1).map((c) => c[0])).toEqual(['deleteFile', 'unmount', 'deleteDir']);
    await engine.probe(r, ctx);
    expect(ff.calls.filter((c) => c.length === 1).map((c) => c[0])).toEqual(['deleteFile', 'unmount', 'deleteDir', 'deleteFile', 'unmount', 'deleteDir']);
    // The retained log is capped: the next failure only quotes recent lines.
    await expect(
      fakeEngine({ exec: (_a, f) => (f.log(...Array.from({ length: 450 }, (_, i) => `l${i}`)), Promise.resolve(2)) }).engine.transcodeVideo(r, JOB, ctx),
    ).rejects.toMatchObject({ message: 'ffmpeg.wasm failed (code 2): l447 | l448 | l449' });
  });

  it('reports transcode progress only for valid times and when requested', async () => {
    const events: ProgressEvent[] = [];
    const { engine } = fakeEngine({
      exec: (_args, ff) => {
        ff.progress(-9_223_372_036_854); // ffmpeg.wasm emits negative times before the first frame
        ff.progress(Number.NaN);
        ff.progress(2_000_000);
        ff.progress(8_000_000);
        return Promise.resolve(0);
      },
    });
    await engine.transcodeVideo(resource(), JOB, { ...ctx, onProgress: (e) => events.push(e) });
    expect(events).toEqual([
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 2, totalSeconds: 4, fraction: 0.5 },
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 8, totalSeconds: 4, fraction: 0.99 },
    ]);
    // Without a listener, progress is ignored.
    await engine.transcodeVideo(resource(), JOB, ctx);
  });

  it('names WebM and MOV outputs by container', async () => {
    const { engine, instances } = fakeEngine();
    const webm = await engine.transcodeVideo(
      resource(),
      { ...JOB, container: 'webm', demuxer: 'matroska,webm', encoder: 'libvpx-vp9', videoCodec: 'vp9' },
      ctx,
    );
    expect((webm as BlobResource).blob.type).toBe('video/webm');
    expect(webm.name).toMatch(/\.webm$/);
    const mov = await engine.transcodeVideo(resource(), { ...JOB, container: 'mov' }, ctx);
    expect((mov as BlobResource).blob.type).toBe('video/mp4');
    expect(mov.name).toMatch(/\.mov$/);
    const outputs = instances[0]!.calls.filter((c) => c.includes('-y')).map((c) => c[c.length - 1]);
    expect(outputs).toEqual(['/out1.webm', '/out2.mov']);
    // Single-thread core: no -threads argument.
    expect(instances[0]!.calls.some((c) => c.includes('-threads'))).toBe(false);
  });

  it('fails a transcode that exits non-zero, quoting the meaningful log lines', async () => {
    const { engine } = fakeEngine({
      exec: (_args, ff) => {
        ff.log('frame=  10 fps=0.0 q=0.0 size=0kB', '', '[h264] invalid NAL', 'Conversion failed!');
        return Promise.resolve(1);
      },
    });
    await expect(engine.transcodeVideo(resource(), JOB, ctx)).rejects.toMatchObject({
      code: 'media-failed',
      message: 'ffmpeg.wasm failed (code 1): [h264] invalid NAL | Conversion failed!',
    });
  });

  it('fails when the transcode produces no output', async () => {
    const empty = fakeEngine({ readFile: () => Promise.resolve(new Uint8Array(0)) }).engine;
    await expect(empty.transcodeVideo(resource(), JOB, ctx)).rejects.toMatchObject({ code: 'media-failed', message: 'ffmpeg.wasm produced no output' });
    const text = fakeEngine({ readFile: () => Promise.resolve('not bytes') }).engine;
    await expect(text.transcodeVideo(resource(), JOB, ctx)).rejects.toMatchObject({ message: 'ffmpeg.wasm produced no output' });
  });

  it('fails a probe without JSON output', async () => {
    const missing = fakeEngine({ readFile: () => Promise.reject(new Error('ENOENT')) }).engine;
    await expect(missing.probe(resource(), ctx)).rejects.toMatchObject({ code: 'media-failed', message: 'ffprobe failed: no output' });
    const logged = fakeEngine({
      ffprobe: (_args, ff) => {
        ff.log('Invalid data found when processing input');
        return Promise.resolve(1);
      },
      readFile: () => Promise.resolve('  '),
    }).engine;
    await expect(logged.probe(resource(), ctx)).rejects.toMatchObject({ message: 'ffprobe failed: Invalid data found when processing input' });
    const binary = fakeEngine({ readFile: () => Promise.resolve(new Uint8Array([1])) }).engine;
    await expect(binary.probe(resource(), ctx)).rejects.toMatchObject({ message: 'ffprobe failed: no output' });
  });

  it('restricts ffprobe to local files and writes JSON to a private path', async () => {
    const { engine, instances } = fakeEngine();
    const r = resource();
    await engine.probe(r, ctx);
    const args = instances[0]!.calls.find((c) => c[0] === 'ffprobe')!;
    expect(args.slice(-5)).toEqual(['-protocol_whitelist', 'file', `/in1/${r.name}`, '-o', '/probe1.json']);
  });

  it('fails a decode check that exits non-zero', async () => {
    const { engine } = fakeEngine({ exec: () => Promise.resolve(69) });
    await expect(engine.decodeCheck(resource(), JOB, ctx)).rejects.toMatchObject({ code: 'media-failed', message: 'decode check failed: code 69' });
  });

  it('retries once on a fresh FFmpeg after a memory abort, then gives up with a clear message', async () => {
    const { engine, instances } = fakeEngine({ exec: () => Promise.reject(new Error('RuntimeError: Aborted(OOM)')) });
    await expect(engine.transcodeVideo(resource(), JOB, ctx)).rejects.toMatchObject({
      code: 'media-failed',
      message: 'The browser ran out of memory for this file; the original is kept (the CLI can process larger files)',
    });
    // Two attempts, each on its own instance, and both instances released.
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.terminated)).toEqual([true, true]);
    expect(instances.map((i) => i.calls.filter((c) => c.includes('-c:v')).length)).toEqual([1, 1]);
    // Memory errors reported only in the log are recognized too.
    const logged = fakeEngine({
      exec: (_args, ff) => {
        ff.log('Cannot enlarge memory arrays');
        return Promise.reject(new Error('exit'));
      },
    });
    await expect(logged.engine.decodeCheck(resource(), JOB, ctx)).rejects.toMatchObject({ message: expect.stringMatching(/ran out of memory/) });
    expect(logged.instances).toHaveLength(2);
    await expect(engine.transcodeAudio(resource(), AUDIO_JOB, ctx)).rejects.toMatchObject({ message: expect.stringMatching(/ran out of memory/) });
    expect(instances).toHaveLength(4);
  });

  it('completes the job when the retry on a fresh FFmpeg works', async () => {
    let runs = 0;
    const { engine, instances } = fakeEngine({
      exec: () => (runs++ === 0 ? Promise.reject(new Error('RuntimeError: memory access out of bounds')) : Promise.resolve(0)),
    });
    const out = await engine.transcodeAudio(resource(), AUDIO_JOB, ctx);
    expect(out.size).toBe(3);
    expect(runs).toBe(2);
    expect(instances.map((i) => i.terminated)).toEqual([true, false]);
    // Other failures are not retried.
    const other = fakeEngine({ exec: () => Promise.resolve(1) });
    await expect(other.engine.transcodeAudio(resource(), AUDIO_JOB, ctx)).rejects.toMatchObject({ message: /^ffmpeg\.wasm failed \(code 1\)/ });
    expect(other.instances).toHaveLength(1);
    expect(other.instances[0]!.calls.filter((c) => c.includes('-c:a'))).toHaveLength(1);
  });

  it(`loads a fresh FFmpeg every ${JOBS_PER_INSTANCE} jobs, counting again after any reload`, async () => {
    expect(JOBS_PER_INSTANCE).toBe(60);
    let runs = 0;
    const { engine, instances } = fakeEngine({
      // The 30th run of the second instance hits a memory abort (retried on a third instance).
      exec: () => (++runs === 30 ? Promise.reject(new Error('Aborted(OOM)')) : Promise.resolve(0)),
    });
    for (let i = 0; i < JOBS_PER_INSTANCE; i++) await engine.probe(resource(), ctx);
    expect(instances).toHaveLength(1);
    // Job 61 runs on a new instance; the previous one is released.
    await engine.transcodeAudio(resource(), AUDIO_JOB, ctx);
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.terminated)).toEqual([true, false]);
    for (let i = 1; i < 29; i++) await engine.transcodeAudio(resource(), AUDIO_JOB, ctx);
    expect(instances).toHaveLength(2);
    // The memory abort reloads (third instance) and restarts the count there.
    await engine.transcodeAudio(resource(), AUDIO_JOB, ctx);
    expect(instances).toHaveLength(3);
    for (let i = 1; i < JOBS_PER_INSTANCE; i++) await engine.transcodeAudio(resource(), AUDIO_JOB, ctx);
    expect(instances).toHaveLength(3);
    await engine.probe(resource(), ctx);
    expect(instances).toHaveLength(4);
    expect(instances.map((i) => i.terminated)).toEqual([true, true, true, false]);
  });

  it('does not mistake the "Aborted()" that ends every failed run for memory exhaustion', async () => {
    const { engine, instances } = fakeEngine({
      exec: (_args, ff) => {
        ff.log('Invalid data found when processing input', 'Aborted()');
        return Promise.resolve(1);
      },
    });
    await expect(engine.decodeCheck(resource(), JOB, ctx)).rejects.toMatchObject({
      code: 'media-failed',
      message: 'decode check failed: Invalid data found when processing input',
    });
    expect(instances[0]!.terminated).toBe(false);
  });

  it('wraps unexpected errors as media-failed', async () => {
    const { engine, instances } = fakeEngine({ exec: () => Promise.reject(new Error('worker crashed')) });
    await expect(engine.decodeCheck(resource(), JOB, ctx)).rejects.toMatchObject({ code: 'media-failed', message: 'worker crashed' });
    const odd = fakeEngine({ exec: () => Promise.reject('bare string' as unknown as Error) }).engine;
    await expect(odd.decodeCheck(resource(), JOB, ctx)).rejects.toMatchObject({ code: 'media-failed', message: 'bare string' });
    // A generic failure keeps the loaded instance.
    expect(instances[0]!.terminated).toBe(false);
  });

  it('cancels a hanging job by terminating FFmpeg, and honours an already-cancelled signal', async () => {
    const { engine, instances } = fakeEngine({ exec: (_args, ff) => ff.hang() });
    const controller = new AbortController();
    const job = engine.transcodeVideo(resource(), JOB, { ...ctx, signal: controller.signal });
    await delay(20);
    controller.abort();
    await expect(job).rejects.toBeInstanceOf(CancelledError);
    expect(instances[0]!.terminated).toBe(true);
    // Already cancelled: nothing is loaded or run.
    await expect(engine.probe(resource(), { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(instances).toHaveLength(1);
  });

  it('keeps the loaded core when a job is cancelled while FFmpeg loads', async () => {
    const controller = new AbortController();
    const { engine, instances } = fakeEngine({
      load: async () => {
        controller.abort();
        return true;
      },
    });
    await expect(engine.probe(resource(), { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(instances[0]!.terminated).toBe(false);
    await engine.probe(resource(), ctx);
    expect(instances).toHaveLength(1);
  });

  it('times out a hanging job; a later cancellation does not change the outcome', async () => {
    let ff!: FakeFfmpeg;
    const controller = new AbortController();
    const { engine } = fakeEngine({
      exec: (_args, f) => {
        ff = f;
        // Terminating takes a while here, so the abort arrives after the timeout fired.
        const terminate = f.terminate.bind(f);
        f.terminate = () => {
          f.terminated = true;
          setTimeout(() => {
            controller.abort();
            setTimeout(terminate, 10);
          }, 10);
        };
        return f.hang();
      },
    });
    await expect(engine.transcodeVideo(resource(), JOB, { ...ctx, timeoutMs: 5, signal: controller.signal })).rejects.toMatchObject({
      code: 'media-failed',
      message: 'FFmpeg exceeded the time limit in the browser',
    });
    expect(ff.terminated).toBe(true);
  });

  it('runs one FFmpeg job at a time', async () => {
    const order: string[] = [];
    const { engine } = fakeEngine({
      exec: async (args) => {
        const name = args.includes('-xerror') ? 'decode' : 'transcode';
        order.push(`start ${name}`);
        await delay(20);
        order.push(`end ${name}`);
        return name === 'decode' ? 1 : 0;
      },
    });
    const a = engine.transcodeVideo(resource(), JOB, ctx);
    const b = engine.decodeCheck(resource(), JOB, ctx);
    const c = engine.transcodeVideo(resource(), JOB, ctx);
    await a;
    await expect(b).rejects.toMatchObject({ code: 'media-failed' });
    await c;
    expect(order).toEqual(['start transcode', 'end transcode', 'start decode', 'end decode', 'start transcode', 'end transcode']);
  });

  it('names audio outputs by target and reports valid progress only', async () => {
    const events: ProgressEvent[] = [];
    const { engine, instances } = fakeEngine({
      exec: (_args, ff) => {
        ff.progress(-9_223_372_036_854);
        ff.progress(Number.NaN);
        ff.progress(1_000_000);
        ff.progress(9_000_000);
        return Promise.resolve(0);
      },
    });
    const mp3 = await engine.transcodeAudio(resource(), AUDIO_JOB, { ...ctx, onProgress: (e) => events.push(e) });
    expect((mp3 as BlobResource).blob.type).toBe('audio/mpeg');
    expect(mp3.name).toMatch(/\.mp3$/);
    expect(events).toEqual([
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 1, totalSeconds: 4, fraction: 0.25 },
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 9, totalSeconds: 4, fraction: 0.99 },
    ]);
    // Without a listener, progress is ignored.
    const m4a = await engine.transcodeAudio(resource(), { ...AUDIO_JOB, target: 'm4a', encoder: 'aac', codec: 'aac' }, ctx);
    expect((m4a as BlobResource).blob.type).toBe('audio/mp4');
    const opus = { ...AUDIO_JOB, encoder: 'libopus', codec: 'opus', channels: 1, sampleRate: 48_000 } as const;
    expect(((await engine.transcodeAudio(resource(), { ...opus, target: 'webm' }, ctx)) as BlobResource).blob.type).toBe('audio/webm');
    expect(((await engine.transcodeAudio(resource(), { ...opus, target: 'ogg' }, ctx)) as BlobResource).blob.type).toBe('audio/ogg');
    const outputs = instances[0]!.calls.filter((c) => c.includes('-y')).map((c) => c[c.length - 1]);
    expect(outputs).toEqual(['/out1.mp3', '/out2.m4a', '/out3.webm', '/out4.ogg']);
    expect(events).toHaveLength(2);
    // Without a known duration, progress reports the time only.
    const unknown: ProgressEvent[] = [];
    await engine.transcodeAudio(resource(), { ...AUDIO_JOB, expected: { duration: 0 } }, { ...ctx, onProgress: (e) => unknown.push(e) });
    expect(unknown).toEqual([
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 1 },
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 9 },
    ]);
  });

  it('fails an audio transcode that exits non-zero or produces nothing', async () => {
    const failing = fakeEngine({
      exec: (_args, ff) => {
        ff.log('[wav] invalid data', 'Conversion failed!');
        return Promise.resolve(1);
      },
    }).engine;
    await expect(failing.transcodeAudio(resource(), AUDIO_JOB, ctx)).rejects.toMatchObject({
      code: 'media-failed',
      message: 'ffmpeg.wasm failed (code 1): [wav] invalid data | Conversion failed!',
    });
    const empty = fakeEngine({ readFile: () => Promise.resolve(new Uint8Array(0)) }).engine;
    await expect(empty.transcodeAudio(resource(), AUDIO_JOB, ctx)).rejects.toMatchObject({ code: 'media-failed', message: 'ffmpeg.wasm produced no output' });
    // The output is deleted and the input released even when cleanup fails.
    const { engine, instances } = fakeEngine({ fsFails: true });
    await engine.transcodeAudio(resource(), AUDIO_JOB, ctx);
    expect(instances[0]!.calls.filter((c) => c.length === 1).map((c) => c[0])).toEqual(['deleteFile', 'unmount', 'deleteDir']);
  });

  it('needs Blob-backed resources', () => {
    const { engine } = fakeEngine();
    const foreign: StoredResource = { size: 1, name: 'x.mp4', open: vi.fn(), dispose: vi.fn() };
    expect(() => engine.probe(foreign, ctx)).toThrow(/needs Blob resources/);
    expect(() => engine.transcodeVideo(foreign, JOB, ctx)).toThrow(/needs Blob resources/);
    expect(() => engine.transcodeAudio(foreign, AUDIO_JOB, ctx)).toThrow(/needs Blob resources/);
    expect(() => engine.decodeCheck(foreign, JOB, ctx)).toThrow(/needs Blob resources/);
  });

  it('delegates playback checks to the page, or reports them unsupported', async () => {
    const { engine } = fakeEngine();
    const r = resource();
    expect(await engine.playbackCheck(r, 'video/mp4', ctx)).toBe('unsupported');
    const probe = vi.fn(() => Promise.resolve('playable' as const));
    const withProbe = fakeEngine({}, { playbackProbe: probe }).engine;
    expect(await withProbe.playbackCheck(r, 'video/webm', ctx)).toBe('playable');
    expect(probe).toHaveBeenCalledWith(r.blob, 'video/webm');
  });

  it('terminates FFmpeg on dispose (and tolerates disposing twice)', async () => {
    const { engine, instances } = fakeEngine();
    await engine.dispose();
    await engine.probe(resource(), ctx);
    await engine.dispose();
    await engine.dispose();
    expect(instances[0]!.terminated).toBe(true);
  });
});

describe('BrowserMediaEngine image jobs (injected codecs)', () => {
  const job: ImageJob = {
    format: 'png',
    mode: 'lossless',
    quality: undefined,
    resize: undefined,
    metadata: { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true },
    expected: { width: 1, height: 1, hasAlpha: false },
    conversions: [],
  };
  const pixel = { data: new Uint8ClampedArray([1, 2, 3, 255]), width: 1, height: 1 };

  /** Engine whose codecs are the given functions. */
  function engineWith(codecs: ImageCodecs): BrowserMediaEngine {
    return new BrowserMediaEngine({ store: new BlobStore(), assets: FFMPEG_ASSETS, threading: 'single', codecs });
  }

  it('checks cancellation before and after encoding', async () => {
    const controller = new AbortController();
    const encode = vi.fn(async () => {
      controller.abort();
      return new Uint8Array([9]);
    });
    const engine = engineWith({ decode: vi.fn(), encode });
    await expect(engine.encodeImage(new Uint8Array([1]), job, { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(encode).toHaveBeenCalledTimes(1);
    await expect(engine.encodeImage(new Uint8Array([1]), job, { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(encode).toHaveBeenCalledTimes(1);
    await expect(engine.encodeImage(new Uint8Array([1]), job, ctx)).resolves.toEqual(new Uint8Array([9]));
  });

  it('gives up on codecs that exceed the time limit', async () => {
    const engine = engineWith({ decode: () => new Promise(() => undefined), encode: () => new Promise(() => undefined) });
    await expect(engine.encodeImage(new Uint8Array([1]), job, { ...ctx, timeoutMs: 5 })).rejects.toMatchObject({
      code: 'media-failed',
      message: 'image processing exceeded the time limit',
    });
    const v = await engine.verifyImage(new Uint8Array([1]), new Uint8Array([1]), job, { ...ctx, timeoutMs: 5 });
    expect(v).toMatchObject({ ok: false, problems: ['candidate cannot be decoded: image processing exceeded the time limit'] });
  });

  it('normalizes codec failures that are not Error objects', async () => {
    const engine = engineWith({ decode: () => Promise.reject('corrupt' as unknown as Error), encode: () => Promise.reject(42 as unknown as Error) });
    await expect(engine.encodeImage(new Uint8Array([1]), job, ctx)).rejects.toThrow('42');
    expect((await engine.verifyImage(new Uint8Array([1]), new Uint8Array([1]), job, ctx)).problems).toEqual(['candidate cannot be decoded: corrupt']);
  });

  it('compares pixels for lossless jobs and skips the alpha check for opaque expectations', async () => {
    const engine = engineWith({ decode: () => Promise.resolve(pixel), encode: vi.fn() });
    expect(await engine.verifyImage(new Uint8Array([1]), new Uint8Array([2]), job, ctx)).toEqual({
      ok: true,
      width: 1,
      height: 1,
      hasAlpha: false,
      identicalPixels: true,
      problems: [],
    });
    const lossy: ImageJob = { ...job, format: 'jpeg', mode: 'lossy', quality: 80 };
    expect(await engine.verifyImage(new Uint8Array([1]), new Uint8Array([2]), lossy, ctx)).toEqual({
      ok: true,
      width: 1,
      height: 1,
      hasAlpha: false,
      problems: [],
    });
  });
});

describe('BrowserMediaEngine image worker pool', () => {
  const job: ImageJob = {
    format: 'jpeg',
    mode: 'lossy',
    quality: 80,
    resize: undefined,
    metadata: { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true },
    expected: { width: 1, height: 1, hasAlpha: false },
    conversions: [],
  };

  /** Image worker double that answers every request at once. */
  class EchoWorker implements ImageWorkerLike {
    readonly requests: ImageRequest[] = [];
    terminated = false;
    onmessage: ((e: { data: ImageResponse }) => void) | null = null;
    onerror: ((e: { message?: string }) => void) | null = null;

    postMessage(message: ImageRequest): void {
      this.requests.push(message);
      const data: ImageResponse =
        message.kind === 'encode'
          ? { ok: true, kind: 'encode', encoded: message.original.map((b) => b + 1) }
          : { ok: true, kind: 'verify', verification: { ok: true, width: 1, height: 1, hasAlpha: false, problems: [] } };
      queueMicrotask(() => this.onmessage?.({ data }));
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  /** Engine whose image workers are EchoWorkers. */
  function poolEngine(imageWorkers?: number): { engine: BrowserMediaEngine; workers: EchoWorker[] } {
    const workers: EchoWorker[] = [];
    const engine = new BrowserMediaEngine({
      store: new BlobStore(),
      assets: FFMPEG_ASSETS,
      threading: 'single',
      ...(imageWorkers ? { imageWorkers } : {}),
      createImageWorker: () => {
        const w = new EchoWorker();
        workers.push(w);
        return w;
      },
    });
    return { engine, workers };
  }

  it('sizes the pool from the device, or as configured; in-process codecs run one image at a time', () => {
    expect(poolEngine().engine.imageConcurrency).toBe(imageWorkerCount(navigator.hardwareConcurrency));
    expect(poolEngine(3).engine.imageConcurrency).toBe(3);
    const inProcess = new BrowserMediaEngine({ store: new BlobStore(), assets: FFMPEG_ASSETS, codecs: { decode: vi.fn(), encode: vi.fn() }, imageWorkers: 3 });
    expect(inProcess.imageConcurrency).toBe(1);
  });

  it('sends encode and verify jobs to the image workers', async () => {
    const { engine, workers } = poolEngine(2);
    const input = new Uint8Array([1, 2]);
    const [a, b] = await Promise.all([engine.encodeImage(input, job, ctx), engine.encodeImage(input, job, ctx)]);
    expect(a).toEqual(new Uint8Array([2, 3]));
    expect(b).toEqual(new Uint8Array([2, 3]));
    expect(workers).toHaveLength(2);
    expect(await engine.verifyImage(input, a, job, ctx)).toMatchObject({ ok: true });
    expect(workers.flatMap((w) => w.requests.map((r) => r.kind)).sort()).toEqual(['encode', 'encode', 'verify']);
  });

  it('does not start a worker for an already-cancelled job', async () => {
    const { engine, workers } = poolEngine(2);
    const controller = new AbortController();
    controller.abort();
    await expect(engine.encodeImage(new Uint8Array([1]), job, { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    await expect(engine.verifyImage(new Uint8Array([1]), new Uint8Array([1]), job, { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(workers).toHaveLength(0);
  });

  it('releases the image workers on request and on dispose', async () => {
    const { engine, workers } = poolEngine(2);
    await engine.encodeImage(new Uint8Array([1]), job, ctx);
    engine.releaseImageWorkers();
    expect(workers[0]!.terminated).toBe(true);
    engine.releaseImageWorkers();
    await engine.encodeImage(new Uint8Array([1]), job, ctx);
    expect(workers).toHaveLength(2);
    await engine.dispose();
    expect(workers[1]!.terminated).toBe(true);
  });
});
