import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeMediaEngine } from '../../src/adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../src/adapters/node/resource-store.js';
import { createNodePlatform } from '../../src/adapters/node/platform.js';
import { audioDemuxer, decideAudio, validateAudioCandidate, type AudioOptions } from '../../src/core/media/audio-policy.js';
import { isWorthReplacing } from '../../src/core/media/video-policy.js';
import { sniff } from '../../src/core/media/sniff.js';
import { MemoryByteSource } from '../../src/core/io/byte-source.js';
import { analyzeArchive } from '../../src/core/analyze/analyze.js';
import { buildOptimizationPlan } from '../../src/core/plan/plan.js';
import { normalizeOptions } from '../../src/core/plan/options.js';
import { optimizeArchive } from '../../src/core/optimize/optimize.js';
import { openZip, readEntryBytes } from '../../src/core/zip/reader.js';
import { NATIVE_LIMITS } from '../../src/core/limits.js';
import { dec, elpxFixture } from '../helpers/core-kit.js';
import { MEDIA, nativeVideoAvailable } from '../helpers/native.js';

/** Audio conversion and re-encoding with the real ffmpeg/ffprobe on the tone fixtures and audio-course.elpx. */

const available = nativeVideoAvailable();
const options: AudioOptions = { enabled: true, preset: 'balanced', bitrateKbps: 128, minSavingsPercent: 5, minSavingsBytes: 1024, force: false };

describe.runIf(available)('native audio engine with the shared policy', () => {
  let store: NodeResourceStore;
  let engine: NativeMediaEngine;
  beforeAll(async () => {
    store = await NodeResourceStore.create();
    engine = new NativeMediaEngine(store);
  });
  afterAll(async () => {
    await store.disposeAll();
  });

  const ctx = (path: string) => ({ resourcePath: path, timeoutMs: 120_000 });

  /** Probes a media fixture and decides its job. */
  async function decide(name: string, extra: Partial<AudioOptions> = {}) {
    const bytes = new Uint8Array(readFileSync(join(MEDIA, name)));
    const resource = await store.fromBytes(bytes, name.split('.').pop()!);
    const probe = await engine.probe(resource, ctx(name));
    const info = await engine.info();
    const decision = decideAudio(
      { format: sniff(bytes.subarray(0, 512), name).format, size: bytes.length, probe },
      { ...options, ...extra },
      info.audio!,
      NATIVE_LIMITS,
    );
    if (decision.action !== 'transcode') throw new Error(`${name}: ${decision.reason} (${decision.detail})`);
    return { resource, job: decision.job, bytes };
  }

  it('reports MP3 and AAC encoders', async () => {
    const info = await engine.info();
    expect(info.audio?.available).toBe(true);
    expect(info.audio?.encoders).toEqual(expect.arrayContaining(['libmp3lame', 'aac']));
  });

  it.each([
    ['tone.wav', { channels: 2, sampleRate: 44100, bitrateKbps: 128, duration: 3 }],
    ['tone.flac', { channels: 1, sampleRate: 44100, bitrateKbps: 64, duration: 3 }],
    ['tone.aiff', { channels: 1, sampleRate: 22050, bitrateKbps: 64, duration: 1 }],
  ])('converts %s to a valid, much smaller MP3', async (name, expected) => {
    const { resource, job, bytes } = await decide(name);
    expect(job).toMatchObject({ target: 'mp3', rename: true, channels: expected.channels, sampleRate: expected.sampleRate, bitrateKbps: expected.bitrateKbps });
    expect(job.expected.duration).toBeCloseTo(expected.duration, 1);
    const candidate = await engine.transcodeAudio(resource, job, ctx(name));
    const probe = await engine.probe(candidate, ctx(name));
    expect(validateAudioCandidate(job, probe)).toEqual({ ok: true, problems: [] });
    await engine.decodeCheck(candidate, { demuxer: audioDemuxer(job.target) }, ctx(name));
    const data = await candidate.open();
    try {
      expect(sniff(await data.read(0, 16), 'x.mp3').format).toBe('mp3');
    } finally {
      await data.close?.();
    }
    expect(isWorthReplacing(bytes.length, candidate.size, options)).toBe(true);
    // Global tags are carried over.
    if (name === 'tone.wav') expect(probe.tags['title']).toBe('Tono de prueba');
    await candidate.dispose();
  });

  it('re-encodes a 320 kb/s MP3 and a mono 122 kb/s M4A in their own format', async () => {
    const mp3 = await decide('tone-320.mp3');
    expect(mp3.job).toMatchObject({ target: 'mp3', rename: false, bitrateKbps: 128 });
    const smaller = await engine.transcodeAudio(mp3.resource, mp3.job, ctx('tone-320.mp3'));
    expect(validateAudioCandidate(mp3.job, await engine.probe(smaller, ctx('x'))).ok).toBe(true);
    expect(smaller.size).toBeLessThan(mp3.bytes.length / 2);
    // Mono targets half the bitrate: 122 kb/s is close to 96 (192 / 2) but far above 64 (128 / 2).
    await expect(decide('audio-only.m4a', { bitrateKbps: 192 })).rejects.toThrow(/already-efficient/);
    const m4a = await decide('audio-only.m4a');
    expect(m4a.job).toMatchObject({ target: 'm4a', encoder: 'aac', rename: false, channels: 1, bitrateKbps: 64 });
    const aac = await engine.transcodeAudio(m4a.resource, m4a.job, ctx('audio-only.m4a'));
    const probe = await engine.probe(aac, ctx('x'));
    expect(validateAudioCandidate(m4a.job, probe)).toEqual({ ok: true, problems: [] });
    await engine.decodeCheck(aac, { demuxer: audioDemuxer('m4a') }, ctx('x'));
    await smaller.dispose();
    await aac.dispose();
  });

  it('re-encodes high-bitrate Opus in WebM, also a streamed recording without a duration', async () => {
    const ffmpeg = process.env['ELPX_OPTIMIZER_FFMPEG'] ?? 'ffmpeg';
    const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (!/\blibopus\b/.test(encoders)) return;
    const tone = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-ac', '2'];
    const info = await engine.info();
    const dir = mkdtempSync(join(tmpdir(), 'elpx-opus-'));
    for (const streamed of [false, true]) {
      // Written to a pipe, like MediaRecorder, the WebM header has no duration.
      const file = join(dir, 'grabacion.webm');
      const encode = [...tone, '-c:a', 'libopus', '-b:a', '256k', '-f', 'webm'];
      const bytes = streamed
        ? new Uint8Array(execFileSync(ffmpeg, [...encode, 'pipe:1']))
        : (execFileSync(ffmpeg, [...encode, '-y', file]), new Uint8Array(readFileSync(file)));
      const resource = await store.fromBytes(bytes, 'webm');
      const probe = await engine.probe(resource, ctx('grabacion.webm'));
      expect(probe.duration === undefined).toBe(streamed);
      const decision = decideAudio({ format: 'webm', size: bytes.length, probe }, options, info.audio!, NATIVE_LIMITS);
      if (decision.action !== 'transcode') throw new Error(`${decision.reason}: ${decision.detail}`);
      expect(decision.job).toMatchObject({ target: 'webm', encoder: 'libopus', bitrateKbps: 64, sampleRate: 48000, rename: false });
      const candidate = await engine.transcodeAudio(resource, decision.job, ctx('grabacion.webm'));
      expect(validateAudioCandidate(decision.job, await engine.probe(candidate, ctx('x')))).toEqual({ ok: true, problems: [] });
      await engine.decodeCheck(candidate, { demuxer: audioDemuxer('webm') }, ctx('x'));
      expect(candidate.size).toBeLessThan(bytes.length / 2);
      await candidate.dispose();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on input that is not what the job says', async () => {
    const { job } = await decide('tone.wav');
    const garbage = await store.fromBytes(new TextEncoder().encode('RIFF----WAVEfmt definitely not audio'), 'wav');
    await expect(engine.transcodeAudio(garbage, job, ctx('broken.wav'))).rejects.toMatchObject({ code: 'media-failed' });
  });
});

describe.runIf(available)('optimizeArchive with native audio', () => {
  const work = mkdtempSync(join(tmpdir(), 'elpx-audio-e2e-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('converts audio-course.elpx end to end: .mp3 entries, references and types rewritten, everything verified', async () => {
    const input = elpxFixture('audio-course.elpx');
    const platform = await createNodePlatform({ limits: NATIVE_LIMITS, outputPath: join(work, 'audio.elpx'), threads: 2 });
    const source = new MemoryByteSource(input);
    const analysis = await analyzeArchive(source, {
      limits: NATIVE_LIMITS,
      inputName: 'audio.elpx',
      media: { engine: platform.engine, store: platform.store },
    });
    const plan = buildOptimizationPlan(analysis, normalizeOptions({ images: { enabled: false } }), await platform.engine.info(), NATIVE_LIMITS);
    const outcome = await optimizeArchive(source, analysis, plan, platform, { outputName: 'audio.elpx' });
    const report = outcome.report;
    expect(report.status).toBe('optimized');
    expect(report.validations.filter((v) => !v.ok)).toEqual([]);
    expect(
      report.operations
        .filter((o) => o.op === 'transcode-audio')
        .map((o) => [o.path, o.status])
        .sort(),
    ).toEqual([
      ['content/resources/audio/alta.mp3', 'applied'],
      ['content/resources/audio/lectura.wav', 'applied'],
      ['content/resources/audio/musica.flac', 'applied'],
      ['content/resources/audio/pista.aiff', 'applied'],
    ]);
    expect(report.sizes.saved).toBeGreaterThan(input.length / 2);
    const output = new Uint8Array(await outcome.output!.read(0, outcome.output!.size));
    await platform.lastOutput()?.discard();
    const zip = await openZip(new MemoryByteSource(output), NATIVE_LIMITS);
    const names = zip.entries.map((e) => e.name).filter((n) => n.startsWith('content/resources/audio/'));
    expect(names).toEqual([
      'content/resources/audio/lectura.mp3',
      'content/resources/audio/musica.mp3',
      'content/resources/audio/pista.mp3',
      'content/resources/audio/alta.mp3',
      // Named from a script: never renamed.
      'content/resources/audio/codigo.wav',
    ]);
    const xml = dec.decode(await readEntryBytes(zip, zip.byName.get('content.xml')!, 1 << 24));
    expect(xml).toContain('src="{{context_path}}/content/resources/audio/lectura.mp3" type="audio/mpeg"');
    expect(xml).toContain('<source src="{{context_path}}/content/resources/audio/musica.mp3" type="audio/mpeg">');
    expect(xml).not.toMatch(/lectura\.wav|musica\.flac|pista\.aiff|audio\/wav|audio\/flac/);
    // The delivered package re-analyzes cleanly, and the converted files really are MP3.
    const store = await NodeResourceStore.create();
    try {
      const after = await analyzeArchive(new MemoryByteSource(output), { limits: NATIVE_LIMITS, media: { engine: new NativeMediaEngine(store), store } });
      expect(after.result.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'fatal')).toEqual([]);
      for (const name of ['lectura', 'musica', 'pista']) {
        const e = after.result.entries.find((x) => x.path === `content/resources/audio/${name}.mp3`)!;
        expect(e).toMatchObject({ format: 'mp3', extensionMatches: true, usage: 'used' });
        expect(e.audio?.codec).toBe('mp3');
      }
    } finally {
      await store.disposeAll();
    }
  });
});
