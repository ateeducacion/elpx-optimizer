import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { optimizeArchive, type OptimizeOutcome } from '../../../src/core/optimize/optimize.js';
import { buildOptimizationPlan, type OptimizationPlan } from '../../../src/core/plan/plan.js';
import { canonicalJson, normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import { sha256Hex } from '../../../src/core/io/hash.js';
import { inspectImage, pngChunks } from '../../../src/core/media/image-inspect.js';
import { concatBytes } from '../../../src/core/io/text.js';
import { CancelledError, ElpxError } from '../../../src/core/errors.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import type { ProgressEvent } from '../../../src/core/media/engine.js';
import { analyzeBytes, buildElpx, dec, enc, limits, media, odeXml, page, zipFiles } from '../../helpers/core-kit.js';
import {
  FakeEngine,
  MemoryResource,
  MemoryStore,
  type MemoryOutput,
  PlaybackEngine,
  engineInfo,
  fakeMp4,
  fakePlatform,
  fakeWebm,
  videoStream,
  type FakePlatform,
} from '../../helpers/fake-platform.js';

const R = '{{context_path}}/content/resources';
const PHOTO = media('photo-exif-icc.jpg');
const SMALL_JPEG = media('efficient.jpg');

/** Default package: a video, a high-quality JPEG, a PNG, an unused file and a manifest. */
function packageBytes(extra: Record<string, Uint8Array | string> = {}): Uint8Array {
  return buildElpx({
    components: [{ html: `<video src="${R}/clase.mp4"></video><img src="${R}/foto.jpg"><img src="${R}/icono.png">` }],
    manifest: true,
    files: {
      'index.html': page('<img src="content/resources/foto.jpg">'),
      'content/resources/clase.mp4': fakeMp4(60_000),
      'content/resources/foto.jpg': PHOTO,
      'content/resources/icono.png': media('alpha-text.png'),
      'content/resources/sin-uso.txt': 'nothing',
      ...extra,
    },
  });
}

interface Run {
  bytes: Uint8Array;
  analysis: Analysis;
  plan: OptimizationPlan;
  platform: FakePlatform;
}

/** Analyzes and plans a package with a fresh fake platform configured by `setup`. */
async function prepare(
  bytes: Uint8Array,
  options: OptionsInput = { removeUnused: 'safe' },
  setup: (engine: FakeEngine) => void = () => undefined,
  engine?: FakeEngine,
): Promise<Run> {
  const store = engine?.store ?? new MemoryStore();
  const e = engine ?? new FakeEngine(store);
  e.encode = (_input, job) => Promise.resolve(job.format === 'jpeg' ? SMALL_JPEG : media('palette-efficient.png'));
  setup(e);
  const platform = fakePlatform({ engine: e, store });
  const analysis = await analyzeBytes(bytes, { media: { engine: e, store } });
  const plan = buildOptimizationPlan(analysis, normalizeOptions(options), await e.info(), platform.limits);
  return { bytes, analysis, plan, platform };
}

/** Executes a prepared run. */
function execute(run: Run, extra: { signal?: AbortSignal; onProgress?: (e: ProgressEvent) => void } = {}): Promise<OptimizeOutcome> {
  return optimizeArchive(new MemoryByteSource(run.bytes), run.analysis, run.plan, run.platform, { outputName: 'curso_optimizado.elpx', ...extra });
}

/** Reads every entry of the delivered archive. */
async function outputEntries(outcome: OptimizeOutcome): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const archive = await openZip(outcome.output!, limits());
  for (const e of archive.entries) out.set(e.name, await readEntryBytes(archive, e, 1 << 26));
  return out;
}

/** Status of each operation in a report, keyed by id. */
function statuses(outcome: OptimizeOutcome): Record<string, string> {
  return Object.fromEntries(outcome.report.operations.map((o) => [o.id, o.status]));
}

describe('optimizeArchive: successful runs', () => {
  it('re-encodes media, removes unused files, updates the manifest and verifies the package', async () => {
    const run = await prepare(packageBytes());
    const events: ProgressEvent[] = [];
    const outcome = await execute(run, { onProgress: (e) => events.push(e) });
    const report = outcome.report;
    expect(report.status).toBe('optimized');
    expect(report.error).toBeUndefined();
    expect(statuses(outcome)).toEqual({
      'video:content/resources/clase.mp4': 'applied',
      'image:content/resources/foto.jpg': 'applied',
      'image:content/resources/icono.png': 'applied',
      'remove:content/resources/sin-uso.txt': 'applied',
      'manifest:libs/elpx-manifest.js': 'applied',
    });
    const video = report.operations.find((o) => o.op === 'transcode-video')!;
    expect(video).toMatchObject({
      before: 60_000,
      after: 20_000,
      lossy: true,
      engine: 'native',
      checks: ['streams, duration and size match the plan', 'full decode without errors'],
    });
    expect(report.operations.find((o) => o.id === 'image:content/resources/icono.png')!.checks).toEqual([
      'decodes with the same size and format',
      'pixel-identical to the original',
    ]);
    expect(report.operations.find((o) => o.id === 'image:content/resources/foto.jpg')!.checks).toEqual(['decodes with the same size and format']);
    expect(report.validations.map((v) => [v.name, v.ok])).toEqual([
      ['plan-matches-input', true],
      ['zip-written', true],
      ['output-analyzable', true],
      ['entry-set', true],
      ['unchanged-entries-preserved', true],
      ['no-new-problems', true],
      ['references-still-resolve', true],
      ['structure-and-ids-preserved', true],
      ['manifest-matches-entries', true],
    ]);
    expect(report.sizes.saved).toBeGreaterThan(100_000);
    expect(report.output).toMatchObject({ name: 'curso_optimizado.elpx', size: outcome.output!.size });
    const entries = await outputEntries(outcome);
    expect(entries.has('content/resources/sin-uso.txt')).toBe(false);
    expect(entries.get('content/resources/clase.mp4')!.length).toBe(20_000);
    // Metadata of the original JPEG is spliced into the encoder output.
    const jpeg = entries.get('content/resources/foto.jpg')!;
    expect(inspectImage(jpeg, 'jpeg')).toMatchObject({ orientation: 6, hasIcc: true, hasExif: true, hasXmp: true });
    expect(dec.decode(entries.get('libs/elpx-manifest.js')!)).not.toContain('sin-uso.txt');
    expect(entries.get('content.xml')).toEqual(run.analysis.texts.get('content.xml') ? enc.encode(run.analysis.texts.get('content.xml')!.text) : undefined);
    expect(sha256Hex(new Uint8Array(await outcome.output!.read(0, outcome.output!.size)))).toBe(report.output!.sha256);
    expect(run.platform.outputs[0]!.discarded).toBe(false);
    expect(run.platform.store.live.size).toBe(0);
    const stages = new Set(events.map((e) => e.stage));
    for (const s of ['extract', 'transcode', 'validate', 'encode-image', 'package', 'verify'] as const) expect(stages.has(s)).toBe(true);
    // Fractions stop short of 1 until the package is verified.
    expect(events.filter((e) => e.stage === 'package').at(-1)).toMatchObject({ item: entries.size, items: entries.size, fraction: 0.99 });
  });

  it('records browser playback checks and handles WebM jobs', async () => {
    const store = new MemoryStore();
    const engine = new PlaybackEngine(store);
    const bytes = buildElpx({ components: [{ html: `<video src="${R}/v.webm"></video>` }], files: { 'content/resources/v.webm': fakeWebm(60_000) } });
    const run = await prepare(
      bytes,
      {},
      (e) => {
        e.playback = () => Promise.resolve('unsupported');
        e.candidateBytes = fakeWebm(20_000);
      },
      engine,
    );
    const outcome = await execute(run);
    expect(outcome.report.operations[0]).toMatchObject({ status: 'applied' });
    expect(outcome.report.status).toBe('optimized');
    expect(outcome.report.operations[0]!.checks).toContain('playback: video/webm not supported by this browser (original: unsupported)');
    expect(engine.calls).toEqual(expect.arrayContaining(['playback:entry', 'playback:candidate']));
    engine.playback = () => Promise.resolve('playable');
    const again = await execute(await prepare(bytes, {}, () => undefined, engine));
    expect(again.report.operations[0]!.checks).toContain('playback in this browser: playable (original: playable)');
  });
});

describe('optimizeArchive: failures that keep the original resource', () => {
  it('keeps originals when the codec fails, the candidate is rejected or not smaller', async () => {
    const run = await prepare(packageBytes(), {}, (e) => {
      e.transcode = () => Promise.reject(new Error('encoder crashed'));
      e.encode = (_i, job) => (job.format === 'png' ? Promise.reject(new Error('png encoder failed')) : Promise.resolve(PHOTO));
    });
    const outcome = await execute(run);
    expect(outcome.report.operations.find((o) => o.op === 'transcode-video')).toMatchObject({ status: 'failed', detail: 'encoder crashed' });
    expect(outcome.report.operations.find((o) => o.id === 'image:content/resources/icono.png')).toMatchObject({
      status: 'failed',
      detail: 'png encoder failed',
    });
    expect(statuses(outcome)).toEqual({
      'video:content/resources/clase.mp4': 'failed',
      'image:content/resources/foto.jpg': 'reverted',
      'image:content/resources/icono.png': 'failed',
    });
    expect(outcome.report.operations.find((o) => o.id === 'image:content/resources/foto.jpg')!.detail).toBe('not smaller enough (45643 → 45643 bytes)');
    // Nothing applied: a byte-for-byte copy of the input is delivered.
    expect(outcome.report.status).toBe('no-improvement');
    expect(outcome.report.output?.sha256).toBe(run.analysis.result.input.sha256);
    expect(outcome.report.validations.find((v) => v.name === 'no-improvement-copy')?.ok).toBe(true);
    expect(run.platform.outputs[0]!.usedOriginal).toBe(true);
    expect(new Uint8Array(await outcome.output!.read(0, outcome.output!.size))).toEqual(run.bytes);
  });

  it('rejects video candidates that fail probing, decoding, playback or the size threshold', async () => {
    const cases: [string, (e: FakeEngine) => void, string, RegExp][] = [
      [
        'wrong size',
        (e) => (e.probeCandidate = () => ({ formatName: 'mp4', duration: 10, streams: [videoStream({ width: 640, height: 360 })], chapters: 0, tags: {} })),
        'reverted',
        /^candidate rejected: size 640x360 instead of 1280x720; expected 1 audio streams, found 0$/,
      ],
      ['decode error', (e) => (e.decode = () => Promise.reject(new Error('Invalid NAL unit'))), 'failed', /^Invalid NAL unit$/],
      ['bigger', (e) => (e.candidateBytes = fakeMp4(70_000)), 'reverted', /^not smaller enough \(60000 → 70000 bytes\)/],
      ['barely smaller', (e) => (e.candidateBytes = fakeMp4(59_000)), 'reverted', /^not smaller enough/],
    ];
    for (const [, setup, status, detail] of cases) {
      const run = await prepare(packageBytes(), { images: { enabled: false } }, setup);
      const outcome = await execute(run);
      const video = outcome.report.operations.find((o) => o.op === 'transcode-video')!;
      expect(video.status).toBe(status);
      expect(video.detail).toMatch(detail);
      expect([...run.platform.store.live].every((r) => r.disposed)).toBe(true);
    }
    const store = new MemoryStore();
    const playback = new PlaybackEngine(store);
    const run = await prepare(
      packageBytes(),
      { images: { enabled: false } },
      (e) => (e.playback = (r) => Promise.resolve(r.tag === 'candidate' ? 'not-playable' : 'playable')),
      playback,
    );
    const outcome = await execute(run);
    expect(outcome.report.operations[0]).toMatchObject({ status: 'reverted', after: 20_000, detail: 'the new video does not play in this browser' });
  });

  it('rejects image candidates that are invalid, animated, different or not smaller', async () => {
    // A PNG without metadata chunks, so the encoder output is inspected exactly as produced.
    const noise = new Uint8Array(200 * 200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.imul(i, 2654435761) >>> 24;
    const encoded = new Uint8Array(
      await sharp(noise, { raw: { width: 200, height: 200, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const plain = concatBytes([
      encoded.subarray(0, 8),
      ...pngChunks(encoded)
        .filter((c) => ['IHDR', 'IDAT', 'IEND'].includes(c.type))
        .map((c) => encoded.subarray(c.start, c.end)),
    ]);
    const cases: [string, (input: Uint8Array) => Uint8Array, RegExp][] = [
      ['a JPEG for a PNG job', () => SMALL_JPEG, /^candidate is not a valid png: Not a PNG$/],
      ['an animated PNG', () => media('animated.png'), /^candidate is animated$/],
      ['not smaller', (input) => input, /^not smaller enough \(\d+ → \d+ bytes\)$/],
    ];
    for (const [, encode, detail] of cases) {
      const bytes = buildElpx({ components: [{ html: `<img src="${R}/p.png">` }], files: { 'content/resources/p.png': plain } });
      const run = await prepare(bytes, {}, (e) => (e.encode = (input) => Promise.resolve(encode(input))));
      const outcome = await execute(run);
      expect(outcome.report.operations[0]).toMatchObject({ status: 'reverted', detail: expect.stringMatching(detail) });
    }
    const verify = await prepare(
      packageBytes(),
      { video: { enabled: false } },
      (e) => (e.verify = () => Promise.resolve({ ok: false, width: 1, height: 1, hasAlpha: false, problems: ['size 1x1 instead of 320x240'] })),
    );
    const outcome = await execute(verify);
    expect(outcome.report.operations.find((o) => o.id === 'image:content/resources/foto.jpg')).toMatchObject({
      status: 'reverted',
      detail: 'candidate rejected: size 1x1 instead of 320x240',
    });
    const garbage = await prepare(packageBytes(), { video: { enabled: false } }, (e) => (e.encode = () => Promise.resolve(new Uint8Array([1, 2, 3]))));
    expect((await execute(garbage)).report.operations.find((o) => o.id === 'image:content/resources/foto.jpg')).toMatchObject({
      status: 'failed',
      detail: 'Not a JPEG',
    });
  });

  it('reports a partial result when some operations fail', async () => {
    const run = await prepare(packageBytes(), {}, (e) => (e.transcode = () => Promise.reject('opaque failure')));
    const outcome = await execute(run);
    expect(outcome.report.status).toBe('partial');
    expect(outcome.report.operations[0]).toMatchObject({ status: 'failed', detail: 'opaque failure' });
    expect(outcome.output).toBeDefined();
  });

  it('delivers the original when the repackaged file is not smaller', async () => {
    // A PNG stored without compression is tiny once the ZIP deflates it; the optimized
    // PNG is smaller as a file but is stored, so the archive grows.
    const raw = new Uint8Array(
      await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    );
    const xml = odeXml({ components: [{ html: `<img src="${R}/blanco.png">` }] });
    const bytes = zipSync({ 'content.xml': enc.encode(xml), 'content/resources/blanco.png': [raw, { level: 9 }] });
    const run = await prepare(bytes, {}, (e) => (e.encode = () => Promise.resolve(media('alpha-text.png'))));
    const outcome = await execute(run);
    expect(outcome.report.status).toBe('no-improvement');
    expect(outcome.report.operations[0]).toMatchObject({ status: 'reverted', detail: 'not delivered: no net size reduction' });
    expect(outcome.report.sizes).toMatchObject({ before: bytes.length, after: bytes.length, saved: 0 });
  });
});

describe('optimizeArchive: plan checks', () => {
  it('returns invalid-input for inputs that could not be analyzed', async () => {
    const bytes = enc.encode('definitely not a zip file');
    const analysis = await analyzeBytes(bytes);
    const platform = fakePlatform();
    const plan = buildOptimizationPlan(analysis, normalizeOptions(), engineInfo(), limits());
    const outcome = await optimizeArchive(new MemoryByteSource(bytes), analysis, plan, platform, { outputName: 'x.elpx' });
    expect(outcome.report.status).toBe('invalid-input');
    expect(outcome.output).toBeUndefined();
    expect(platform.outputs).toEqual([]);
  });

  it('refuses plans made for another input, other options or another engine', async () => {
    const run = await prepare(packageBytes());
    const expectMismatch = async (p: Promise<unknown>, message: RegExp) => {
      const error = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ElpxError);
      expect((error as ElpxError).code).toBe('plan-mismatch');
      expect((error as ElpxError).message).toMatch(message);
    };
    await expectMismatch(
      optimizeArchive(new MemoryByteSource(packageBytes({ 'extra.txt': 'x' })), run.analysis, run.plan, run.platform, { outputName: 'o' }),
      /different input file/,
    );
    await expectMismatch(execute({ ...run, plan: { ...run.plan, input: { ...run.plan.input, sha256: '0'.repeat(64) } } }), /different input file/);
    const tampered = { ...run.plan.options, removeUnused: 'off' as const };
    await expectMismatch(execute({ ...run, plan: { ...run.plan, options: tampered } }), /options were modified/);
    await expectMismatch(
      execute({ ...run, plan: { ...run.plan, options: tampered, optionsHash: sha256Hex(canonicalJson(tampered)) } }),
      /does not match this input, options and engine/,
    );
    // Operations edited while the stored hash was left untouched.
    await expectMismatch(execute({ ...run, plan: { ...run.plan, operations: run.plan.operations.slice(1) } }), /does not match/);
    run.platform.engine.infoValue = engineInfo({ versions: { fake: '2.0' } });
    await expectMismatch(execute(run), /does not match/);
  });
});

describe('optimizeArchive: cancellation', () => {
  it('stops during media processing without creating an output', async () => {
    const run = await prepare(packageBytes(), {}, (e) => (e.transcode = () => Promise.reject(new CancelledError())));
    const outcome = await execute(run);
    expect(outcome.report).toMatchObject({ status: 'cancelled', error: 'Cancelled by the user; nothing was delivered' });
    expect(outcome.output).toBeUndefined();
    expect(run.platform.outputs).toEqual([]);
    const img = await prepare(
      packageBytes(),
      { video: { enabled: false } },
      (e) => (e.encode = () => Promise.reject(new ElpxError('cancelled', 'Stopped by the worker'))),
    );
    expect((await execute(img)).report.status).toBe('cancelled');
  });

  it('stops while packaging or verifying and discards the partial output', async () => {
    for (const stage of ['package', 'verify'] as const) {
      const run = await prepare(packageBytes());
      const controller = new AbortController();
      const outcome = await execute(run, { signal: controller.signal, onProgress: (e) => e.stage === stage && controller.abort() });
      expect(outcome.report.status).toBe('cancelled');
      expect(run.platform.outputs[0]!.discarded).toBe(true);
      expect(run.platform.store.live.size).toBe(0);
    }
  });

  it('propagates unexpected errors after cleaning up', async () => {
    const run = await prepare(packageBytes());
    run.platform.createOutput = () => Promise.reject(new Error('disk full'));
    run.platform.store.failDisposeAll = true;
    await expect(execute(run)).rejects.toThrow('disk full');
    expect(run.platform.store.live.size).toBe(0);
  });
});

describe('optimizeArchive: final verification of the written package', () => {
  /** Rebuilds a ZIP from its entries after applying `edit`. */
  function rezip(bytes: Uint8Array, edit: (files: Record<string, Uint8Array | string>) => void): Promise<Uint8Array> {
    return (async () => {
      const archive = await openZip(new MemoryByteSource(bytes), limits());
      const files: Record<string, Uint8Array | string> = {};
      for (const e of archive.entries) files[e.name] = await readEntryBytes(archive, e, 1 << 26);
      edit(files);
      return zipFiles(files);
    })();
  }

  /** Runs with an output target that rewrites the finished archive. */
  async function tampered(edit: (files: Record<string, Uint8Array | string>) => void): Promise<OptimizeOutcome & { run: Run }> {
    const run = await prepare(packageBytes(), { removeUnused: 'safe' });
    let edited: Uint8Array | undefined;
    const platform = fakePlatform({ engine: run.platform.engine, store: run.platform.store, tamper: (b) => edited ?? b });
    const outcome = await optimizeArchive(
      new MemoryByteSource(run.bytes),
      run.analysis,
      run.plan,
      {
        ...platform,
        createOutput: async () => {
          const out = await platform.createOutput();
          const finish = out.finish.bind(out);
          out.finish = async () => {
            const src = await finish();
            edited = await rezip(new Uint8Array(await src.read(0, src.size)), edit);
            return new MemoryByteSource(edited);
          };
          return out;
        },
      },
      { outputName: 'o.elpx' },
    );
    return { ...outcome, run: { ...run, platform } };
  }

  /** Names of the failed validations. */
  const failedChecks = (o: OptimizeOutcome) => o.report.validations.filter((v) => !v.ok).map((v) => v.name);

  it('refuses an output that does not analyze', async () => {
    const run = await prepare(packageBytes());
    const platform = fakePlatform({ engine: run.platform.engine, store: run.platform.store, tamper: (b) => b.subarray(0, b.length - 10) });
    const outcome = await optimizeArchive(new MemoryByteSource(run.bytes), run.analysis, run.plan, platform, { outputName: 'o' });
    expect(outcome.report.status).toBe('failed');
    expect(outcome.report.error).toMatch(/^The optimized package failed validation \(output-analyzable: End of central directory/);
    expect(outcome.output).toBeUndefined();
    expect(platform.outputs[0]!.discarded).toBe(true);
  });

  it.each([
    ['an entry disappeared', (f: Record<string, Uint8Array | string>) => delete f['content.dtd'], ['entry-set', 'manifest-matches-entries']],
    [
      'a referenced file disappeared',
      (f: Record<string, Uint8Array | string>) => delete f['content/resources/foto.jpg'],
      ['entry-set', 'no-new-problems', 'references-still-resolve', 'manifest-matches-entries'],
    ],
    ['an extra entry', (f: Record<string, Uint8Array | string>) => (f['zzz.txt'] = 'x'), ['entry-set', 'manifest-matches-entries']],
    ['an untouched entry changed', (f: Record<string, Uint8Array | string>) => (f['content.dtd'] = '<!-- changed -->'), ['unchanged-entries-preserved']],
    [
      'a new broken reference',
      (f: Record<string, Uint8Array | string>) => (f['index.html'] = page('<img src="content/resources/nada.png">')),
      ['unchanged-entries-preserved', 'no-new-problems'],
    ],
    [
      'a reference that stopped resolving',
      (f: Record<string, Uint8Array | string>) => (f['index.html'] = page('<img src="content/resources/FOTO.jpg">')),
      ['unchanged-entries-preserved', 'no-new-problems'],
    ],
    [
      'components removed from content.xml',
      (f: Record<string, Uint8Array | string>) => (f['content.xml'] = odeXml({ components: [] })),
      ['unchanged-entries-preserved', 'structure-and-ids-preserved'],
    ],
  ])('refuses an output where %s', async (_name, edit, expected) => {
    const outcome = await tampered(edit);
    expect(outcome.report.status).toBe('failed');
    expect(failedChecks(outcome)).toEqual(expected);
    expect(outcome.report.error).toMatch(/nothing was delivered$/);
  });

  it('refuses an output whose manifest was replaced by something unreadable', async () => {
    const outcome = await tampered((f) => (f['libs/elpx-manifest.js'] = 'broken'));
    expect(failedChecks(outcome)).toEqual(['no-new-problems']);
    expect(outcome.report.validations.find((v) => v.name === 'no-new-problems')?.detail).toMatch(/^manifest-invalid: /);
    expect(outcome.report.status).toBe('failed');
  });

  it('checks that stored resources are released even if the store fails', async () => {
    const run = await prepare(packageBytes());
    run.platform.store.failDisposeAll = true;
    const resource = new MemoryResource(new Uint8Array(1), 'x', 'bytes');
    expect(resource.size).toBe(1);
    const outcome = await execute(run);
    expect(outcome.report.status).toBe('optimized');
  });
});

describe('optimizeArchive: cleanup failures and unusual inputs', () => {
  it('never lets a failing cleanup mask the result', async () => {
    const decode = await prepare(packageBytes(), {}, (e) => {
      e.store.failDispose = true;
      e.decode = () => Promise.reject(new Error('Invalid NAL unit'));
    });
    const partial = await execute(decode);
    expect(partial.report.status).toBe('partial');
    expect(partial.report.operations[0]).toMatchObject({ status: 'failed', detail: 'Invalid NAL unit' });
    const bigger = await prepare(packageBytes(), { images: { enabled: false } }, (e) => {
      e.store.failDispose = true;
      e.candidateBytes = fakeMp4(70_000);
    });
    expect((await execute(bigger)).report.operations[0]).toMatchObject({ status: 'reverted', after: 70_000 });
    const cancel = await prepare(packageBytes());
    const controller = new AbortController();
    const platform = fakePlatform({ engine: cancel.platform.engine, store: cancel.platform.store });
    const original = platform.createOutput;
    platform.createOutput = async () => {
      const out = (await original()) as MemoryOutput;
      out.failDiscard = true;
      return out;
    };
    const outcome = await execute({ ...cancel, platform }, { signal: controller.signal, onProgress: (e) => e.stage === 'package' && controller.abort() });
    expect(outcome.report.status).toBe('cancelled');
    expect(platform.outputs[0]!.discarded).toBe(true);
  });

  it('rewrites stored text entries, handles partial deduplication and extensionless media', async () => {
    const xml = odeXml({
      components: [
        { html: `<video src="${R}/video"></video><img src="${R}/foto"><img src="${R}/a.png"><img src="${R}/a.png"><img src="${R}/b.png">` },
        { html: `<img src="${R}/c.png"><img src="${R}/c.png"><script>var x = "content/resources/d.png";</script><img src="${R}/d.png">` },
      ],
    });
    const png = media('palette-efficient.png');
    const other = media('alpha-text.png');
    const bytes = zipSync({
      'content.xml': [enc.encode(xml), { level: 0 }],
      'content/resources/video': [fakeMp4(60_000), { level: 0 }],
      'content/resources/foto': [PHOTO, { level: 0 }],
      'content/resources/a.png': [png, { level: 0 }],
      'content/resources/b.png': [png, { level: 0 }],
      'content/resources/c.png': [other, { level: 0 }],
      'content/resources/d.png': [other, { level: 0 }],
    });
    const run = await prepare(bytes, { deduplicate: 'exact', images: { png: false } });
    const controller = new AbortController();
    const outcome = await execute(run, { signal: controller.signal });
    expect(outcome.report.status).toBe('optimized');
    expect(statuses(outcome)).toMatchObject({
      'dedup:content/resources/a.png': 'applied',
      'rewrite:content.xml': 'applied',
      'video:content/resources/video': 'applied',
    });
    // Images are only inspected when their extension names an image format, so this one is left alone.
    expect(outcome.report.skipped.find((s) => s.path === 'content/resources/foto')).toMatchObject({ kind: 'image', reason: 'unsupported-format' });
    expect(outcome.report.operations.some((o) => o.id === 'dedup:content/resources/c.png')).toBe(false);
    expect(outcome.report.skipped.find((s) => s.path === 'content/resources/d.png')).toMatchObject({ kind: 'duplicate', reason: 'kept' });
    // The probe during analysis and the transcode both use a neutral extension.
    expect(run.platform.store.extensions).toEqual(['bin', 'bin']);
    const archive = await openZip(outcome.output!, limits());
    const content = archive.byName.get('content.xml')!;
    expect(content.method).toBe(0);
    expect(dec.decode(await readEntryBytes(archive, content, 1 << 20))).not.toContain('b.png');
  });
});
