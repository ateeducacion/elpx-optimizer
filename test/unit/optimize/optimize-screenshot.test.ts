import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { optimizeArchive, type OptimizeOutcome } from '../../../src/core/optimize/optimize.js';
import { buildOptimizationPlan, type OptimizationPlan } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import { sha256Hex } from '../../../src/core/io/hash.js';
import { pngSize, screenshotProblem, screenshotRatioOk } from '../../../src/core/format/screenshot.js';
import { parseManifest } from '../../../src/core/format/manifest.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import { analyzeBytes, buildElpx, dec, limits, page } from '../../helpers/core-kit.js';
import { FakeEngine, MemoryStore, fakePlatform, type FakePlatform } from '../../helpers/fake-platform.js';

/** A PNG of one colour. */
async function png(width: number, height: number, background = '#336699'): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toBuffer(),
  );
}

function packageBytes(files: Record<string, Uint8Array | string> = {}, manifest = true): Uint8Array {
  return buildElpx({ components: [{ html: '<p>Hola</p>' }], manifest, files: { 'index.html': page('<p>Hola</p>'), ...files } });
}

interface Run {
  bytes: Uint8Array;
  analysis: Analysis;
  plan: OptimizationPlan;
  platform: FakePlatform;
}

async function prepare(bytes: Uint8Array, shot: Uint8Array | undefined, options: OptionsInput = {}): Promise<Run> {
  const store = new MemoryStore();
  const engine = new FakeEngine(store);
  const platform = fakePlatform({ engine, store });
  const analysis = await analyzeBytes(bytes, { media: { engine, store } });
  const input: OptionsInput = { ...options, ...(shot ? { screenshot: { sha256: sha256Hex(shot), size: shot.length } } : {}) };
  const plan = buildOptimizationPlan(analysis, normalizeOptions(input), await engine.info(), platform.limits);
  return { bytes, analysis, plan, platform };
}

function execute(run: Run, screenshot: Uint8Array | undefined): Promise<OptimizeOutcome> {
  return optimizeArchive(new MemoryByteSource(run.bytes), run.analysis, run.plan, run.platform, {
    outputName: 'out.elpx',
    ...(screenshot ? { screenshot } : {}),
  });
}

async function outputEntries(outcome: OptimizeOutcome): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const archive = await openZip(outcome.output!, limits());
  for (const e of archive.entries) out.set(e.name, await readEntryBytes(archive, e, 1 << 26));
  return out;
}

describe('screenshot rules', () => {
  it('reads the size of a PNG and refuses other bytes', async () => {
    expect(pngSize(await png(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(pngSize(new TextEncoder().encode('not a png, but long enough to look'))).toBeUndefined();
  });

  it.each([
    [1280, 720, undefined],
    [800, 450, undefined],
    [1920, 1080, '1920×1080 is larger than 1280×720'],
    [1000, 720, '1000×720 is not 16:9 with at least 600 px of width'],
    [480, 270, '480×270 is not 16:9 with at least 600 px of width'],
  ])('%i×%i → %s', async (w, h, problem) => {
    expect(screenshotProblem(await png(w, h))).toBe(problem);
  });

  it('checks the ratio with eXeLearning tolerance', () => {
    expect(screenshotRatioOk(1280, 720)).toBe(true);
    expect(screenshotRatioOk(1280, 740)).toBe(true);
    expect(screenshotRatioOk(1280, 800)).toBe(false);
    expect(screenshotRatioOk(599, 337)).toBe(false);
  });

  it('refuses a JPEG', async () => {
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#000' } })
        .jpeg()
        .toBuffer(),
    );
    expect(screenshotProblem(jpeg)).toBe('not a PNG image');
  });
});

describe('options.screenshot', () => {
  it('is validated', () => {
    const sha256 = 'a'.repeat(64);
    expect(normalizeOptions({ screenshot: { sha256, size: 10 } }).screenshot).toEqual({ sha256, size: 10 });
    expect(normalizeOptions({}).screenshot).toBeUndefined();
    expect(() => normalizeOptions({ screenshot: { sha256: 'A'.repeat(64), size: 10 } })).toThrow(/sha256/);
    expect(() => normalizeOptions({ screenshot: { sha256, size: 0 } })).toThrow(/size/);
    expect(() => normalizeOptions({ screenshot: { sha256, size: 10, extra: 1 } as never })).toThrow(/Unknown option screenshot.extra/);
    expect(() => normalizeOptions({ screenshot: 'x' as never })).toThrow(/object/);
  });
});

describe('replacing screenshot.png', () => {
  it('replaces the thumbnail, stored, and keeps everything else byte for byte', async () => {
    const old = await png(640, 360, '#ffffff');
    const shot = await png(1280, 720);
    const run = await prepare(packageBytes({ 'screenshot.png': old }), shot);
    expect(run.plan.operations).toEqual([
      { id: 'screenshot:screenshot.png', op: 'replace-screenshot', path: 'screenshot.png', size: old.length, after: shot.length, added: false },
    ]);
    const outcome = await execute(run, shot);
    expect(outcome.report.status).toBe('optimized');
    expect(outcome.report.operations).toMatchObject([{ op: 'replace-screenshot', status: 'applied', detail: 'thumbnail replaced' }]);
    expect(outcome.report.validations.every((v) => v.ok)).toBe(true);
    const before = await outputEntries({ ...outcome, output: new MemoryByteSource(run.bytes) });
    const after = await outputEntries(outcome);
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect(after.get('screenshot.png')).toEqual(shot);
    for (const [name, data] of before) if (name !== 'screenshot.png') expect(after.get(name)).toEqual(data);
    const archive = await openZip(outcome.output!, limits());
    expect(archive.byName.get('screenshot.png')!.method).toBe(0);
  });

  it('adds a missing thumbnail at the end and lists it in the manifest', async () => {
    const shot = await png(800, 450);
    const run = await prepare(packageBytes(), shot);
    expect(run.plan.operations.map((o) => o.op)).toEqual(['update-manifest', 'replace-screenshot']);
    const outcome = await execute(run, shot);
    expect(outcome.report.status).toBe('optimized');
    const after = await outputEntries(outcome);
    expect([...after.keys()].at(-1)).toBe('screenshot.png');
    expect(after.get('screenshot.png')).toEqual(shot);
    const manifest = parseManifest(dec.decode(after.get('libs/elpx-manifest.js')!));
    expect('error' in manifest ? [] : manifest.files).toContain('screenshot.png');
    expect(outcome.report.validations.find((v) => v.name === 'manifest-matches-entries')?.ok).toBe(true);
  });

  it('adds a thumbnail to a package without manifest', async () => {
    const shot = await png(1280, 720);
    const run = await prepare(packageBytes({}, false), shot);
    expect(run.plan.operations.map((o) => o.op)).toEqual(['replace-screenshot']);
    const outcome = await execute(run, shot);
    expect(outcome.report.status).toBe('optimized');
    expect((await outputEntries(outcome)).get('screenshot.png')).toEqual(shot);
  });

  it('refuses bytes that are not the ones the plan names, or none', async () => {
    const shot = await png(1280, 720);
    const run = await prepare(packageBytes(), shot);
    await expect(execute(run, await png(1280, 720, '#000000'))).rejects.toMatchObject({ code: 'plan-mismatch' });
    await expect(execute(run, undefined)).rejects.toMatchObject({ code: 'plan-mismatch' });
  });

  it('refuses a thumbnail eXeLearning would not accept', async () => {
    const square = await png(800, 800);
    const run = await prepare(packageBytes(), square);
    await expect(execute(run, square)).rejects.toMatchObject({ code: 'invalid-options', message: /not 16:9/ });
  });

  it('respects an exclusion, and does not also recompress the one it replaces', async () => {
    const shot = await png(1280, 720);
    const excluded = await prepare(packageBytes({ 'screenshot.png': await png(640, 360) }), shot, { exclude: ['screenshot.png'] });
    expect(excluded.plan.operations).toEqual([]);
    expect(excluded.plan.skipped).toMatchObject([{ path: 'screenshot.png', reason: 'excluded' }]);
    const both = await prepare(packageBytes({ 'screenshot.png': await png(640, 360) }), shot, { images: { includeScreenshot: true } });
    expect(both.plan.operations.map((o) => o.op)).toEqual(['replace-screenshot']);
  });
});
