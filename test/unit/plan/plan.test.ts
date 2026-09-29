import { describe, expect, it } from 'vitest';
import { buildOptimizationPlan, type OptimizationPlan, type PlanOperation } from '../../../src/core/plan/plan.js';
import { canonicalJson, normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import { sha256Hex } from '../../../src/core/io/hash.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import { analyzeBytes, buildElpx, enc, limits, media } from '../../helpers/core-kit.js';
import { FakeEngine, MemoryStore, engineInfo, fakeMp4, inputProbe, videoStream } from '../../helpers/fake-platform.js';

const R = '{{context_path}}/content/resources';
const PNG = media('palette-efficient.png');

/** Analyzes a rich package with the fake engine (videos are probed). */
async function richAnalysis(): Promise<Analysis> {
  const store = new MemoryStore();
  const engine = new FakeEngine(store);
  engine.probeInput = (r) => {
    // The file size tells the fake videos apart.
    if (r.size === 5000) return { ...inputProbe(), streams: [videoStream({ width: 2560, height: 1440, bitRate: 20_000_000 })] };
    if (r.size === 6000) return { ...inputProbe(), bitRate: 100_000, streams: [videoStream({ bitRate: 100_000 })] };
    if (r.size === 7000) throw new Error('unreadable');
    return inputProbe();
  };
  const html = [
    `<video src="${R}/clase.mp4"></video><video src="${R}/hd.mp4"></video><video src="${R}/ligero.mp4"></video><video src="${R}/no-probe.mp4"></video>`,
    `<img src="${R}/foto.jpg"><img src="${R}/icono.png"><img src="${R}/a.png"><img src="${R}/copia/a.png"><img src="${R}/Mayus.PNG">`,
    `<img src="${R}/anim.gif"><img src="${R}/grande.jpg">`,
  ].join('');
  const bytes = buildElpx({
    components: [{ html }],
    manifest: true,
    files: {
      'screenshot.png': media('alpha-text.png'),
      'content/resources/clase.mp4': fakeMp4(4000),
      'content/resources/hd.mp4': fakeMp4(5000),
      'content/resources/ligero.mp4': fakeMp4(6000),
      'content/resources/foto.jpg': media('photo-exif-icc.jpg'),
      'content/resources/grande.jpg': media('progressive.jpg'),
      'content/resources/icono.png': media('alpha-text.png'),
      'content/resources/a.png': PNG,
      'content/resources/copia/a.png': PNG,
      'content/resources/mayus.png': media('deep-16bit.png'),
      'content/resources/anim.gif': media('animated.gif'),
      'content/resources/sin-uso.webp': media('lossless-alpha.webp'),
      'content/resources/sin-uso-2.txt': 'x',
      'content/resources/no-probe.mp4': fakeMp4(7000),
    },
  });
  return analyzeBytes(bytes, { media: { engine, store } });
}

/** Operation of a plan by id. */
function op(plan: OptimizationPlan, id: string): PlanOperation {
  const found = plan.operations.find((o) => o.id === id);
  if (!found) throw new Error(`no operation ${id} in ${plan.operations.map((o) => o.id).join(', ')}`);
  return found;
}

/** Plans with the given options and default engine. */
function planWith(analysis: Analysis, input: OptionsInput, info = engineInfo()): OptimizationPlan {
  return buildOptimizationPlan(analysis, normalizeOptions(input), info, limits());
}

describe('buildOptimizationPlan', () => {
  it('blocks plans for unusable inputs', async () => {
    const bad = await analyzeBytes(enc.encode('not a zip at all, sorry'));
    const plan = planWith(bad, { removeUnused: 'safe', deduplicate: 'exact' });
    expect(plan.operations).toEqual([]);
    expect(plan.blocking.map((d) => d.code)).toEqual(['not-a-zip']);
    expect(plan.estimate.savedBytes).toBe(0);
    expect(plan.risks).toEqual([]);
  });

  it('plans media re-encoding, cleanup, deduplication and the manifest update', async () => {
    const analysis = await richAnalysis();
    const plan = planWith(analysis, { removeUnused: 'safe', deduplicate: 'exact' });
    expect(plan.schema).toBe('elpx-optimizer/plan');
    expect(plan.input).toEqual(analysis.result.input);
    expect(plan.operations.map((o) => o.id)).toEqual([
      'dedup:content/resources/a.png',
      'image:content/resources/a.png',
      'image:content/resources/foto.jpg',
      'image:content/resources/grande.jpg',
      'image:content/resources/icono.png',
      'manifest:libs/elpx-manifest.js',
      'remove:content/resources/sin-uso-2.txt',
      'remove:content/resources/sin-uso.webp',
      'rewrite:content.xml',
      'video:content/resources/clase.mp4',
      'video:content/resources/hd.mp4',
    ]);
    const video = op(plan, 'video:content/resources/clase.mp4');
    expect(video).toMatchObject({ op: 'transcode-video', lossy: true, size: 4000 });
    expect(video.op === 'transcode-video' && video.estimatedBytes).toBe(4000);
    const hd = op(plan, 'video:content/resources/hd.mp4');
    expect(hd.op === 'transcode-video' && hd.job.scale).toEqual({ width: 1920, height: 1080 });
    const jpeg = op(plan, 'image:content/resources/foto.jpg');
    expect(jpeg).toMatchObject({ op: 'recompress-image', lossy: true, estimatedBytes: Math.round(45643 * 0.82) });
    const png = op(plan, 'image:content/resources/icono.png');
    expect(png).toMatchObject({ lossy: false, conversions: ['PNG recompressed losslessly'] });
    expect(op(plan, 'dedup:content/resources/a.png')).toMatchObject({
      keep: 'content/resources/a.png',
      remove: ['content/resources/copia/a.png'],
      size: PNG.length,
      references: 1,
    });
    expect(op(plan, 'rewrite:content.xml')).toMatchObject({ edits: 1 });
    expect(plan.skipped.map((s) => [s.path, s.kind, s.reason])).toEqual(
      [
        ['content/resources/anim.gif', 'image', 'unsupported-format'],
        ['content/resources/ligero.mp4', 'video', 'already-efficient'],
        ['content/resources/mayus.png', 'unused', 'kept'],
        ['content/resources/mayus.png', 'image', 'high-bit-depth'],
        ['content/resources/no-probe.mp4', 'video', 'not-probed'],
      ].sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
    );
    expect(plan.risks).toEqual([
      'Lossy re-encoding changes image/video quality; originals are kept when a result is not valid or not smaller.',
      'Some media will be downscaled.',
      'Unreferenced files will be removed; only files with no reference of any kind are selected.',
      'Duplicate files will be merged and their references rewritten.',
    ]);
    const removed = 7000 + 0;
    expect(plan.estimate.kind).toBe('estimate');
    expect(plan.estimate.savedBytes).toBeGreaterThan(removed);
    expect(plan.optionsHash).toBe(sha256Hex(canonicalJson(plan.options)));
  });

  it('is deterministic and sensitive to options and engine capabilities', async () => {
    const analysis = await richAnalysis();
    const a = planWith(analysis, { removeUnused: 'safe' });
    expect(planWith(analysis, { removeUnused: 'safe' }).planHash).toBe(a.planHash);
    expect(planWith(analysis, { removeUnused: 'off' }).planHash).not.toBe(a.planHash);
    const noVideo = planWith(
      analysis,
      {},
      engineInfo({ video: { available: false, reason: 'ffmpeg missing', encoders: [], engineClass: 'native', slowEncoders: [] } }),
    );
    expect(noVideo.planHash).not.toBe(a.planHash);
    expect(noVideo.engine.video).toEqual({ available: false, encoders: [], reason: 'ffmpeg missing' });
    expect(noVideo.skipped.find((s) => s.path === 'content/resources/no-probe.mp4')).toMatchObject({ reason: 'engine-unavailable', detail: 'ffmpeg missing' });
    const noReason = planWith(
      analysis,
      {},
      engineInfo({
        video: { available: false, encoders: [], engineClass: 'native', slowEncoders: [] },
        image: { available: false, reason: 'no sharp', encoders: {}, canResize: false },
      }),
    );
    expect(noReason.skipped.find((s) => s.path === 'content/resources/no-probe.mp4')?.detail).toBe('No video engine');
    expect(noReason.skipped.find((s) => s.path === 'content/resources/foto.jpg')).toMatchObject({ reason: 'engine-unavailable', detail: 'no sharp' });
    expect(noReason.engine.image).toEqual({ available: false, encoders: {}, reason: 'no sharp' });
  });

  it('explains videos left unprobed because they exceed the size limit', async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine(store);
    const small = limits({ maxVideoBytes: 4500 });
    const bytes = buildElpx({
      components: [{ html: `<video src="${R}/corto.mp4"></video><video src="${R}/largo.mp4"></video>` }],
      files: { 'content/resources/corto.mp4': fakeMp4(4000), 'content/resources/largo.mp4': fakeMp4(5000) },
    });
    const analysis = await analyzeBytes(bytes, { media: { engine, store }, limits: small });
    expect([...analysis.probes.keys()]).toEqual(['content/resources/corto.mp4']);
    const plan = buildOptimizationPlan(analysis, normalizeOptions(), engineInfo(), small);
    expect(plan.skipped).toEqual([
      { path: 'content/resources/largo.mp4', kind: 'video', reason: 'exceeds-size-limit', detail: 'File is larger than 4500 bytes' },
    ]);
    expect(plan.operations.map((o) => o.id)).toEqual(['video:content/resources/corto.mp4']);
    // Without a video engine that is the reason given, whatever the size.
    const off = buildOptimizationPlan(
      analysis,
      normalizeOptions(),
      engineInfo({ video: { available: false, reason: 'no ffmpeg', encoders: [], engineClass: 'native', slowEncoders: [] } }),
      small,
    );
    expect(off.skipped.find((x) => x.path === 'content/resources/largo.mp4')).toMatchObject({ reason: 'engine-unavailable', detail: 'no ffmpeg' });
  });

  it('explains images that were never inspected instead of calling them corrupt', async () => {
    const small = limits({ maxImageBytes: 40_000 });
    const bytes = buildElpx({
      components: [{ html: `<img src="${R}/asset-1234"><img src="${R}/grande.jpg"><img src="${R}/roto.jpg">` }],
      files: {
        'content/resources/asset-1234': media('photo-exif-icc.jpg'),
        'content/resources/grande.jpg': media('photo-exif-icc.jpg'),
        'content/resources/roto.jpg': media('truncated.jpg'),
      },
    });
    const analysis = await analyzeBytes(bytes, { limits: small });
    const plan = buildOptimizationPlan(analysis, normalizeOptions(), engineInfo(), small);
    expect(plan.skipped.map((x) => [x.path, x.reason, x.detail])).toEqual([
      ['content/resources/asset-1234', 'unsupported-format', 'Images without a recognised file extension are left unchanged'],
      ['content/resources/grande.jpg', 'exceeds-size-limit', 'Larger than 40000 bytes'],
      ['content/resources/roto.jpg', 'corrupt', 'JPEG end-of-image marker missing (truncated file)'],
    ]);
    expect(plan.operations).toEqual([]);
  });

  it('honours disabled media, exclusions and the screenshot option', async () => {
    const analysis = await richAnalysis();
    const off = planWith(analysis, {
      video: { enabled: false },
      exclude: ['content/resources/foto.jpg', 'content/resources/sin-uso.webp', 'content/resources/copia/a.png'],
      removeUnused: 'safe',
      deduplicate: 'exact',
    });
    expect(off.operations.some((o) => o.op === 'transcode-video')).toBe(false);
    expect(off.skipped.filter((s) => s.reason === 'video-disabled').map((s) => s.path)).toEqual([
      'content/resources/clase.mp4',
      'content/resources/hd.mp4',
      'content/resources/ligero.mp4',
      'content/resources/no-probe.mp4',
    ]);
    expect(off.skipped.find((s) => s.path === 'content/resources/foto.jpg')).toMatchObject({ reason: 'excluded', detail: 'Kept as original by request' });
    expect(off.operations.map((o) => o.id)).not.toContain('remove:content/resources/sin-uso.webp');
    expect(off.skipped.find((s) => s.kind === 'duplicate')).toMatchObject({
      path: 'content/resources/copia/a.png',
      reason: 'kept',
      detail: 'excluded by the user',
    });
    expect(off.operations.map((o) => o.id)).not.toContain('rewrite:content.xml');
    const shot = planWith(analysis, { images: { includeScreenshot: true } });
    expect(op(shot, 'image:screenshot.png')).toMatchObject({ lossy: false, job: expect.objectContaining({ mode: 'lossless', resize: undefined }) });
    expect(
      planWith(analysis, { preset: 'aggressive', images: { includeScreenshot: true, maxDimension: 64 } }).operations.find(
        (o) => o.id === 'image:screenshot.png',
      ),
    ).toMatchObject({ job: expect.objectContaining({ resize: undefined }) });
    // Without removals there is nothing to update in the manifest.
    expect(planWith(analysis, {}).operations.map((o) => o.op)).not.toContain('update-manifest');
  });

  it('drops media operations for files removed by cleanup or deduplication', async () => {
    const analysis = await richAnalysis();
    const plan = planWith(analysis, { removeUnused: 'safe', deduplicate: 'exact', images: { force: true } });
    const ids = plan.operations.map((o) => o.id);
    expect(ids).toContain('image:content/resources/a.png');
    expect(ids).not.toContain('image:content/resources/copia/a.png');
    expect(ids).not.toContain('image:content/resources/sin-uso.webp');
    expect(planWith(analysis, { images: { force: true } }).operations.map((o) => o.id)).toContain('image:content/resources/sin-uso.webp');
  });
});
