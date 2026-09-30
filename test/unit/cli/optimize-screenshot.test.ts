import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { renderPlan } from '../../../src/cli/commands/optimize.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { pngSize } from '../../../src/core/format/screenshot.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import type { OptimizationPlan } from '../../../src/core/plan/plan.js';
import type { OptimizationReport } from '../../../src/core/report/report.js';
import { FileByteSource } from '../../../src/adapters/node/file-source.js';
import { limits } from '../../helpers/core-kit.js';
import { ELPX, removeDir, runCli, singleJson, tempDir } from '../../helpers/cli.js';
import { configureLocalTools } from '../../helpers/native.js';

/** --screenshot: a new project thumbnail from an image file. */

const COURSE = join(ELPX, 'course-video.elpx');
const NO_MEDIA = ['--no-video', '--no-images', '--no-audio', '--no-pdf', '--remove-unused', 'off', '--deduplicate', 'off', '--normalize-names', 'off'];
let dir: string;

async function image(name: string, width: number, height: number, format: 'png' | 'jpeg' = 'png'): Promise<string> {
  const path = join(dir, name);
  const img = sharp({ create: { width, height, channels: 3, background: '#2266aa' } });
  await writeFile(path, await (format === 'png' ? img.png() : img.jpeg()).toBuffer());
  return path;
}

beforeAll(async () => {
  configureLocalTools();
  dir = await tempDir('elpx-screenshot-cli-');
});
afterAll(async () => {
  await removeDir(dir);
});

describe('optimize --screenshot', () => {
  it('documents the flag', async () => {
    const { stdout } = await runCli(['optimize', '--help']);
    expect(stdout).toContain('--screenshot FILE          New project thumbnail: a 16:9 image at least 600 px wide,\n');
  });

  it('scales a 16:9 JPEG to a 1280×720 PNG and stores it as screenshot.png', async () => {
    const input = await image('grande.jpg', 1920, 1080, 'jpeg');
    const output = join(dir, 'con-miniatura.elpx');
    const r = await runCli(['optimize', COURSE, '--output', output, '--json', '--quiet', ...NO_MEDIA, '--screenshot', input]);
    expect(r.code).toBe(EXIT.SUCCESS);
    const report = singleJson<OptimizationReport>(r.stdout);
    expect(report.status).toBe('optimized');
    expect(report.operations).toMatchObject([{ op: 'replace-screenshot', status: 'applied' }]);
    const source = await FileByteSource.open(output);
    try {
      const archive = await openZip(source, limits());
      const shot = await readEntryBytes(archive, archive.byName.get('screenshot.png')!, 1 << 24);
      expect(pngSize(shot)).toEqual({ width: 1280, height: 720 });
    } finally {
      await source.close();
    }
  });

  it('shows the replacement in a dry run', async () => {
    const input = await image('pequena.png', 800, 450);
    const r = await runCli(['optimize', COURSE, '--dry-run', '--json', '--quiet', ...NO_MEDIA, '--screenshot', input]);
    const plan = singleJson<{ plan: OptimizationPlan }>(r.stdout).plan;
    expect(plan.options.screenshot).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string });
    expect(renderPlan(plan)).toMatch(/• replace screenshot\.png \(/);
    const added = {
      ...plan,
      operations: [{ id: 's', op: 'replace-screenshot', path: 'screenshot.png', size: 0, after: 2048, added: true }],
    } as OptimizationPlan;
    expect(renderPlan(added)).toContain('  • add screenshot.png (2.0 KiB)\n');
  });

  it.each([
    ['cuadrada.png', 800, 800, '--screenshot must be a 16:9 image at least 600 px wide (got 800×800)'],
    ['diminuta.png', 320, 180, '--screenshot must be a 16:9 image at least 600 px wide (got 320×180)'],
  ])('refuses %s', async (name, w, h, message) => {
    const input = await image(name, w, h);
    const r = await runCli(['optimize', COURSE, '--dry-run', '--screenshot', input]);
    expect(r).toMatchObject({ code: EXIT.USAGE, stdout: '', stderr: `Invalid options: ${message}\n` });
  });

  it('refuses a file that is not an image', async () => {
    const path = join(dir, 'texto.png');
    await writeFile(path, 'hola');
    const r = await runCli(['optimize', COURSE, '--dry-run', '--screenshot', path]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/^Invalid options: Cannot read --screenshot/);
  });
});
