import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeMediaEngine } from '../../src/adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../src/adapters/node/resource-store.js';
import { decideVideo, validateVideoCandidate, isWorthReplacing, type VideoOptions } from '../../src/core/media/video-policy.js';
import { NATIVE_LIMITS } from '../../src/core/limits.js';
import { sniff } from '../../src/core/media/sniff.js';
import { MEDIA, nativeVideoAvailable } from '../helpers/native.js';

const available = nativeVideoAvailable();
const base: VideoOptions = {
  enabled: true,
  preset: 'balanced',
  crf: 23,
  maxShortSide: 1080,
  audioBitrateKbps: 128,
  x264Preset: 'veryfast',
  minSavingsPercent: 5,
  minSavingsBytes: 1024,
  force: false,
  dropDataStreams: false,
};

describe.runIf(available)('native video engine with the shared policy', () => {
  let store: NodeResourceStore;
  let engine: NativeMediaEngine;
  beforeAll(async () => {
    store = await NodeResourceStore.create();
    engine = new NativeMediaEngine(store, { threads: 2 });
  });
  afterAll(async () => {
    await store.disposeAll();
  });

  const ctx = (path: string) => ({ resourcePath: path, timeoutMs: 120_000 });

  async function decide(name: string, options: Partial<VideoOptions> = {}) {
    const bytes = new Uint8Array(readFileSync(join(MEDIA, name)));
    const resource = await store.fromBytes(bytes, name.split('.').pop()!);
    const info = await engine.info();
    const probe = await engine.probe(resource, ctx(name));
    const decision = decideVideo(
      { format: sniff(bytes.subarray(0, 512), name).format, size: bytes.length, probe },
      { ...base, ...options },
      info.video,
      NATIVE_LIMITS,
    );
    return { resource, probe, decision, bytes };
  }

  it('reports capabilities and versions', async () => {
    const info = await engine.info();
    expect(info.video.available).toBe(true);
    expect(info.video.encoders).toContain('libx264');
    expect(info.image.available).toBe(true);
    expect(info.versions['ffmpeg']).toBeTruthy();
    expect(info.versions['sharp']).toBe('0.35.5');
  });

  it('re-encodes an inefficient MP4 into a smaller valid candidate', async () => {
    const { resource, decision } = await decide('inefficient.mp4');
    expect(decision.action).toBe('transcode');
    if (decision.action !== 'transcode') return;
    const progress: number[] = [];
    const candidate = await engine.transcodeVideo(resource, decision.job, {
      ...ctx('v'),
      onProgress: (e) => e.fraction !== undefined && progress.push(e.fraction),
    });
    const probe = await engine.probe(candidate, ctx('v'));
    expect(validateVideoCandidate(decision.job, probe)).toEqual({ ok: true, problems: [] });
    await engine.decodeCheck(candidate, decision.job, ctx('v'));
    expect(candidate.size).toBeLessThan(resource.size / 2);
    expect(isWorthReplacing(resource.size, candidate.size, base)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeLessThan(1);
  });

  it('keeps audio languages, subtitles and chapters and applies rotation', async () => {
    const { resource, decision, probe } = await decide('rotated-multi.mp4');
    expect(probe.streams[0]!.rotation).toBe(90);
    expect(decision.action).toBe('transcode');
    if (decision.action !== 'transcode') return;
    expect(decision.job.expected.width).toBe(270);
    expect(decision.job.expected.height).toBe(480);
    const candidate = await engine.transcodeVideo(resource, decision.job, ctx('r'));
    const out = await engine.probe(candidate, ctx('r'));
    expect(validateVideoCandidate(decision.job, out).problems).toEqual([]);
    expect(out.streams.filter((s) => s.type === 'audio').map((s) => s.language)).toEqual(['spa', 'eng']);
    expect(out.chapters).toBe(2);
    expect(out.streams[0]!.rotation).toBe(0);
  });

  it('plans an explicit audio conversion for PCM in MOV', async () => {
    const { resource, decision } = await decide('pcm-audio.mov');
    expect(decision.action).toBe('transcode');
    if (decision.action !== 'transcode') return;
    expect(decision.job.conversions.join('\n')).toMatch(/pcm_s16le → aac/);
    const candidate = await engine.transcodeVideo(resource, decision.job, ctx('p'));
    const out = await engine.probe(candidate, ctx('p'));
    expect(validateVideoCandidate(decision.job, out).problems).toEqual([]);
    expect(out.formatName).toContain('mov');
  });

  it.each([
    ['alpha.mov', 'alpha-channel'],
    ['tenbit.mp4', 'high-bit-depth'],
    ['audio-only.m4a', 'unsupported-container'],
    ['efficient.mp4', 'already-efficient'],
  ])('skips %s (%s)', async (name, reason) => {
    const { decision } = await decide(name);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') expect(decision.reason).toBe(reason);
  });

  it('re-encodes WebM to VP9/Opus when libvpx-vp9 is available', async () => {
    const info = await engine.info();
    const { resource, decision } = await decide('sample.webm');
    if (!info.video.encoders.includes('libvpx-vp9')) {
      expect(decision.action).toBe('skip');
      return;
    }
    expect(decision.action).toBe('transcode');
    if (decision.action !== 'transcode') return;
    const candidate = await engine.transcodeVideo(resource, decision.job, ctx('w'));
    const out = await engine.probe(candidate, ctx('w'));
    expect(validateVideoCandidate(decision.job, out).problems).toEqual([]);
  });

  it('never produces a valid candidate from a truncated file', async () => {
    const { resource, decision } = await decide('truncated.mp4', { force: true });
    if (decision.action !== 'transcode') return; // skipping is also acceptable
    let failed = false;
    try {
      const candidate = await engine.transcodeVideo(resource, decision.job, ctx('t'));
      const out = await engine.probe(candidate, ctx('t'));
      const check = validateVideoCandidate(decision.job, out);
      if (!check.ok) failed = true;
      else await engine.decodeCheck(candidate, decision.job, ctx('t')).catch(() => (failed = true));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('reports probe failures for non-media input', async () => {
    const resource = await store.fromBytes(new TextEncoder().encode('not a video at all'), 'mp4');
    await expect(engine.probe(resource, ctx('x'))).rejects.toThrow(/ffprobe failed/);
  });

  it('cancels a running transcode and kills the process', async () => {
    const { resource, decision } = await decide('inefficient.mp4', { x264Preset: 'veryslow' });
    if (decision.action !== 'transcode') throw new Error('expected transcode');
    const controller = new AbortController();
    const started = Date.now();
    const p = engine.transcodeVideo(resource, decision.job, { ...ctx('c'), signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
