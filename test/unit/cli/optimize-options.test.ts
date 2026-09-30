import { APP_DEFAULTS } from '../../../src/core/plan/options.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exitForStatus, optionsFromFlags, renderPlan } from '../../../src/cli/commands/optimize.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { OptimizationPlan, PlanOperation } from '../../../src/core/plan/plan.js';
import type { OptimizationReport } from '../../../src/core/report/report.js';
import { captureIO, ELPX, removeDir, runCli, singleJson, tempDir } from '../../helpers/cli.js';
import { configureLocalTools } from '../../helpers/native.js';

const COURSE = join(ELPX, 'course-video.elpx');
let dir: string;

beforeAll(async () => {
  configureLocalTools();
  dir = await tempDir('elpx-options-');
});
afterAll(async () => {
  await removeDir(dir);
});

/** optionsFromFlags with the temp dir as working directory. */
function options(values: Record<string, unknown>): ReturnType<typeof optionsFromFlags> {
  return optionsFromFlags(values, captureIO({ cwd: dir }).io);
}

interface DryRun {
  schema: string;
  status: string;
  plan: OptimizationPlan;
  analysis: { input: { name: string }; diagnostics: number };
}

/** Runs a dry run of the course fixture and returns its JSON. */
async function dryRun(args: string[]): Promise<DryRun> {
  const r = await runCli(['optimize', COURSE, '--dry-run', '--json', '--quiet', ...args], { cwd: dir });
  expect(r.stderr).toBe('');
  expect(r.code).toBe(EXIT.SUCCESS);
  return singleJson<DryRun>(r.stdout);
}

describe('optionsFromFlags', () => {
  it('returns no options without flags', async () => {
    expect(await options({})).toEqual(APP_DEFAULTS);
  });

  it('maps every selection, video and image flag', async () => {
    expect(
      await options({
        preset: 'aggressive',
        'no-video': true,
        'no-images': true,
        'remove-unused': 'safe',
        deduplicate: 'exact',
        exclude: ['a.png', 'b.mp4'],
        'video-crf': '30',
        'video-max-resolution': '720',
        'video-audio-bitrate': '96',
        'video-x264-preset': 'slow',
        'video-force': true,
        'video-drop-data-streams': true,
        'image-quality': '75',
        'webp-quality': '70',
        'image-max-dimension': '1600',
        'no-png': true,
        'strip-metadata': true,
        'image-force': true,
        'include-screenshot': true,
        'min-savings-percent': '10',
        'min-savings-bytes': '2048',
      }),
    ).toEqual({
      ...APP_DEFAULTS,
      preset: 'aggressive',
      exclude: ['a.png', 'b.mp4'],
      minSavingsPercent: 10,
      minSavingsBytes: 2048,
      video: { enabled: false, crf: 30, maxResolution: '720', audioBitrate: 96, x264Preset: 'slow', force: true, dropDataStreams: true },
      images: { enabled: false, jpegQuality: 75, webpQuality: 70, maxDimension: 1600, png: false, stripMetadata: true, force: true, includeScreenshot: true },
    });
  });

  it('maps --image-max-dimension none to no limit', async () => {
    expect(await options({ 'image-max-dimension': 'none' })).toEqual({ ...APP_DEFAULTS, images: { maxDimension: null } });
  });

  it('merges --config with flags (flags win, excludes add up)', async () => {
    await writeFile(
      join(dir, 'options.json'),
      JSON.stringify({ preset: 'conservative', removeUnused: 'safe', exclude: ['keep.png'], video: { crf: 20, force: true }, images: { jpegQuality: 90 } }),
    );
    expect(await options({ config: 'options.json', preset: 'balanced', exclude: ['also.png'], 'video-crf': '25', 'webp-quality': '60' })).toEqual({
      ...APP_DEFAULTS,
      preset: 'balanced',
      exclude: ['keep.png', 'also.png'],
      video: { crf: 25, force: true },
      images: { jpegQuality: 90, webpQuality: 60 },
    });
    expect(await options({ config: 'options.json', exclude: ['x'] })).toMatchObject({ exclude: ['keep.png', 'x'] });
    await writeFile(join(dir, 'bare.json'), '{}');
    expect(await options({ config: 'bare.json', exclude: ['x'] })).toEqual({ ...APP_DEFAULTS, exclude: ['x'] });
  });

  it('rejects unreadable or malformed configuration files', async () => {
    await expect(options({ config: 'missing.json' })).rejects.toMatchObject({
      code: 'invalid-options',
      message: expect.stringMatching(/^Cannot read --config: ENOENT/),
    });
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await expect(options({ config: 'broken.json' })).rejects.toMatchObject({ code: 'invalid-options' });
  });

  it.each(['video-crf', 'video-audio-bitrate', 'image-quality', 'webp-quality', 'image-max-dimension', 'min-savings-percent', 'min-savings-bytes'])(
    'rejects a non-numeric --%s',
    async (flag) => {
      await expect(options({ [flag]: 'lots' })).rejects.toMatchObject({
        code: 'invalid-options',
        message: expect.stringContaining(`--${flag} must be an integer`),
      });
    },
  );
});

describe('optimize flags end to end (dry run)', () => {
  it('uses the balanced defaults', async () => {
    const r = await dryRun([]);
    expect(r.schema).toBe('elpx-optimizer/dry-run');
    expect(r.status).toBe('dry-run');
    expect(r.analysis.input.name).toBe('course-video.elpx');
    expect(r.plan.options).toMatchObject({ preset: 'balanced', removeUnused: 'safe', deduplicate: 'exact', normalizeNames: 'slug', exclude: [] });
    expect(r.plan.options.video).toMatchObject({ enabled: true, crf: 23, force: false });
    expect(r.plan.options.images).toMatchObject({ enabled: true, png: true, stripMetadata: false });
  });

  it('carries every flag into the normalized plan options', async () => {
    const r = await dryRun([
      '--preset',
      'aggressive',
      '--remove-unused',
      'safe',
      '--deduplicate',
      'exact',
      '--exclude',
      'content/resources/fotos/año-2x.png',
      '--exclude',
      'content/resources/juego/leon.png',
      '--video-crf',
      '30',
      '--video-max-resolution',
      '480',
      '--video-audio-bitrate',
      '96',
      '--video-x264-preset',
      'faster',
      '--video-force',
      '--video-drop-data-streams',
      '--image-quality',
      '70',
      '--webp-quality',
      '65',
      '--image-max-dimension',
      'none',
      '--no-png',
      '--strip-metadata',
      '--image-force',
      '--include-screenshot',
      '--min-savings-percent',
      '12',
      '--min-savings-bytes',
      '4096',
    ]);
    const o = r.plan.options;
    expect(o.preset).toBe('aggressive');
    expect(o.removeUnused).toBe('safe');
    expect(o.deduplicate).toBe('exact');
    expect(o.exclude).toEqual(['content/resources/fotos/año-2x.png', 'content/resources/juego/leon.png']);
    expect(o.video).toMatchObject({
      crf: 30,
      maxShortSide: 480,
      audioBitrateKbps: 96,
      x264Preset: 'faster',
      force: true,
      dropDataStreams: true,
      minSavingsPercent: 12,
      minSavingsBytes: 10240,
    });
    expect(o.images.maxDimension).toBeUndefined();
    expect(o.images).toMatchObject({
      jpegQuality: 70,
      webpQuality: 65,
      png: false,
      stripMetadata: true,
      force: true,
      includeScreenshot: true,
      minSavingsPercent: 12,
      minSavingsBytes: 4096,
    });
    expect(r.plan.skipped.filter((s) => s.reason === 'excluded').map((s) => s.path)).toEqual(
      expect.arrayContaining(['content/resources/fotos/año-2x.png', 'content/resources/juego/leon.png']),
    );
    expect(r.plan.operations.some((op) => op.op === 'remove-unused')).toBe(true);
    expect(r.plan.operations.some((op) => op.op === 'deduplicate')).toBe(true);
  });

  it('leaves videos unchanged when ffprobe is unavailable', async () => {
    const r = await dryRun(['--ffprobe', '/nonexistent/ffprobe']);
    expect(r.plan.operations.some((op) => op.op === 'transcode-video')).toBe(false);
    expect(r.plan.skipped.find((s) => s.kind === 'video')).toBeDefined();
  });

  it('disables media families', async () => {
    const r = await dryRun(['--no-video', '--no-images', '--remove-unused', 'off', '--deduplicate', 'off', '--normalize-names', 'off']);
    expect(r.plan.options.video.enabled).toBe(false);
    expect(r.plan.options.images.enabled).toBe(false);
    expect(r.plan.operations).toEqual([]);
  });

  it('reads --config relative to the working directory', async () => {
    await writeFile(join(dir, 'cfg.json'), JSON.stringify({ preset: 'conservative', images: { maxDimension: 800 } }));
    const r = await dryRun(['--config', 'cfg.json', '--image-quality', '88']);
    expect(r.plan.options.preset).toBe('conservative');
    expect(r.plan.options.images).toMatchObject({ maxDimension: 800, jpegQuality: 88 });
  });

  it('applies the video size limit', async () => {
    const r = await dryRun(['--max-video-size', '1000', '--timeout-video', '30', '--threads', '2', '--image-concurrency', '2']);
    expect(r.plan.operations.some((op) => op.op === 'transcode-video')).toBe(false);
    expect(r.plan.skipped.some((s) => s.kind === 'video')).toBe(true);
  });

  it.each([
    ['--preset', 'extreme'],
    ['--remove-unused', 'all'],
    ['--deduplicate', 'fuzzy'],
    ['--video-crf', '50'],
    ['--video-crf', '1.5'],
    ['--video-max-resolution', '999'],
    ['--video-audio-bitrate', '32'],
    ['--video-x264-preset', 'turbo'],
    ['--image-quality', '10'],
    ['--webp-quality', '101'],
    ['--image-max-dimension', '10'],
    ['--image-max-dimension', 'huge'],
    ['--min-savings-percent', '95'],
    ['--min-savings-bytes=-1', undefined],
    ['--threads', '0'],
    ['--image-concurrency', '64'],
    ['--timeout-video', '0'],
    ['--max-archive-size', '0'],
    ['--max-video-size', 'x'],
  ])('rejects %s %s with exit 2', async (flag, value) => {
    const r = await runCli(['optimize', COURSE, '--dry-run', flag, ...(value === undefined ? [] : [value])]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^Invalid options: /);
  });

  it('rejects unknown keys in --config', async () => {
    await writeFile(join(dir, 'unknown.json'), JSON.stringify({ video: { ffmpegArgs: ['-y'] } }));
    const r = await runCli(['optimize', COURSE, '--dry-run', '--config', 'unknown.json'], { cwd: dir });
    expect(r).toMatchObject({ code: EXIT.USAGE, stderr: 'Invalid options: Unknown option video.ffmpegArgs\n' });
  });
});

describe('renderPlan', () => {
  it('describes every kind of operation', () => {
    const plan = {
      input: { name: 'p.elpx', size: 4096 },
      options: { preset: 'balanced' },
      engine: { engine: 'native' },
      operations: [
        { op: 'transcode-video', path: 'v.mp4', size: 2048, lossy: true, conversions: ['h264 → h264'] },
        { op: 'recompress-image', path: 'i.png', size: 1024, lossy: false, conversions: ['PNG recompressed losslessly', 'metadata kept'] },
        { op: 'remove-unused', path: 'old.webp', size: 10, reason: 'not referenced' },
        { op: 'deduplicate', keep: 'a.jpg', remove: ['b.jpg', 'c.jpg'], references: 3 },
        { op: 'rewrite-references', path: 'content.xml', reason: 'references to removed duplicates' },
        { op: 'update-manifest', path: 'libs/elpx-manifest.js' },
      ] as unknown as PlanOperation[],
      skipped: Array.from({ length: 45 }, (_, i) => ({ path: `s${i}.png`, reason: 'already-efficient', detail: 'fine' })),
      estimate: { savedBytes: 1536 },
      risks: ['Lossy re-encoding changes quality'],
    } as unknown as OptimizationPlan;
    const text = renderPlan(plan);
    expect(text).toContain('Plan for p.elpx (4.0 KiB), preset balanced, engine native\n');
    expect(text).toContain('  • transcode-video v.mp4 (2.0 KiB) [lossy]: h264 → h264\n');
    expect(text).toContain('  • recompress-image i.png (1.0 KiB): PNG recompressed losslessly; metadata kept\n');
    expect(text).toContain('  • remove old.webp (10 B): not referenced\n');
    expect(text).toContain('  • deduplicate: keep a.jpg, remove b.jpg, c.jpg (3 references rewritten)\n');
    expect(text).toContain('  • rewrite-references content.xml: references to removed duplicates\n');
    expect(text).toContain('  • update-manifest libs/elpx-manifest.js: \n');
    expect(text).toContain('Left unchanged (45):\n');
    expect(text.match(/ {2}- s\d+\.png: already-efficient \(fine\)/g)).toHaveLength(40);
    expect(text).toContain('Estimated saving (estimate, not measured): 1.5 KiB\n');
    expect(text).toMatch(/Note: Lossy re-encoding changes quality\n$/);
  });

  it('omits the unchanged list when nothing was skipped', () => {
    const text = renderPlan({
      input: { name: 'p.elpx', size: 1 },
      options: { preset: 'balanced' },
      engine: { engine: 'native' },
      operations: [],
      skipped: [],
      estimate: { savedBytes: 0 },
      risks: [],
    } as unknown as OptimizationPlan);
    expect(text).toBe('Plan for p.elpx (1 B), preset balanced, engine native\nEstimated saving (estimate, not measured): 0 B\n');
  });

  it('is printed for text dry runs', async () => {
    const r = await runCli(['optimize', COURSE, '--dry-run', '--quiet']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(/^Plan for course-video\.elpx/);
    expect(r.stdout).toContain('Estimated saving (estimate, not measured)');
  });
});

describe('exitForStatus', () => {
  it.each([
    ['optimized', EXIT.SUCCESS],
    ['no-improvement', EXIT.SUCCESS],
    ['dry-run', EXIT.SUCCESS],
    ['partial', EXIT.PARTIAL],
    ['invalid-input', EXIT.INVALID_INPUT],
    ['cancelled', EXIT.CANCELLED],
    ['failed', EXIT.FAILURE],
  ])('maps %s to %i', (status, code) => {
    expect(exitForStatus(status as OptimizationReport['status'])).toBe(code);
  });
});
