import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type SharpConstructor } from 'sharp';
import { NativeMediaEngine } from '../../../src/adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../../src/adapters/node/resource-store.js';
import { CancelledError, ElpxError } from '../../../src/core/errors.js';
import type { StoredResource } from '../../../src/core/media/engine.js';
import type { ImageJob } from '../../../src/core/media/image-policy.js';
import type { VideoJob } from '../../../src/core/media/video-policy.js';
import { FAKE_FFMPEG_IDENTITY, removeDir, tempDir, writeScript } from '../../helpers/cli.js';

let dir: string;
let store: NodeResourceStore;
let input: StoredResource;

const ctx = { resourcePath: 'content/resources/clip.mp4', timeoutMs: 30_000 };

const videoJob = (container: VideoJob['container'] = 'mp4'): VideoJob => ({
  container,
  demuxer: container === 'webm' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2',
  videoIndex: 0,
  videoCodec: container === 'webm' ? 'vp9' : 'h264',
  encoder: container === 'webm' ? 'libvpx-vp9' : 'libx264',
  crf: 23,
  x264Preset: 'veryfast',
  scale: undefined,
  expected: { width: 64, height: 64, duration: 2, frameRate: 10, audio: [], subtitleIndexes: [], chapters: 0 },
  conversions: [],
  droppedStreams: [],
});

const imageJob = (over: Partial<ImageJob> = {}): ImageJob => ({
  format: 'png',
  mode: 'lossless',
  quality: undefined,
  resize: undefined,
  metadata: { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true },
  expected: { width: 8, height: 8, hasAlpha: true },
  conversions: [],
  ...over,
});

/** Writes a fake tool: identity answers plus a custom body for real work. */
function fakeTool(name: string, body: string): Promise<string> {
  return writeScript(join(dir, name), `${FAKE_FFMPEG_IDENTITY}\n${body}`);
}

/** A sharp stand-in whose pipeline ends in the given toBuffer (metadata reports no dimensions). */
function fakeSharp(toBuffer: () => Promise<unknown>, versions: Record<string, string> = {}): SharpConstructor {
  const chain: Record<string, unknown> = {};
  for (const m of ['keepIccProfile', 'resize', 'jpeg', 'png', 'webp', 'raw', 'ensureAlpha']) chain[m] = () => chain;
  chain['toBuffer'] = toBuffer;
  chain['metadata'] = async () => ({ format: 'png' });
  return Object.assign(() => chain, { versions }) as unknown as SharpConstructor;
}

/** RGBA test image as PNG bytes. */
async function png(width: number, height: number, color: { r: number; g: number; b: number; alpha: number }): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 4, background: color } })
      .png()
      .toBuffer(),
  );
}

/** Error thrown by a promise. */
async function failure(promise: Promise<unknown>): Promise<ElpxError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ElpxError);
  return error as ElpxError;
}

beforeAll(async () => {
  dir = await tempDir('elpx-engine-');
  store = await NodeResourceStore.create({ tempRoot: dir });
  input = await store.fromBytes(new TextEncoder().encode('not really a video'), 'mp4');
});
afterAll(async () => {
  await store.disposeAll();
  await removeDir(dir);
});

describe('NativeMediaEngine detection', () => {
  it('reports missing tools and refuses video work', async () => {
    const engine = new NativeMediaEngine(store, { tools: { ffmpeg: join(dir, 'none-ffmpeg'), ffprobe: join(dir, 'none-ffprobe') } });
    const info = await engine.info();
    expect(await engine.info()).toBe(info);
    expect(info.engine).toBe('native');
    expect(info.video).toMatchObject({ available: false, reason: 'ffmpeg/ffprobe not found' });
    expect(info.notes).toContain('Missing: ffmpeg, ffprobe');
    expect(engine.ffmpegPath).toBeUndefined();
    expect((await failure(engine.probe(input, ctx))).code).toBe('media-engine-unavailable');
    expect((await failure(engine.transcodeVideo(input, videoJob(), ctx))).code).toBe('media-engine-unavailable');
    expect((await failure(engine.decodeCheck(input, videoJob(), ctx))).code).toBe('media-engine-unavailable');
    await engine.dispose();
  });

  it('names only the missing tool', async () => {
    const ffmpeg = await fakeTool('only-ffmpeg', 'exit 0');
    const info = await new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: join(dir, 'none') } }).info();
    expect(info.notes).toContain('Missing: ffprobe');
  });

  it('reports tools that are found but cannot be executed', async () => {
    const broken = await writeScript(join(dir, 'broken-tool'), 'exit 1');
    const info = await new NativeMediaEngine(store, { tools: { ffmpeg: broken, ffprobe: broken } }).info();
    expect(info.video).toMatchObject({ available: false, reason: 'ffmpeg or ffprobe could not be executed' });
  });

  it('requires the libx264 encoder', async () => {
    const noX264 = await writeScript(
      join(dir, 'no-x264'),
      `case "$*" in *-encoders*) printf ' A....D aac   AAC\\n V....D libvpx-vp9  VP9\\n'; exit 0;; esac\necho "ffmpeg version 1.0"`,
    );
    const info = await new NativeMediaEngine(store, { tools: { ffmpeg: noX264, ffprobe: noX264 } }).info();
    expect(info.video).toMatchObject({ available: false, encoders: ['aac', 'libvpx-vp9'], reason: 'ffmpeg lacks the libx264 encoder' });
  });

  it('reports a sharp that cannot be loaded and refuses image work', async () => {
    const engine = new NativeMediaEngine(store, {
      tools: { ffmpeg: join(dir, 'none') },
      loadSharp: () => Promise.reject(new Error('Could not load the "sharp" module\nmore details')),
    });
    const info = await engine.info();
    expect(info.image).toMatchObject({ available: false, reason: 'sharp could not be loaded' });
    expect(info.notes).toContain('sharp unavailable: Could not load the "sharp" module');
    expect((await failure(engine.encodeImage(new Uint8Array(4), imageJob(), ctx))).code).toBe('media-engine-unavailable');
    expect((await failure(engine.verifyImage(new Uint8Array(4), new Uint8Array(4), imageJob(), ctx))).code).toBe('media-engine-unavailable');
  });

  it('describes a sharp build without version details', async () => {
    const engine = new NativeMediaEngine(store, { tools: { ffmpeg: join(dir, 'none') }, loadSharp: async () => fakeSharp(async () => Buffer.alloc(0)) });
    const info = await engine.info();
    expect(info.versions).toMatchObject({ sharp: 'unknown', libvips: 'unknown' });
    expect(info.image.encoders).toEqual({ jpeg: 'libjpeg (sharp)', png: 'libpng (sharp)', webp: 'libwebp (sharp)' });
  });

  it('describes the real sharp build', async () => {
    const info = await new NativeMediaEngine(store, { tools: { ffmpeg: join(dir, 'none') } }).info();
    expect(info.image.available).toBe(true);
    expect(info.versions['sharp']).toBeTruthy();
    expect(info.image.encoders.jpeg).toMatch(/\(sharp\)$/);
  });
});

describe('NativeMediaEngine video jobs', () => {
  it('rejects resources that are not files', async () => {
    const ffmpeg = await fakeTool('ok-ffmpeg', 'exit 0');
    const engine = new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } });
    const memory = { name: 'x.mp4', size: 1, open: () => Promise.reject(new Error('unused')), dispose: () => Promise.resolve() } as StoredResource;
    const error = await failure(engine.probe(memory, ctx));
    expect(error.code).toBe('internal');
    expect(error.message).toBe('Native engine needs file resources');
    expect(engine.ffmpegPath).toBe(ffmpeg);
  });

  it('reports ffprobe failures and unparsable output', async () => {
    const failing = await fakeTool('probe-fails', 'echo "" >&2; echo "  Invalid data found when processing input" >&2; exit 1');
    const error = await failure(new NativeMediaEngine(store, { tools: { ffmpeg: failing, ffprobe: failing } }).probe(input, ctx));
    expect(error.code).toBe('media-failed');
    expect(error.message).toBe('ffprobe failed: Invalid data found when processing input');
    const garbage = await fakeTool('probe-garbage', 'echo "this is not json"');
    const parse = await failure(new NativeMediaEngine(store, { tools: { ffmpeg: garbage, ffprobe: garbage } }).probe(input, ctx));
    expect(parse.code).toBe('media-failed');
  });

  it('reports encoder progress from -progress output and adopts the result', async () => {
    const ffmpeg = await fakeTool(
      'progress-ffmpeg',
      'for last; do :; done\necho "frame=10"\necho "out_time_us=500000"\necho "out_time_ms=4000000"\necho "progress=end"\nprintf "encoded" > "$last"',
    );
    const engine = new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg }, threads: 2 });
    const events: { seconds?: number; fraction?: number; resource?: string }[] = [];
    const out = await engine.transcodeVideo(input, videoJob('mov'), {
      ...ctx,
      onProgress: (e) => events.push({ seconds: e.processedSeconds, fraction: e.fraction, resource: e.resource }),
    });
    expect(out.name).toMatch(/\.mov$/);
    expect(out.size).toBe(7);
    expect(events).toEqual([
      { seconds: 0.5, fraction: 0.25, resource: ctx.resourcePath },
      { seconds: 4, fraction: 0.99, resource: ctx.resourcePath },
    ]);
    const webm = await new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } }).transcodeVideo(input, videoJob('webm'), ctx);
    expect(webm.name).toMatch(/\.webm$/);
    await out.dispose();
    await webm.dispose();
  });

  it('removes the partial output when ffmpeg fails', async () => {
    const ffmpeg = await fakeTool('fail-ffmpeg', 'for last; do :; done\nprintf "junk" > "$last"\necho "Conversion failed!" >&2\nexit 1');
    const before = await readdir(store.dir);
    const error = await failure(new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } }).transcodeVideo(input, videoJob(), ctx));
    expect(error.code).toBe('media-failed');
    expect(error.message).toBe('ffmpeg failed: Conversion failed!');
    expect(await readdir(store.dir)).toEqual(before);
  });

  it('removes the partial output when the encode is cancelled', async () => {
    const pidFile = join(dir, 'ffmpeg.pid');
    const ffmpeg = await fakeTool(
      'slow-ffmpeg',
      `for last; do :; done\nprintf "partial" > "$last"\necho $$ > "${pidFile}"\necho "out_time_us=100000"\nexec sleep 30`,
    );
    const before = await readdir(store.dir);
    const controller = new AbortController();
    const pending = new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } }).transcodeVideo(input, videoJob(), {
      ...ctx,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(await readdir(store.dir)).toEqual(before);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('fails the decode check on errors or any stderr output', async () => {
    const warns = await fakeTool('warn-ffmpeg', 'echo "[h264] corrupt frame" >&2; exit 0');
    const warning = await failure(new NativeMediaEngine(store, { tools: { ffmpeg: warns, ffprobe: warns } }).decodeCheck(input, videoJob(), ctx));
    expect(warning.message).toBe('decode check failed: [h264] corrupt frame');
    const exits = await fakeTool('exit-ffmpeg', 'exit 2');
    const exit = await failure(new NativeMediaEngine(store, { tools: { ffmpeg: exits, ffprobe: exits } }).decodeCheck(input, videoJob(), ctx));
    expect(exit.message).toBe('decode check failed: exit 2');
    const clean = await fakeTool('clean-ffmpeg', 'exit 0');
    await new NativeMediaEngine(store, { tools: { ffmpeg: clean, ffprobe: clean } }).decodeCheck(input, videoJob(), {
      ...ctx,
      signal: new AbortController().signal,
    });
  });
});

describe('NativeMediaEngine image jobs', () => {
  const none = (): { ffmpeg: string } => ({ ffmpeg: join(dir, 'none') });

  it('encodes every format and verifies lossless results pixel by pixel', async () => {
    const engine = new NativeMediaEngine(store, { tools: none(), maxImagePixels: 1_000_000 });
    const original = await png(8, 8, { r: 200, g: 10, b: 10, alpha: 0.5 });
    const lossless = await engine.encodeImage(original, imageJob(), ctx);
    expect(await engine.verifyImage(original, lossless, imageJob(), ctx)).toEqual({
      ok: true,
      width: 8,
      height: 8,
      hasAlpha: true,
      identicalPixels: true,
      problems: [],
    });
    const webp = await engine.encodeImage(original, imageJob({ format: 'webp' }), ctx);
    expect((await sharp(webp).metadata()).format).toBe('webp');
    const lossyWebp = await engine.encodeImage(original, imageJob({ format: 'webp', mode: 'lossy', quality: 60 }), ctx);
    expect((await sharp(lossyWebp).metadata()).format).toBe('webp');
    const defaultWebp = await engine.encodeImage(original, imageJob({ format: 'webp', mode: 'lossy' }), ctx);
    expect(defaultWebp.length).toBeGreaterThan(0);
  });

  it('resizes JPEGs and reports size and transparency problems', async () => {
    const engine = new NativeMediaEngine(store, { tools: none() });
    const original = await png(16, 16, { r: 0, g: 128, b: 255, alpha: 0.5 });
    const jpeg = await engine.encodeImage(original, imageJob({ format: 'jpeg', mode: 'lossy', quality: 70, resize: { width: 8, height: 4 } }), ctx);
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 8, 4]);
    const defaultQuality = await engine.encodeImage(original, imageJob({ format: 'jpeg', mode: 'lossy' }), ctx);
    expect((await sharp(defaultQuality).metadata()).format).toBe('jpeg');
    const verdict = await engine.verifyImage(
      original,
      jpeg,
      imageJob({ format: 'jpeg', mode: 'lossy', expected: { width: 16, height: 16, hasAlpha: true } }),
      ctx,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(['size 8x4 instead of 16x16', 'transparency was lost']);
    expect(verdict.identicalPixels).toBeUndefined();
  });

  it('detects lossless results with different pixels and undecodable candidates', async () => {
    const engine = new NativeMediaEngine(store, { tools: none() });
    const a = await png(8, 8, { r: 1, g: 2, b: 3, alpha: 1 });
    const b = await png(8, 8, { r: 4, g: 5, b: 6, alpha: 1 });
    const changed = await engine.verifyImage(a, b, imageJob({ expected: { width: 8, height: 8, hasAlpha: false } }), ctx);
    expect(changed).toMatchObject({ ok: false, identicalPixels: false, problems: ['lossless re-encoding changed pixel values'] });
    const broken = await engine.verifyImage(a, new TextEncoder().encode('garbage'), imageJob(), ctx);
    expect(broken.ok).toBe(false);
    expect(broken.problems[0]).toMatch(/^candidate cannot be decoded: /);
  });

  it('treats missing dimensions in the candidate metadata as 0x0', async () => {
    const engine = new NativeMediaEngine(store, { tools: none(), loadSharp: async () => fakeSharp(async () => Buffer.alloc(4)) });
    const verdict = await engine.verifyImage(
      new Uint8Array(4),
      new Uint8Array(4),
      imageJob({ mode: 'lossy', expected: { width: 8, height: 8, hasAlpha: false } }),
      ctx,
    );
    expect(verdict).toEqual({ ok: false, width: 0, height: 0, hasAlpha: false, problems: ['size 0x0 instead of 8x8'] });
  });

  it('honours cancellation before and after encoding', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new NativeMediaEngine(store, { tools: none() });
    await expect(engine.encodeImage(await png(4, 4, { r: 0, g: 0, b: 0, alpha: 1 }), imageJob(), { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
    const late = new AbortController();
    const slow = new NativeMediaEngine(store, {
      tools: none(),
      loadSharp: async () =>
        fakeSharp(async () => {
          late.abort();
          return Buffer.from('x');
        }),
    });
    await expect(slow.encodeImage(new Uint8Array(4), imageJob(), { ...ctx, signal: late.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it('enforces the time limit and normalizes non-Error rejections', async () => {
    const hung = new NativeMediaEngine(store, { tools: none(), loadSharp: async () => fakeSharp(() => new Promise(() => undefined)) });
    const timeout = await failure(hung.encodeImage(new Uint8Array(4), imageJob(), { ...ctx, timeoutMs: 20 }));
    expect(timeout.message).toBe('image encoding exceeded the time limit');
    const odd = new NativeMediaEngine(store, { tools: none(), loadSharp: async () => fakeSharp(() => Promise.reject('plain string')) });
    await expect(odd.encodeImage(new Uint8Array(4), imageJob(), ctx)).rejects.toThrow('plain string');
    const typed = new NativeMediaEngine(store, { tools: none(), loadSharp: async () => fakeSharp(() => Promise.reject(new TypeError('bad input'))) });
    await expect(typed.encodeImage(new Uint8Array(4), imageJob(), ctx)).rejects.toThrow(TypeError);
  });
});
