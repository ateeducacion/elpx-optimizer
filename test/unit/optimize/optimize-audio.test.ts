import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { optimizeArchive, type OptimizeOutcome } from '../../../src/core/optimize/optimize.js';
import { buildOptimizationPlan, type OptimizationPlan } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import { CancelledError } from '../../../src/core/errors.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import type { ProgressEvent } from '../../../src/core/media/engine.js';
import type { AudioJob } from '../../../src/core/media/audio-policy.js';
import { parseManifest } from '../../../src/core/format/manifest.js';
import { analyzeBytes, buildElpx, dec, elpxFixture } from '../../helpers/core-kit.js';
import {
  MemoryResource,
  MemoryStore,
  PlaybackEngine,
  audioCandidateProbe,
  audioEngine,
  audioProbe,
  fakeFlac,
  fakeMp3,
  fakeMp4,
  fakePlatform,
  fakeWav,
  fakeWebm,
  type FakeEngine,
} from '../../helpers/fake-platform.js';

/** Audio re-encoding in optimizeArchive with the fake platform: validation, renames, rejections and failures. */

const R = '{{context_path}}/content/resources';
const AUDIO = 'content/resources/audio';

interface AudioRun {
  analysis: Analysis;
  plan: OptimizationPlan;
  outcome: OptimizeOutcome;
  engine: FakeEngine;
  /** Delivered entries (empty when nothing was delivered). */
  files: Map<string, Uint8Array>;
  events: ProgressEvent[];
}

/** Analyzes and optimizes with an audio-capable fake engine configured by `setup`. */
async function run(
  bytes: Uint8Array,
  options: OptionsInput = {},
  setup: (engine: FakeEngine) => void = () => undefined,
  engine: FakeEngine = audioEngine(new MemoryStore()),
  signal?: AbortSignal,
): Promise<AudioRun> {
  const platform = fakePlatform({ engine, store: engine.store });
  const analysis = await analyzeBytes(bytes, { media: { engine, store: engine.store } });
  setup(engine);
  const plan = buildOptimizationPlan(analysis, normalizeOptions({ images: { enabled: false }, ...options }), await engine.info(), platform.limits);
  const events: ProgressEvent[] = [];
  const outcome = await optimizeArchive(new MemoryByteSource(bytes), analysis, plan, platform, {
    outputName: 'out.elpx',
    onProgress: (e) => events.push(e),
    ...(signal ? { signal } : {}),
  });
  const files = new Map<string, Uint8Array>();
  if (outcome.output) {
    const zip = await openZip(outcome.output, platform.limits);
    for (const e of zip.entries) files.set(e.name, await readEntryBytes(zip, e, 1 << 26));
  }
  return { analysis, plan, outcome, engine, files, events };
}

/** Audio results as [path, status, detail]. */
function audioResults(r: AudioRun): [string, string, string | undefined][] {
  return r.outcome.report.operations.filter((o) => o.op === 'transcode-audio').map((o) => [o.path, o.status, o.detail]);
}

const text = (r: AudioRun, name: string): string => dec.decode(r.files.get(name)!);

describe('optimizeArchive: audio', () => {
  it('converts and re-encodes audio-course.elpx, renaming files and rewriting references and types', async () => {
    const r = await run(elpxFixture('audio-course.elpx'));
    expect(r.outcome.report.status).toBe('optimized');
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
    expect(audioResults(r).sort()).toEqual([
      [`${AUDIO}/alta.mp3`, 'applied', undefined],
      [`${AUDIO}/lectura.wav`, 'applied', `converted to MP3 and renamed to ${AUDIO}/lectura.mp3`],
      [`${AUDIO}/musica.flac`, 'applied', `converted to MP3 and renamed to ${AUDIO}/musica.mp3`],
      [`${AUDIO}/pista.aiff`, 'applied', `converted to MP3 and renamed to ${AUDIO}/pista.mp3`],
    ]);
    const lectura = r.outcome.report.operations.find((o) => o.path === `${AUDIO}/lectura.wav`)!;
    expect(lectura).toMatchObject({ lossy: true, engine: 'native', before: 529302, after: 2000 });
    expect(lectura.checks).toEqual(['stream, duration, channels and sample rate match the plan', 'full decode without errors']);
    // Every candidate was decoded with the MP3 demuxer.
    expect(r.engine.decodeDemuxers).toEqual(['mp3', 'mp3', 'mp3', 'mp3']);
    expect([...r.files.keys()].filter((n) => n.startsWith(AUDIO))).toEqual([
      `${AUDIO}/lectura.mp3`,
      `${AUDIO}/musica.mp3`,
      `${AUDIO}/pista.mp3`,
      `${AUDIO}/alta.mp3`,
      `${AUDIO}/codigo.wav`,
    ]);
    expect(r.files.get(`${AUDIO}/lectura.mp3`)).toEqual(fakeMp3(2_000, 5));
    const xml = text(r, 'content.xml');
    expect(xml).toContain(`<audio controls="controls" src="${R}/audio/lectura.mp3" type="audio/mpeg"></audio>`);
    expect(xml).toContain(`<source src="${R}/audio/musica.mp3" type="audio/mpeg">`);
    expect(xml).toContain(`<a href="${R}/audio/pista.mp3">Pista</a>`);
    expect(xml).toContain(`{"word":"hola","audio":"${R}/audio/lectura.mp3"}`);
    expect(xml).toContain('content/resources/audio/codigo.wav');
    expect(text(r, 'index.html')).toContain('<audio controls="controls" src="content/resources/audio/lectura.mp3" type="audio/mpeg"></audio>');
    expect(text(r, 'search_index.js')).toContain(`src=\\"${R}/audio/musica.mp3\\" type=\\"audio/mpeg\\"`);
    const manifest = parseManifest(text(r, 'libs/elpx-manifest.js'));
    if ('error' in manifest) throw new Error(manifest.error);
    expect(manifest.files).toContain(`${AUDIO}/pista.mp3`);
    expect(manifest.files).not.toContain(`${AUDIO}/pista.aiff`);
    // Progress: extraction, encoding and validation of each file, numbered across the parallel workers.
    const extract = r.events.filter((e) => e.stage === 'extract').map((e) => [e.item, e.items]);
    expect(extract.sort()).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
    expect(r.events.filter((e) => e.stage === 'transcode' && e.resource === `${AUDIO}/lectura.wav`)).toEqual([
      { stage: 'transcode', resource: `${AUDIO}/lectura.wav`, processedSeconds: 0, totalSeconds: 10 },
    ]);
    expect(r.events.filter((e) => e.stage === 'validate' && e.message === 'Inspecting the new audio')).toHaveLength(4);
  });

  it('keeps the original, name included, when a candidate is rejected, fails or is not smaller', async () => {
    const bytes = buildElpx({
      components: [
        { html: ['a', 'b', 'c', 'd'].map((n) => `<audio src="${R}/${n}.wav" type="audio/wav"></audio>`).join('') + `<audio src="${R}/e.mp3"></audio>` },
      ],
      manifest: true,
      files: {
        'content/resources/a.wav': fakeWav(50_000, 1),
        'content/resources/b.wav': fakeWav(50_000, 2),
        'content/resources/c.wav': fakeWav(50_000, 3),
        'content/resources/d.wav': fakeWav(50_000, 4),
        'content/resources/e.mp3': fakeMp3(50_000, 5),
      },
    });
    const r = await run(bytes, {}, (engine) => {
      engine.audioTranscode = (input, job, ctx) => {
        const path = ctx.resourcePath;
        if (path.endsWith('b.wav')) return Promise.reject(new Error('ffmpeg failed: Invalid data found when processing input'));
        const name = `${path.slice(path.lastIndexOf('/') + 1)}.${job.target}`;
        const out = engine.store.track(new MemoryResource(path.endsWith('c.wav') ? fakeMp3(input.size) : fakeMp3(2_000), name, 'audio'));
        // a.wav comes back as AAC; d.wav fails its full decode.
        engine.audioJobs.set(out, path.endsWith('a.wav') ? { ...job, codec: 'aac' } : job);
        return Promise.resolve(out);
      };
      engine.decode = (candidate) =>
        candidate.name.startsWith('d.wav') ? Promise.reject(new Error('decode check failed: [mp3float] invalid frame')) : Promise.resolve();
    });
    expect(audioResults(r)).toEqual(
      expect.arrayContaining([
        ['content/resources/a.wav', 'reverted', 'candidate rejected: audio codec aac instead of mp3'],
        ['content/resources/b.wav', 'failed', 'ffmpeg failed: Invalid data found when processing input'],
        ['content/resources/c.wav', 'reverted', 'not smaller enough (50000 → 50000 bytes)'],
        ['content/resources/d.wav', 'failed', 'decode check failed: [mp3float] invalid frame'],
        ['content/resources/e.mp3', 'applied', undefined],
      ]),
    );
    expect(r.outcome.report.status).toBe('partial');
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
    // No conversion held: every WAV keeps its name, bytes and declared type, and the manifest is left alone.
    const view = text(r, 'content.xml');
    for (const n of ['a', 'b', 'c', 'd']) {
      expect(r.files.get(`content/resources/${n}.wav`)).toEqual(fakeWav(50_000, n.charCodeAt(0) - 96));
      expect(view).toContain(`<audio src="${R}/${n}.wav" type="audio/wav"></audio>`);
    }
    expect(r.outcome.report.operations.some((o) => o.op === 'rewrite-references' || o.op === 'update-manifest')).toBe(false);
    expect(r.files.get('content/resources/e.mp3')).toEqual(fakeMp3(2_000));
    // Disposed: every candidate that was not kept.
    expect([...r.engine.store.live].filter((x) => x.tag === 'audio' && !x.disposed)).toEqual([]);
  });

  it('checks browser playback of the original and the candidate', async () => {
    const bytes = buildElpx({
      components: [{ html: `<audio src="${R}/voz.wav"></audio>` }],
      files: { 'content/resources/voz.wav': fakeWav(50_000) },
    });
    const withPlayback = (answer: (r: MemoryResource) => 'playable' | 'not-playable' | 'unsupported'): { engine: FakeEngine; mimes: string[] } => {
      const engine = audioEngine(new MemoryStore(), PlaybackEngine) as PlaybackEngine;
      const mimes: string[] = [];
      const check = engine.playbackCheck.bind(engine);
      engine.playback = (r) => Promise.resolve(answer(r));
      engine.playbackCheck = (resource, mime, ctx) => {
        mimes.push(mime);
        return check(resource, mime, ctx);
      };
      return { engine, mimes };
    };
    const refused = withPlayback((r) => (r.tag === 'audio' ? 'not-playable' : 'playable'));
    const a = await run(bytes, {}, undefined, refused.engine);
    expect(audioResults(a)).toEqual([['content/resources/voz.wav', 'reverted', 'the new audio does not play in this browser']]);
    expect(refused.mimes).toEqual(['audio/wav', 'audio/mpeg']);
    expect(a.outcome.report.status).toBe('no-improvement');
    const unsupported = withPlayback((r) => (r.tag === 'audio' ? 'unsupported' : 'not-playable'));
    const b = await run(bytes, {}, undefined, unsupported.engine);
    expect(b.outcome.report.operations[0]!.checks).toEqual([
      'stream, duration, channels and sample rate match the plan',
      'full decode without errors',
      'playback: audio/mpeg not supported by this browser',
    ]);
    expect(b.files.has('content/resources/voz.mp3')).toBe(true);
    const playable = withPlayback(() => 'playable');
    const c = await run(bytes, {}, undefined, playable.engine);
    expect(c.outcome.report.operations[0]!.checks?.[2]).toBe('playback in this browser: playable (original: playable)');
  });

  it('fails audio jobs on an engine without audio support, and stops when cancelled', async () => {
    const bytes = buildElpx({
      components: [{ html: `<audio src="${R}/voz.wav"></audio><audio src="${R}/otra.wav"></audio>` }],
      files: { 'content/resources/voz.wav': fakeWav(50_000, 1), 'content/resources/otra.wav': fakeWav(50_000, 2) },
    });
    const legacy = await run(bytes, {}, (engine) => {
      (engine as { transcodeAudio?: unknown }).transcodeAudio = undefined;
    });
    expect(audioResults(legacy).sort()).toEqual([
      ['content/resources/otra.wav', 'failed', 'This engine does not process audio'],
      ['content/resources/voz.wav', 'failed', 'This engine does not process audio'],
    ]);
    expect(legacy.outcome.report.status).toBe('no-improvement');
    const controller = new AbortController();
    const cancelled = await run(
      bytes,
      {},
      (engine) => {
        engine.audioTranscode = () => {
          controller.abort();
          return Promise.reject(new CancelledError());
        };
      },
      undefined,
      controller.signal,
    );
    expect(cancelled.outcome.report.status).toBe('cancelled');
    expect(cancelled.outcome.output).toBeUndefined();
    expect([...cancelled.engine.store.live].every((x) => x.disposed)).toBe(true);
  });

  it('keeps the planned names at execution, so a conversion never takes a name that was refused', async () => {
    // tema.flac would take tema.mp3 and capture the broken link, so the plan keeps it and gives tema.wav tema_2.mp3.
    const bytes = buildElpx({
      components: [{ html: `<audio src="${R}/tema.flac"></audio><audio src="${R}/tema.wav"></audio><a href="${R}/tema.mp3">tema</a>` }],
      files: { 'content/resources/tema.flac': fakeFlac(50_000, 1), 'content/resources/tema.wav': fakeWav(50_000, 2) },
    });
    const r = await run(bytes);
    expect(r.plan.operations.filter((o) => o.op === 'transcode-audio').map((o) => [o.path, 'to' in o ? o.to : undefined])).toEqual([
      ['content/resources/tema.wav', 'content/resources/tema_2.mp3'],
    ]);
    expect(audioResults(r)).toEqual([['content/resources/tema.wav', 'applied', 'converted to MP3 and renamed to content/resources/tema_2.mp3']]);
    expect(r.outcome.report.status).toBe('optimized');
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
    // The broken link still points nowhere.
    expect(text(r, 'content.xml')).toContain(`<audio src="${R}/tema_2.mp3"></audio><a href="${R}/tema.mp3">tema</a>`);
    expect(r.files.has('content/resources/tema.mp3')).toBe(false);
  });

  it('never lets a failing cleanup mask a rejected or failed audio job', async () => {
    const bytes = buildElpx({
      components: [{ html: `<audio src="${R}/a.wav"></audio><audio src="${R}/b.wav"></audio><audio src="${R}/c.wav"></audio>` }],
      files: { 'content/resources/a.wav': fakeWav(50_000, 1), 'content/resources/b.wav': fakeWav(50_000, 2), 'content/resources/c.wav': fakeWav(50_000, 3) },
    });
    const r = await run(bytes, {}, (engine) => {
      engine.store.failDispose = true;
      engine.audioTranscode = (_input, job, ctx) => {
        if (ctx.resourcePath.endsWith('b.wav')) return Promise.reject(new Error('ffmpeg failed: out of memory'));
        const out = engine.store.track(new MemoryResource(fakeMp3(2_000), ctx.resourcePath.slice(-5), 'audio'));
        engine.audioJobs.set(out, ctx.resourcePath.endsWith('a.wav') ? { ...job, channels: 1 } : job);
        return Promise.resolve(out);
      };
      // c.wav passes validation and then fails its decode, with a candidate to clean up.
      engine.decode = () => Promise.reject(new Error('decode check failed: [mp3float] invalid frame'));
    });
    expect(audioResults(r).sort()).toEqual([
      ['content/resources/a.wav', 'reverted', 'candidate rejected: 1 channels instead of 2'],
      ['content/resources/b.wav', 'failed', 'ffmpeg failed: out of memory'],
      ['content/resources/c.wav', 'failed', 'decode check failed: [mp3float] invalid frame'],
    ]);
    expect(r.outcome.report.operations.find((o) => o.path === 'content/resources/a.wav')?.after).toBe(2_000);
    expect(r.outcome.report.status).toBe('no-improvement');
  });

  it('keeps the planned name of a conversion when an earlier one does not happen', async () => {
    // Planned: tema.flac → tema.mp3 and tema.wav → tema_2.mp3. The FLAC result is not smaller; the WAV keeps its planned name.
    const bytes = buildElpx({
      components: [{ html: `<audio src="${R}/tema.flac"></audio><audio src="${R}/tema.wav"></audio>` }],
      files: { 'content/resources/tema.flac': fakeFlac(50_000, 1), 'content/resources/tema.wav': fakeWav(50_000, 2) },
    });
    const r = await run(bytes, {}, (engine) => {
      engine.audioCandidateBytes = (job) => (job.sourceFormat === 'flac' ? fakeMp3(60_000) : fakeMp3(2_000));
    });
    expect(r.plan.operations.filter((o) => o.op === 'transcode-audio').map((o) => ('to' in o ? o.to : undefined))).toEqual([
      'content/resources/tema.mp3',
      'content/resources/tema_2.mp3',
    ]);
    expect(audioResults(r).sort()).toEqual([
      ['content/resources/tema.flac', 'reverted', 'not smaller enough (50000 → 60000 bytes)'],
      ['content/resources/tema.wav', 'applied', 'converted to MP3 and renamed to content/resources/tema_2.mp3'],
    ]);
    expect([...r.files.keys()].filter((n) => n.startsWith('content/resources/'))).toEqual(['content/resources/tema.flac', 'content/resources/tema_2.mp3']);
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
  });

  it('keeps valid video and audio candidates when a temporary input cannot be deleted', async () => {
    const bytes = buildElpx({
      components: [{ html: `<video src="${R}/clase.mp4"></video><audio src="${R}/voz.wav"></audio>` }],
      files: { 'content/resources/clase.mp4': fakeMp4(60_000), 'content/resources/voz.wav': fakeWav(50_000) },
    });
    const r = await run(bytes, {}, (engine) => {
      engine.store.failDispose = true;
    });
    expect(r.outcome.report.operations.filter((o) => o.op === 'transcode-video' || o.op === 'transcode-audio').map((o) => [o.path, o.status])).toEqual(
      expect.arrayContaining([
        ['content/resources/clase.mp4', 'applied'],
        ['content/resources/voz.wav', 'applied'],
      ]),
    );
    expect(r.outcome.report.status).toBe('optimized');
    expect(r.files.has('content/resources/voz.mp3')).toBe(true);
  });

  it('re-encodes a browser recording without a duration and checks that the result has one', async () => {
    const bytes = buildElpx({
      components: [{ html: `<audio src="${R}/grabacion.webm"></audio><audio src="${R}/otra.webm"></audio>` }],
      files: { 'content/resources/grabacion.webm': fakeWebm(500_000, 1), 'content/resources/otra.webm': fakeWebm(400_000, 2) },
    });
    // MediaRecorder output: Opus without duration or bitrate in the header.
    const recording = audioProbe('opus', { sampleRate: 48000, bitRate: undefined }, { formatName: 'matroska,webm', duration: undefined });
    const engine = audioEngine(new MemoryStore());
    engine.probeInput = () => recording;
    const r = await run(
      bytes,
      {},
      (e) => {
        // The new grabacion.webm has a duration; the new otra.webm has none either, so it is rejected.
        const withoutDuration = new Set<AudioJob>();
        e.probeAudioCandidate = (job) => ({ ...audioCandidateProbe(job), duration: withoutDuration.has(job) ? undefined : 3.2 });
        e.audioTranscode = (_input, job, ctx) => {
          const out = e.store.track(new MemoryResource(fakeWebm(2_000, 5), ctx.resourcePath.slice(-14), 'audio'));
          const own = { ...job };
          if (ctx.resourcePath.endsWith('otra.webm')) withoutDuration.add(own);
          e.audioJobs.set(out, own);
          return Promise.resolve(out);
        };
      },
      engine,
    );
    const ops = r.plan.operations.filter((o) => o.op === 'transcode-audio');
    expect(ops.map((o) => [o.path, 'estimatedBytes' in o, 'to' in o])).toEqual([
      ['content/resources/grabacion.webm', false, false],
      ['content/resources/otra.webm', false, false],
    ]);
    expect(ops[0]!.conversions).toEqual(['OPUS re-encoded to 64 kb/s (lossy); the recording has no duration in its header']);
    // Without a duration the estimate counts nothing for these files.
    expect(r.plan.estimate.savedBytes).toBe(0);
    expect(r.events.filter((e) => e.stage === 'transcode')).toEqual(
      expect.arrayContaining([{ stage: 'transcode', resource: 'content/resources/grabacion.webm', processedSeconds: 0 }]),
    );
    expect(audioResults(r).sort()).toEqual([
      ['content/resources/grabacion.webm', 'applied', undefined],
      ['content/resources/otra.webm', 'reverted', 'candidate rejected: the new file has no duration'],
    ]);
    expect(r.engine.decodeDemuxers).toEqual(['matroska,webm']);
    expect(r.files.get('content/resources/grabacion.webm')).toEqual(fakeWebm(2_000, 5));
    expect(r.files.get('content/resources/otra.webm')).toEqual(fakeWebm(400_000, 2));
    expect(r.outcome.report.status).toBe('optimized');
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
  });

  it('leaves a file exactly as it was when its planned conversion does not happen, even with clean names on', async () => {
    const bytes = buildElpx({
      components: [{ html: `<audio src="${R}/Mi Audio.wav"></audio><a href="${R}/Mi_Audio.wav">x</a><a href="${R}/Otro Nombre.pdf">pdf</a>` }],
      files: {
        'content/resources/Mi Audio.wav': fakeWav(50_000, 1),
        'content/resources/Mi_Audio.wav': fakeWav(60_000, 2),
        'content/resources/Otro Nombre.pdf': '%PDF-1.4\n',
      },
    });
    const r = await run(bytes, { normalizeNames: 'slug' }, (engine) => {
      // Never smaller: both conversions are reverted.
      engine.audioCandidateBytes = () => fakeMp3(90_000);
    });
    expect(
      r.plan.operations.filter((o) => o.op === 'transcode-audio' || o.op === 'rename-resource').map((o) => [o.op, o.path, 'to' in o ? o.to : undefined]),
    ).toEqual([
      ['transcode-audio', 'content/resources/Mi Audio.wav', 'content/resources/mi-audio.mp3'],
      ['transcode-audio', 'content/resources/Mi_Audio.wav', 'content/resources/mi-audio-2.mp3'],
      ['rename-resource', 'content/resources/Otro Nombre.pdf', 'content/resources/otro-nombre.pdf'],
    ]);
    // Only the rename the plan showed happens; the two WAVs keep their names.
    expect(r.outcome.report.operations.filter((o) => o.op === 'rename-resource').map((o) => o.path)).toEqual(['content/resources/Otro Nombre.pdf']);
    expect([...r.files.keys()].filter((n) => n.startsWith('content/resources/'))).toEqual([
      'content/resources/Mi Audio.wav',
      'content/resources/Mi_Audio.wav',
      'content/resources/otro-nombre.pdf',
    ]);
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
  });
});
