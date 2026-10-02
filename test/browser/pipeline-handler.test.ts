import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import courseUrl from '../fixtures/elpx/course-video.elpx?url';
import efficientUrl from '../fixtures/elpx/efficient.elpx?url';
import legacyUrl from '../fixtures/upstream/verdaderofalso.elp?url';
import photoUrl from '../fixtures/media/photo-exif-icc.jpg?url';
import { BlobByteSource } from '../../src/adapters/browser/blob-io.js';
import { BrowserMediaEngine, type BrowserEngineOptions } from '../../src/adapters/browser/browser-media-engine.js';
import { FFMPEG_ASSETS } from '../../src/adapters/browser/ffmpeg-assets.js';
import type { FfmpegAssets } from '../../src/adapters/browser/ffmpeg-loader.js';
import type { ImageWorkerLike } from '../../src/adapters/browser/image-pool.js';
import { createPipelineHandler, PREVIEW_MAX_INFLATE, type PipelineDeps } from '../../src/adapters/browser/pipeline-handler.js';
import { checkPlayback } from '../../src/adapters/browser/playback.js';
import type { ClientMessage, EngineStatus, WorkerMessage } from '../../src/adapters/browser/protocol.js';
import { analyzeArchive } from '../../src/core/analyze/analyze.js';
import type { AnalysisResult } from '../../src/core/analyze/model.js';
import { BROWSER_LIMITS } from '../../src/core/limits.js';
import type { OptionsInput } from '../../src/core/plan/options.js';
import type { OptimizationPlan } from '../../src/core/plan/plan.js';
import type { OptimizationReport } from '../../src/core/report/report.js';
import { openZip } from '../../src/core/zip/reader.js';
import { sha256Hex } from '../../src/core/io/hash.js';
import { fixtureBytes, fixtureFile, waitFor } from './helpers.js';

const VIDEO = 'content/resources/media/clase 1.mp4';
const MiB = 1024 * 1024;

type Of<T extends WorkerMessage['type']> = Extract<WorkerMessage, { type: T }>;

/**
 * Drives a pipeline handler the way the worker does, answering playback
 * checks on this (main) thread with the real <video> probe.
 */
function harness(deps: Partial<PipelineDeps> = {}, answerPlayback = true) {
  const messages: WorkerMessage[] = [];
  const playbackChecks: Of<'playback-check'>[] = [];
  let nextId = 1;
  const handle = createPipelineHandler({ assets: FFMPEG_ASSETS, ...deps }, (m) => {
    messages.push(m);
    if (m.type === 'playback-check') {
      playbackChecks.push(m);
      if (answerPlayback) void checkPlayback(m.blob, m.mime).then((result) => handle({ type: 'playback-result', requestId: m.requestId, result }));
    }
  });
  /** The final (non-progress) answer to a request. */
  const answer = (id: number): WorkerMessage | undefined => messages.find((m) => 'id' in m && m.id === id && m.type !== 'progress');
  /** Sends a request and waits for its final answer. */
  const send = async (build: (id: number) => ClientMessage): Promise<WorkerMessage> => {
    const message = build(nextId++);
    await handle(message);
    const id = (message as { id: number }).id;
    return answer(id)!;
  };
  return {
    messages,
    playbackChecks,
    handle,
    answer,
    send,
    progressOf: (id: number) => messages.filter((m): m is Of<'progress'> => m.type === 'progress' && m.id === id).map((m) => m.event),
    analyze: async (file: File, threading?: 'auto' | 'single') =>
      (await send((id) => ({ type: 'analyze', id, file, ...(threading ? { threading } : {}) }))) as Of<'analysis'> | Of<'error'> | Of<'cancelled'>,
    plan: async (options: OptionsInput) => (await send((id) => ({ type: 'plan', id, options }))) as Of<'plan'> | Of<'error'>,
    optimize: async (planHash: string, screenshot?: Blob) =>
      (await send((id) => ({ type: 'optimize', id, planHash, ...(screenshot ? { screenshot } : {}) }))) as Of<'result'> | Of<'error'> | Of<'cancelled'>,
    read: async (path: string) => (await send((id) => ({ type: 'read', id, path }))) as Of<'read'> | Of<'error'>,
    preview: async (path: string) => (await send((id) => ({ type: 'preview', id, path }))) as Of<'preview'> | Of<'error'>,
    analyzeLimited: async (file: File, maxVideoBytes: number) => (await send((id) => ({ type: 'analyze', id, file, maxVideoBytes }))) as Of<'analysis'>,
    engineStatuses: (): EngineStatus[] => messages.filter((m): m is Of<'engine'> => m.type === 'engine').map((m) => m.status),
  };
}

/** Narrows a message to the expected type, failing with its content otherwise. */
function expectType<T extends WorkerMessage['type']>(m: WorkerMessage | undefined, type: T): Of<T> {
  expect(m, JSON.stringify(m)).toMatchObject({ type });
  return m as Of<T>;
}

describe('pipeline handler end to end (real engine and codecs)', () => {
  it('analyzes, plans and optimizes a course with a video; the output reopens smaller', async () => {
    const h = harness({ imageConcurrency: 1 });
    const file = await fixtureFile(courseUrl, 'Curso: vídeo.elpx');
    const analysis = expectType(await h.analyze(file), 'analysis').result as AnalysisResult;
    expect(analysis.ok).toBe(true);
    expect(analysis.media.probed).toBe(true);
    const video = analysis.entries.find((e) => e.path === VIDEO)!;
    expect(video.video).toMatchObject({ videoCodec: 'h264', width: 640, height: 360 });
    expect(h.progressOf(1).some((e) => e.stage === 'read')).toBe(true);
    const engine = h.messages.filter((m): m is Of<'engine'> => m.type === 'engine').map((m) => m.status);
    expect(engine[0]).toMatchObject({ state: 'loading', mode: 'single', message: 'Loading FFmpeg (single-thread)' });
    expect(engine.at(-1)).toMatchObject({ state: 'ready', mode: 'single', message: 'FFmpeg ready' });

    const plan = expectType(await h.plan({ preset: 'balanced', video: { x264Preset: 'ultrafast' }, removeUnused: 'safe', deduplicate: 'exact' }), 'plan')
      .plan as OptimizationPlan;
    expect(plan.operations.map((o) => o.op)).toEqual(expect.arrayContaining(['transcode-video', 'recompress-image', 'remove-unused', 'deduplicate']));

    const result = expectType(await h.optimize(plan.planHash), 'result');
    const report = result.report as OptimizationReport;
    expect(['optimized', 'partial']).toContain(report.status);
    expect(result.fileName).toBe('Curso_ vídeo_optimized.elpx');
    expect(result.output).toBeInstanceOf(Blob);
    expect(result.output!.size).toBe(report.output!.size);
    expect(result.output!.size).toBeLessThan(file.size);
    const videoOp = report.operations.find((o) => o.path === VIDEO)!;
    expect(videoOp).toMatchObject({ status: 'applied', op: 'transcode-video' });
    expect(videoOp.checks!.some((c) => c.startsWith('playback'))).toBe(true);
    expect(h.playbackChecks.map((m) => m.mime)).toEqual(['video/mp4', 'video/mp4']);
    const stages = new Set(h.progressOf(3).map((e) => e.stage));
    for (const s of ['extract', 'transcode', 'validate', 'encode-image', 'package', 'verify']) expect(stages).toContain(s);

    // Reopen the delivered Blob with the core.
    const source = new BlobByteSource(result.output!);
    const zip = await openZip(source, BROWSER_LIMITS);
    const before = await openZip(new BlobByteSource(file), BROWSER_LIMITS);
    expect(zip.byName.get(VIDEO)!.uncompressedSize).toBeLessThan(before.byName.get(VIDEO)!.uncompressedSize);
    expect(zip.byName.has('content/resources/sin-uso/viejo.webp')).toBe(false);
    const reopened = await analyzeArchive(source, { limits: BROWSER_LIMITS, inputName: result.fileName });
    expect(reopened.result.ok).toBe(true);
    expect(reopened.result.diagnostics.filter((d) => d.code === 'missing-resource')).toEqual(analysis.diagnostics.filter((d) => d.code === 'missing-resource'));
  });

  it('recompresses the photo inside an attached ODP with the WebAssembly codecs; the document keeps its name and other entries', async () => {
    const h = harness({ imageConcurrency: 1 });
    const photo = await fixtureBytes(photoUrl);
    const enc = new TextEncoder();
    const odpFiles: Zippable = {
      mimetype: [enc.encode('application/vnd.oasis.opendocument.presentation'), { level: 0 }],
      'content.xml': enc.encode('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>'),
      'Pictures/photo.jpg': [photo, { level: 0 }],
      'META-INF/manifest.xml': enc.encode('<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'),
    };
    const odp = zipSync(odpFiles);
    const project = unzipSync(await fixtureBytes(efficientUrl));
    const file = new File([zipSync({ ...project, 'content/resources/slides.odp': [odp, { level: 0 }] }) as Uint8Array<ArrayBuffer>], 'slides.elpx');
    expectType(await h.analyze(file), 'analysis');
    const plan = expectType(await h.plan({ video: { enabled: false } }), 'plan').plan as OptimizationPlan;
    expect(plan.operations.find((o) => o.op === 'optimize-odf')).toMatchObject({ path: 'content/resources/slides.odp', format: 'odp' });
    const result = expectType(await h.optimize(plan.planHash), 'result');
    const op = (result.report as OptimizationReport).operations.find((o) => o.op === 'optimize-odf')!;
    expect(op, JSON.stringify(op)).toMatchObject({ status: 'applied', embedded: [{ path: 'Pictures/photo.jpg', before: photo.length }] });
    const out = unzipSync(new Uint8Array(await result.output!.arrayBuffer()));
    const inner = unzipSync(out['content/resources/slides.odp']!);
    expect(Object.keys(inner)).toEqual(Object.keys(odpFiles));
    expect(inner['content.xml']).toEqual(odpFiles['content.xml']);
    expect(inner['Pictures/photo.jpg']!.length).toBeLessThan(photo.length);
  });

  it('delivers an identical copy when nothing can be improved', async () => {
    const h = harness();
    const file = await fixtureFile(efficientUrl, 'efficient.elpx');
    expectType(await h.analyze(file), 'analysis');
    // The clip is already efficient; with images off nothing can be applied.
    const plan = expectType(await h.plan({ images: { enabled: false } }), 'plan').plan;
    expect(plan.skipped.find((s) => s.path === 'content/resources/clip.mp4')).toMatchObject({ reason: 'already-efficient' });
    const result = expectType(await h.optimize(plan.planHash), 'result');
    expect(result.report.status, JSON.stringify(result.report.operations)).toBe('no-improvement');
    expect(new Uint8Array(await result.output!.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });

  it('reports a legacy .elp as a fatal analysis and delivers nothing for it', async () => {
    const h = harness();
    const result = expectType(await h.analyze(await fixtureFile(legacyUrl, 'verdaderofalso.elp')), 'analysis').result;
    expect(result.ok).toBe(false);
    expect(result.diagnostics.find((d) => d.severity === 'fatal')).toMatchObject({ code: 'legacy-elp' });
    const plan = expectType(await h.plan({}), 'plan').plan;
    expect(plan.operations).toEqual([]);
    expect(plan.blocking[0]).toMatchObject({ code: 'legacy-elp' });
    const outcome = expectType(await h.optimize(plan.planHash), 'result');
    expect(outcome.report.status).toBe('invalid-input');
    expect(outcome.output).toBeUndefined();
  });

  it('cancels a running optimization', async () => {
    const h = harness();
    expectType(await h.analyze(await fixtureFile(courseUrl, 'course.elpx')), 'analysis');
    const plan = expectType(await h.plan({ video: { x264Preset: 'veryslow', maxResolution: 'original' }, images: { enabled: false } }), 'plan').plan;
    const running = h.handle({ type: 'optimize', id: 99, planHash: plan.planHash });
    await waitFor(() => h.progressOf(99).some((e) => e.stage === 'transcode' && (e.processedSeconds ?? 0) > 0), 60_000, 'transcode progress');
    await h.handle({ type: 'cancel' });
    await running;
    expect(h.answer(99)).toEqual({ type: 'cancelled', id: 99 });
    // The pipeline is usable afterwards.
    expectType(await h.plan({}), 'plan');
  });
});

describe('pipeline handler engine and limits', () => {
  it('reports an engine that cannot be loaded, analyzes without it and retries on the next analysis', async () => {
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
    const h = harness({ assets });
    const file = await fixtureFile(courseUrl, 'c.elpx');
    const first = expectType(await h.analyze(file), 'analysis').result;
    expect(first.ok).toBe(true);
    expect(first.entries.find((e) => e.path === VIDEO)!.video).toBeUndefined();
    expect(first.diagnostics.find((d) => d.code === 'media-probe-failed')).toMatchObject({
      resource: VIDEO,
      message: expect.stringMatching(/FFmpeg could not be loaded/),
    });
    expect(h.engineStatuses()).toEqual([
      { state: 'loading', mode: 'single', reason: expect.any(String), message: 'Loading FFmpeg (single-thread)' },
      { state: 'error', mode: 'single', reason: expect.any(String), message: expect.stringMatching(/CompileError/) },
    ]);
    const second = expectType(await h.analyze(file), 'analysis').result;
    expect(second.entries.find((e) => e.path === VIDEO)!.video).toMatchObject({ videoCodec: 'h264' });
    expect(
      h
        .engineStatuses()
        .slice(2)
        .map((s) => s.state),
    ).toEqual(['loading', 'ready']);
  });

  it('processes one image per image worker and releases the workers after the run', async () => {
    const live = new Set<Worker>();
    let started = 0;
    const engineFactory = (options: BrowserEngineOptions): BrowserMediaEngine =>
      new BrowserMediaEngine({
        ...options,
        imageWorkers: 3,
        createImageWorker: () => {
          started++;
          const w = new Worker(new URL('../../src/adapters/browser/image.worker.ts', import.meta.url), { type: 'module' });
          const terminate = w.terminate.bind(w);
          w.terminate = () => {
            live.delete(w);
            terminate();
          };
          live.add(w);
          return w as unknown as ImageWorkerLike;
        },
      });
    const h = harness({ engineFactory });
    expectType(await h.analyze(await fixtureFile(courseUrl, 'c.elpx')), 'analysis');
    const plan = expectType(await h.plan({ video: { enabled: false } }), 'plan').plan;
    const images = plan.operations.filter((o) => o.op === 'recompress-image');
    expect(images.length).toBeGreaterThan(3);
    const result = expectType(await h.optimize(plan.planHash), 'result');
    expect(result.report.operations.filter((o) => o.op === 'recompress-image').map((o) => o.status)).toEqual(images.map(() => 'applied'));
    // Three at a time: three workers, kept loaded after the run and reused by the next one.
    expect(started).toBe(3);
    expect(live.size).toBe(3);
    const again = expectType(await h.optimize(plan.planHash), 'result');
    expect(again.report.operations.filter((o) => o.op === 'recompress-image').map((o) => o.status)).toEqual(images.map(() => 'applied'));
    expect(started).toBe(3);
  });

  it('applies the video size limit sent with the analysis to planning and optimizing', async () => {
    const h = harness();
    const file = await fixtureFile(courseUrl, 'c.elpx');
    const limited = expectType(await h.analyzeLimited(file, 1 * MiB), 'analysis').result;
    // Larger than the limit: not even inspected.
    expect(limited.entries.find((e) => e.path === VIDEO)!.video).toBeUndefined();
    expect(h.engineStatuses()).toEqual([]);
    const plan = expectType(await h.plan({ images: { enabled: false } }), 'plan').plan;
    expect(plan.operations.some((o) => o.op === 'transcode-video')).toBe(false);
    expect(plan.skipped.find((s) => s.path === VIDEO)).toEqual({
      path: VIDEO,
      kind: 'video',
      reason: 'exceeds-size-limit',
      detail: `File is larger than ${MiB} bytes`,
    });
    // Optimizing replays the plan with the same limits.
    expect(expectType(await h.optimize(plan.planHash), 'result').report.status).toBe('no-improvement');
    // The next analysis without an override is back to the default limit.
    const full = expectType(await h.analyze(file), 'analysis').result;
    expect(full.entries.find((e) => e.path === VIDEO)!.video).toBeDefined();
  });

  it('never raises the limit above its own and ignores invalid values', async () => {
    const h = harness({ limits: { ...BROWSER_LIMITS, maxVideoBytes: 1 * MiB } });
    const file = await fixtureFile(courseUrl, 'c.elpx');
    expect(expectType(await h.analyzeLimited(file, 1024 * MiB), 'analysis').result.entries.find((e) => e.path === VIDEO)!.video).toBeUndefined();
    const plan = expectType(await h.plan({}), 'plan').plan;
    expect(plan.skipped.find((s) => s.path === VIDEO)).toMatchObject({ reason: 'exceeds-size-limit', detail: `File is larger than ${MiB} bytes` });
    const open = harness();
    for (const invalid of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = expectType(await open.analyzeLimited(file, invalid), 'analysis').result;
      expect(result.entries.find((e) => e.path === VIDEO)!.video, String(invalid)).toBeDefined();
    }
  });
});

describe('pipeline handler protocol', () => {
  it('requires an analysis before planning and a plan before optimizing', async () => {
    const h = harness();
    expect(await h.plan({})).toEqual({ type: 'error', id: 1, code: 'internal', message: 'Analyze a project first' });
    expect(await h.optimize('x')).toEqual({ type: 'error', id: 2, code: 'internal', message: 'Analyze and plan first' });
    expectType(await h.analyze(await fixtureFile(efficientUrl, 'e.elpx')), 'analysis');
    expect(await h.optimize('x')).toMatchObject({ type: 'error', code: 'internal' });
  });

  it('rejects invalid options and a stale plan', async () => {
    const h = harness();
    expectType(await h.analyze(await fixtureFile(efficientUrl, 'e.elpx')), 'analysis');
    expect(await h.plan({ preset: 'extreme' as never })).toMatchObject({ type: 'error', code: 'invalid-options' });
    const plan = expectType(await h.plan({}), 'plan').plan;
    expect(await h.optimize(`${plan.planHash}0`)).toEqual({
      type: 'error',
      id: 4,
      code: 'plan-mismatch',
      message: 'The confirmed plan is no longer current; review it again',
    });
  });

  it('forgets the previous plan when a new file is analyzed', async () => {
    const h = harness();
    expectType(await h.analyze(await fixtureFile(efficientUrl, 'e.elpx')), 'analysis');
    const plan = expectType(await h.plan({}), 'plan').plan;
    expectType(await h.analyze(await fixtureFile(legacyUrl, 'old.elp')), 'analysis');
    expect(await h.optimize(plan.planHash)).toMatchObject({ type: 'error', message: 'Analyze and plan first' });
  });

  it('cancels an analysis', async () => {
    const h = harness();
    const file = await fixtureFile(courseUrl, 'c.elpx');
    const running = h.handle({ type: 'analyze', id: 7, file });
    await h.handle({ type: 'cancel' });
    await running;
    expect(h.answer(7)).toEqual({ type: 'cancelled', id: 7 });
  });

  it('ignores a cancel with nothing running and unknown playback answers', async () => {
    const h = harness();
    await h.handle({ type: 'cancel' });
    await h.handle({ type: 'playback-result', requestId: 42, result: 'playable' });
    expect(h.messages).toEqual([]);
  });

  it('recreates the engine when a different FFmpeg core is requested', async () => {
    const created: BrowserEngineOptions[] = [];
    const disposed: number[] = [];
    const engineFactory = (options: BrowserEngineOptions): BrowserMediaEngine => {
      created.push(options);
      const engine = new BrowserMediaEngine(options);
      const n = created.length;
      engine.dispose = async () => {
        disposed.push(n);
      };
      return engine;
    };
    const h = harness({ engineFactory });
    const file = await fixtureFile(efficientUrl, 'e.elpx');
    expectType(await h.analyze(file), 'analysis');
    expectType(await h.analyze(file, 'auto'), 'analysis');
    expect(created.map((o) => o.threading)).toEqual(['auto']);
    expectType(await h.analyze(file, 'single'), 'analysis');
    expect(disposed).toEqual([1]);
    expect(created.map((o) => o.threading)).toEqual(['auto', 'single']);
    expectType(await h.analyze(file, 'single'), 'analysis');
    expect(created).toHaveLength(2);
  });

  it('reports engine status even before the engine exists, and maps unexpected errors to "internal"', async () => {
    const engineFactory = (options: BrowserEngineOptions): BrowserMediaEngine => {
      options.onLoad?.({ stage: 'engine-load' });
      const engine = new BrowserMediaEngine(options);
      engine.info = () => Promise.reject(new TypeError('boom'));
      return engine;
    };
    const h = harness({ engineFactory });
    expect(await h.analyze(await fixtureFile(efficientUrl, 'e.elpx'))).toEqual({ type: 'error', id: 1, code: 'internal', message: 'boom' });
    expect(h.messages.find((m) => m.type === 'engine')).toEqual({ type: 'engine', status: { state: 'loading' } });
  });

  it('answers playback checks through the page', async () => {
    const engineOptions: BrowserEngineOptions[] = [];
    const h2 = harness(
      {
        engineFactory: (options) => {
          engineOptions.push(options);
          return new BrowserMediaEngine(options);
        },
      },
      false,
    );
    expectType(await h2.analyze(await fixtureFile(efficientUrl, 'e.elpx')), 'analysis');
    const probe = engineOptions[0]!.playbackProbe!;
    const blob = new Blob(['v']);
    const first = probe(blob, 'video/mp4');
    const second = probe(blob, 'video/webm');
    expect(h2.playbackChecks).toEqual([
      { type: 'playback-check', requestId: 1, blob, mime: 'video/mp4' },
      { type: 'playback-check', requestId: 2, blob, mime: 'video/webm' },
    ]);
    await h2.handle({ type: 'playback-result', requestId: 2, result: 'not-playable' });
    await h2.handle({ type: 'playback-result', requestId: 1, result: 'playable' });
    expect(await first).toBe('playable');
    expect(await second).toBe('not-playable');
    // A repeated answer is ignored.
    await h2.handle({ type: 'playback-result', requestId: 1, result: 'unsupported' });
    expect(h2.playbackChecks).toHaveLength(2);
  });

  it('uses the browser limits by default and accepts custom limits', async () => {
    const h = harness({ limits: { ...BROWSER_LIMITS, maxArchiveBytes: 1000 } });
    const result = expectType(await h.analyze(await fixtureFile(efficientUrl, 'e.elpx')), 'analysis').result;
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'fatal' });
  });
});

/** Rewrites a package with every entry deflated (eXeLearning stores media; other tools may not). */
function deflateAll(bytes: Uint8Array): Uint8Array {
  const z: Zippable = {};
  for (const [path, data] of Object.entries(unzipSync(bytes))) z[path] = [data, { level: 6 }];
  return zipSync(z);
}

describe('pipeline handler previews', () => {
  it('requires an analysis first', async () => {
    const h = harness();
    expect(await h.preview(VIDEO)).toEqual({ type: 'error', id: 1, code: 'internal', message: 'Analyze a project first' });
  });

  it('returns a stored video or image as a typed Blob with the original bytes', async () => {
    const h = harness();
    const file = await fixtureFile(courseUrl, 'c.elpx');
    expectType(await h.analyze(file), 'analysis');
    const original = unzipSync(new Uint8Array(await file.arrayBuffer()));
    for (const [path, type] of [
      [VIDEO, 'video/mp4'],
      ['content/resources/fotos/foto&paisaje.jpg', 'image/jpeg'],
      ['content/resources/juego/leon.png', 'image/png'],
    ] as const) {
      const blob = expectType(await h.preview(path), 'preview').blob;
      expect(blob.type, path).toBe(type);
      expect(new Uint8Array(await blob.arrayBuffer()), path).toEqual(original[path]);
    }
  });

  it('inflates a deflated resource', async () => {
    const h = harness();
    const source = new Uint8Array(await (await fixtureFile(efficientUrl, 'e.elpx')).arrayBuffer());
    const deflated = deflateAll(source);
    const archive = await openZip(new BlobByteSource(new Blob([deflated as Uint8Array<ArrayBuffer>])), BROWSER_LIMITS);
    expect(archive.byName.get('content/resources/icono.png')!.method).toBe(8);
    expectType(await h.analyze(new File([deflated as Uint8Array<ArrayBuffer>], 'deflated.elpx')), 'analysis');
    const original = unzipSync(source);
    for (const path of ['content/resources/icono.png', 'content/resources/clip.mp4']) {
      const blob = expectType(await h.preview(path), 'preview').blob;
      expect(new Uint8Array(await blob.arrayBuffer()), path).toEqual(original[path]);
    }
    expect(expectType(await h.preview('content/resources/clip.mp4'), 'preview').blob.type).toBe('video/mp4');
  });

  it('refuses anything that is not an image, audio or video of the project', async () => {
    const h = harness();
    expectType(await h.analyze(await fixtureFile(efficientUrl, 'e.elpx')), 'analysis');
    const refused = { type: 'error', code: 'invalid-options', message: 'Only images, audio, video and PDFs can be previewed' };
    expect(await h.preview('content.xml')).toMatchObject(refused);
    expect(await h.preview('content/resources/no-such.png')).toMatchObject(refused);
    expect(await h.preview('../outside.png')).toMatchObject(refused);
  });

  it('does not inflate a compressed resource larger than the preview limit', async () => {
    // An MP4 header followed by zeros: tiny once deflated, over the limit once inflated.
    const video = new Uint8Array(PREVIEW_MAX_INFLATE + 1);
    video.set([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0, 2, 0, ...new TextEncoder().encode('isommp41')]);
    const efficient = unzipSync(new Uint8Array(await (await fixtureFile(efficientUrl, 'e.elpx')).arrayBuffer()));
    const z: Zippable = {};
    for (const [path, data] of Object.entries(efficient)) z[path] = [data, { level: 0 }];
    z['content/resources/enorme.mp4'] = [video, { level: 1 }];
    const bytes = zipSync(z);
    expect(bytes.length).toBeLessThan(2 * MiB);
    // The ZIP-bomb ratio check is a separate guard; relaxed here to reach the preview limit.
    const h = harness({ limits: { ...BROWSER_LIMITS, maxCompressionRatio: 1e6 } });
    // Not probed (above the page limit): the analysis only lists it.
    const result = expectType(await h.analyzeLimited(new File([bytes as Uint8Array<ArrayBuffer>], 'big.elpx'), MiB), 'analysis').result;
    expect(result.ok).toBe(true);
    expect(result.entries.find((e) => e.path === 'content/resources/enorme.mp4')).toMatchObject({ kind: 'video', size: PREVIEW_MAX_INFLATE + 1 });
    expect(await h.preview('content/resources/enorme.mp4')).toMatchObject({ type: 'error', code: 'limit-exceeded', message: 'Too large to preview' });
    // Smaller stored media of the same project are still available.
    expectType(await h.preview('content/resources/clip.mp4'), 'preview');
  });
});

describe('pipeline handler: a new thumbnail', () => {
  it('reads any file of the project, and nothing when it does not exist', async () => {
    const h = harness();
    expect(await h.read('index.html')).toMatchObject({ type: 'error', code: 'internal', message: 'Analyze a project first' });
    const file = await fixtureFile(courseUrl, 'c.elpx');
    expectType(await h.analyze(file), 'analysis');
    const original = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const blob = expectType(await h.read('index.html'), 'read').blob!;
    expect(blob.type).toBe('');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original['index.html']);
    expect(expectType(await h.read('no/such.css'), 'read').blob).toBeUndefined();
    expect(expectType(await h.read('content/'), 'read').blob).toBeUndefined();
  });

  it('writes the thumbnail named by the plan into the optimized project', async () => {
    const h = harness({ imageConcurrency: 1 });
    expectType(await h.analyze(await fixtureFile(courseUrl, 'c.elpx')), 'analysis');
    const canvas = new OffscreenCanvas(1280, 720);
    canvas.getContext('2d')!.fillRect(0, 0, 1280, 720);
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const options: OptionsInput = {
      video: { enabled: false },
      images: { enabled: false },
      audio: { enabled: false },
      pdf: { enabled: false },
      screenshot: { sha256: sha256Hex(png), size: png.length },
    };
    const plan = expectType(await h.plan(options), 'plan').plan;
    expect(plan.operations.map((o) => o.op)).toEqual(['replace-screenshot']);
    expect(await h.optimize(plan.planHash)).toMatchObject({ type: 'error', code: 'plan-mismatch' });
    const result = expectType(await h.optimize(plan.planHash, new Blob([png])), 'result');
    expect(result.report.status).toBe('optimized');
    const out = unzipSync(new Uint8Array(await result.output!.arrayBuffer()));
    expect(out['screenshot.png']).toEqual(png);
  });
});
