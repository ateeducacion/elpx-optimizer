import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeMediaEngine } from '../../../src/adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../../src/adapters/node/resource-store.js';
import { CancelledError, ElpxError } from '../../../src/core/errors.js';
import type { StoredResource } from '../../../src/core/media/engine.js';
import type { AudioJob } from '../../../src/core/media/audio-policy.js';
import { FAKE_FFMPEG_IDENTITY, removeDir, tempDir, writeScript } from '../../helpers/cli.js';

/** Audio support of the native engine, with scripted ffmpeg stand-ins (real ffmpeg runs in test/integration). */

let dir: string;
let store: NodeResourceStore;
let input: StoredResource;

const ctx = { resourcePath: 'content/resources/voz.wav', timeoutMs: 30_000 };

const job = (target: AudioJob['target'] = 'mp3'): AudioJob => ({
  demuxer: 'wav',
  audioIndex: 0,
  sourceFormat: 'wav',
  target,
  encoder: target === 'mp3' ? 'libmp3lame' : 'aac',
  codec: target === 'mp3' ? 'mp3' : 'aac',
  bitrateKbps: 128,
  channels: 2,
  sampleRate: 44100,
  rename: target === 'mp3',
  expected: { duration: 4 },
  conversions: [],
});

/** Writes a fake tool: identity answers plus a custom body for real work. */
function fakeTool(name: string, body: string): Promise<string> {
  return writeScript(join(dir, name), `${FAKE_FFMPEG_IDENTITY}\n${body}`);
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
  dir = await tempDir('elpx-audio-engine-');
  store = await NodeResourceStore.create({ tempRoot: dir });
  input = await store.fromBytes(new TextEncoder().encode('RIFF....WAVE not really audio'), 'wav');
});
afterAll(async () => {
  await store.disposeAll();
  await removeDir(dir);
});

describe('NativeMediaEngine audio detection', () => {
  it('lists the audio encoders ffmpeg has', async () => {
    const ffmpeg = await fakeTool('aac-only', 'exit 0');
    const info = await new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } }).info();
    expect(info.audio).toEqual({ available: true, encoders: ['aac'] });
    const both = await writeScript(
      join(dir, 'lame-aac'),
      `case "$*" in *-encoders*) printf ' V....D libx264  H.264\\n A....D libmp3lame  MP3\\n A....D aac  AAC\\n'; exit 0;; esac\necho "ffmpeg version 1.0"`,
    );
    expect((await new NativeMediaEngine(store, { tools: { ffmpeg: both, ffprobe: both } }).info()).audio).toMatchObject({
      available: true,
      encoders: expect.arrayContaining(['libmp3lame', 'aac']),
    });
  });

  it('reports ffmpeg builds without audio encoders, broken tools and missing tools', async () => {
    const videoOnly = await writeScript(
      join(dir, 'video-only'),
      `case "$*" in *-encoders*) printf ' V....D libx264  H.264\\n'; exit 0;; esac\necho "ffmpeg version 1.0"`,
    );
    const info = await new NativeMediaEngine(store, { tools: { ffmpeg: videoOnly, ffprobe: videoOnly } }).info();
    expect(info.video.available).toBe(true);
    expect(info.audio).toMatchObject({ available: false, encoders: [] });
    expect(info.audio?.reason).toMatch(/^ffmpeg lacks the libmp3lame and aac encoders/);
    const broken = await writeScript(join(dir, 'broken'), 'exit 1');
    expect((await new NativeMediaEngine(store, { tools: { ffmpeg: broken, ffprobe: broken } }).info()).audio).toEqual({
      available: false,
      encoders: [],
      reason: 'ffmpeg or ffprobe could not be executed',
    });
    const missing = new NativeMediaEngine(store, { tools: { ffmpeg: join(dir, 'none'), ffprobe: join(dir, 'none') } });
    expect((await missing.info()).audio).toEqual({ available: false, encoders: [], reason: 'ffmpeg/ffprobe not found' });
    expect((await failure(missing.transcodeAudio(input, job(), ctx))).code).toBe('media-engine-unavailable');
  });
});

describe('NativeMediaEngine audio jobs', () => {
  it('reports progress and adopts the output under the target extension', async () => {
    const ffmpeg = await fakeTool(
      'audio-progress',
      'for last; do :; done\necho "size=1kB"\necho "out_time_us=1000000"\necho "out_time_ms=8000000"\necho "progress=end"\nprintf "audio" > "$last"',
    );
    const engine = new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } });
    const events: { seconds?: number; fraction?: number; stage: string; resource?: string }[] = [];
    const out = await engine.transcodeAudio(input, job(), {
      ...ctx,
      onProgress: (e) => events.push({ stage: e.stage, seconds: e.processedSeconds, fraction: e.fraction, resource: e.resource }),
    });
    expect(out.name).toMatch(/\.mp3$/);
    expect(out.size).toBe(5);
    expect(events).toEqual([
      { stage: 'transcode', seconds: 1, fraction: 0.25, resource: ctx.resourcePath },
      { stage: 'transcode', seconds: 8, fraction: 0.99, resource: ctx.resourcePath },
    ]);
    // Without a listener the progress lines are ignored.
    const m4a = await engine.transcodeAudio(input, job('m4a'), ctx);
    expect(m4a.name).toMatch(/\.m4a$/);
    // A recording without a known duration reports seconds only.
    const seconds: unknown[] = [];
    const webm = await engine.transcodeAudio(input, { ...job('m4a'), target: 'webm', expected: {} }, { ...ctx, onProgress: (e) => seconds.push(e) });
    expect(webm.name).toMatch(/\.webm$/);
    expect(seconds).toEqual([
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 1 },
      { stage: 'transcode', resource: ctx.resourcePath, processedSeconds: 8 },
    ]);
    await webm.dispose();
    await out.dispose();
    await m4a.dispose();
  });

  it('removes the partial output when ffmpeg fails', async () => {
    const ffmpeg = await fakeTool('audio-fails', 'for last; do :; done\nprintf "junk" > "$last"\necho "Invalid data found when processing input" >&2\nexit 1');
    const before = await readdir(store.dir);
    const error = await failure(new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } }).transcodeAudio(input, job(), ctx));
    expect(error).toMatchObject({ code: 'media-failed', message: 'ffmpeg failed: Invalid data found when processing input' });
    expect(await readdir(store.dir)).toEqual(before);
  });

  it('removes the partial output and stops ffmpeg when cancelled', async () => {
    const pidFile = join(dir, 'audio-ffmpeg.pid');
    const ffmpeg = await fakeTool(
      'audio-slow',
      `for last; do :; done\nprintf "partial" > "$last"\necho $$ > "${pidFile}"\necho "out_time_us=100000"\nexec sleep 30`,
    );
    const before = await readdir(store.dir);
    const controller = new AbortController();
    const pending = new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } }).transcodeAudio(input, job(), {
      ...ctx,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(await readdir(store.dir)).toEqual(before);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('refuses resources that are not files', async () => {
    const ffmpeg = await fakeTool('audio-ok', 'exit 0');
    const memory = { name: 'x.wav', size: 1, open: () => Promise.reject(new Error('unused')), dispose: () => Promise.resolve() } as StoredResource;
    const error = await failure(new NativeMediaEngine(store, { tools: { ffmpeg, ffprobe: ffmpeg } }).transcodeAudio(memory, job(), ctx));
    expect(error).toMatchObject({ code: 'internal', message: 'Native engine needs file resources' });
  });
});
