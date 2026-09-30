import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { optionsFromFlags, renderPlan } from '../../../src/cli/commands/optimize.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { OptimizationPlan, PlanOperation } from '../../../src/core/plan/plan.js';
import { captureIO, ELPX, removeDir, runCli, singleJson, tempDir } from '../../helpers/cli.js';
import { configureLocalTools } from '../../helpers/native.js';

/** CLI support for clean file names (--normalize-names) and the "maximum" preset name. */

const COURSE = join(ELPX, 'course-video.elpx');
let dir: string;

beforeAll(async () => {
  configureLocalTools();
  dir = await tempDir('elpx-names-cli-');
});
afterAll(async () => {
  await removeDir(dir);
});

describe('optimize --normalize-names / --preset maximum', () => {
  it('maps the flags onto the options', async () => {
    const io = captureIO({ cwd: dir }).io;
    expect(await optionsFromFlags({ 'normalize-names': 'slug' }, io)).toEqual({ normalizeNames: 'slug' });
    // "maximum" is the web app's name for the aggressive preset; other names pass through for validation.
    expect(await optionsFromFlags({ preset: 'maximum' }, io)).toEqual({ preset: 'aggressive' });
    expect(await optionsFromFlags({ preset: 'conservative' }, io)).toEqual({ preset: 'conservative' });
  });

  it.each([
    ['--normalize-names', 'lower', 'Invalid options: normalizeNames must be "off" or "slug"\n'],
    ['--preset', 'extreme', 'Invalid options: preset must be one of conservative, balanced, aggressive\n'],
  ])('rejects %s %s', async (flag, value, stderr) => {
    const r = await runCli(['optimize', COURSE, '--dry-run', flag, value]);
    expect(r).toMatchObject({ code: EXIT.USAGE, stdout: '', stderr });
  });

  it('documents the options and the default image size limits', async () => {
    const { stdout } = await runCli(['optimize', '--help']);
    expect(stdout).toContain('--preset NAME              conservative | balanced (default) | maximum (alias: aggressive)\n');
    expect(stdout).toContain('--normalize-names MODE     off (default) | slug: clean file names (lower case, no\n');
    expect(stdout).toContain('--image-max-dimension N    Downscale larger images (N px; default 2560/1920/1600), or "none"\n');
  });

  it('plans clean names in dry runs, only when asked, and accepts the maximum preset', async () => {
    const args = ['optimize', COURSE, '--dry-run', '--json', '--quiet', '--no-video', '--no-images', '--no-audio'];
    const on = singleJson<{ plan: OptimizationPlan }>((await runCli([...args, '--normalize-names', 'slug', '--preset', 'maximum'])).stdout).plan;
    expect(on.options).toMatchObject({ normalizeNames: 'slug', preset: 'aggressive' });
    expect(on.options.images.maxDimension).toBe(1600);
    expect(on.operations.filter((o): o is Extract<PlanOperation, { op: 'rename-resource' }> => o.op === 'rename-resource').map((o) => [o.path, o.to])).toEqual([
      ['content/resources/fotos/año-2x.png', 'content/resources/fotos/ano-2x.png'],
      ['content/resources/fotos/foto&paisaje.jpg', 'content/resources/fotos/foto-paisaje.jpg'],
      ['content/resources/media/clase 1.mp4', 'content/resources/media/clase-1.mp4'],
      ['content/resources/media/clase 1.vtt', 'content/resources/media/clase-1.vtt'],
    ]);
    const off = singleJson<{ plan: OptimizationPlan }>((await runCli(args)).stdout).plan;
    expect(off.options.normalizeNames).toBe('off');
    expect(off.operations.some((o) => o.op === 'rename-resource')).toBe(false);
    const text = await runCli(['optimize', COURSE, '--dry-run', '--quiet', '--verbose', '--no-video', '--no-images', '--normalize-names', 'slug']);
    expect(text.stdout).toContain('  • rename content/resources/media/clase 1.mp4 → content/resources/media/clase-1.mp4 (11 references rewritten)\n');
    expect(text.stdout).toContain('Note: Files get clean names (lower case, no spaces, accents or copy markers) and their references are rewritten.\n');
  });
});

describe('renderPlan: rename operations', () => {
  it('shows the clean name', () => {
    const plan = {
      input: { name: 'p.elpx', size: 10 },
      options: { preset: 'balanced' },
      engine: { engine: 'native' },
      operations: [
        { op: 'rename-resource', path: 'content/resources/Foto 1.JPG', to: 'content/resources/foto-1.jpg', references: 3 },
      ] as unknown as PlanOperation[],
      skipped: [],
      estimate: { savedBytes: 0 },
      risks: [],
    } as unknown as OptimizationPlan;
    expect(renderPlan(plan)).toContain('  • rename content/resources/Foto 1.JPG → content/resources/foto-1.jpg (3 references rewritten)\n');
  });
});
