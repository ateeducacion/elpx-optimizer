import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OptimizationReport } from '../../src/core/report/report.js';
import { analyzeFile, FIXTURES, nativeVideoCheck, readEntry, ROOT, ui } from './helpers.js';

/** The CLI's environment: ffprobe from PATH, or the project-local copy when there is one (see test/helpers/native.ts). */
function cliEnv(): NodeJS.ProcessEnv {
  const local = join(ROOT, '.tools', 'bin', 'ffprobe');
  return process.env['ELPX_OPTIMIZER_FFPROBE'] || !existsSync(local) ? process.env : { ...process.env, ELPX_OPTIMIZER_FFPROBE: local };
}

/**
 * Contract between the CLI (native engine) and the web app (browser engine):
 * with the same input and options they must plan the same operations, skip
 * the same resources for the same reasons, and produce semantically
 * equivalent results (same entries, same video structure). Bytes differ
 * because the encoders differ; that is expected and reported.
 */
const COURSE = join(FIXTURES, 'elpx', 'course-video.elpx');
const VIDEO = 'content/resources/media/clase 1.mp4';
// Its clean name in both outputs.
const VIDEO_OUT = 'content/resources/media/clase-1.mp4';

test('CLI and web share plan and rules and give equivalent results', async ({ page }, testInfo) => {
  // CLI run (native ffmpeg + sharp), same options as the web defaults plus cleanup.
  const dir = mkdtempSync(join(tmpdir(), 'elpx-contract-'));
  try {
    const cliOut = join(dir, 'cli.elpx');
    const cliJson = execFileSync(
      'bun',
      [
        join(ROOT, 'src', 'cli', 'bin.ts'),
        'optimize',
        COURSE,
        '--preset',
        'balanced',
        '--remove-unused',
        'safe',
        '--deduplicate',
        'exact',
        // The web app cleans file names by default; the CLI only when asked.
        '--normalize-names',
        'slug',
        '--output',
        cliOut,
        '--json',
        '--quiet',
      ],
      { env: cliEnv() },
    ).toString();
    const cli = JSON.parse(cliJson) as OptimizationReport;

    // Web run in the browser (ffmpeg.wasm + WASM codecs).
    await page.goto('/');
    await page.setInputFiles('#file-input', COURSE);
    await expect(page.locator('.inventory')).toBeVisible({ timeout: 180_000 });
    await page.getByLabel(/Quitar archivos sin ninguna referencia|Remove files with no reference/).check();
    await page.getByLabel(/Unificar archivos idénticos|Merge identical files/).check();
    await expect(ui.cleanNames(page)).toBeChecked();
    await ui.reviewPlan(page).click();
    await expect(ui.planHeading(page)).toBeVisible();
    await ui.optimize(page).click();
    await expect(page.locator('.result-status')).toBeVisible({ timeout: 280_000 });
    const [reportDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-report').click()]);
    const webReportPath = testInfo.outputPath('web-report.json');
    await reportDl.saveAs(webReportPath);
    const web = JSON.parse(readFileSync(webReportPath, 'utf8')) as OptimizationReport;
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
    const webOut = testInfo.outputPath('web.elpx');
    await dl.saveAs(webOut);

    // Same normalized options, same planned operations, same skip reasons.
    expect(web.options).toEqual(cli.options);
    const planned = (r: OptimizationReport): string[] => r.operations.map((o) => `${o.op}:${o.path}`).sort();
    expect(planned(web)).toEqual(planned(cli));
    const skipped = (r: OptimizationReport): string[] => r.skipped.map((s) => `${s.path}:${s.reason}`).sort();
    expect(skipped(web)).toEqual(skipped(cli));
    expect(web.engine.engine).toBe('browser');
    expect(cli.engine.engine).toBe('native');

    // Equivalent results: the same entries survive, no new problems in either.
    const [a, b] = [await analyzeFile(cliOut), await analyzeFile(webOut)];
    expect(b.entries.map((e) => e.path)).toEqual(a.entries.map((e) => e.path));
    for (const r of [a, b]) expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Same video structure (checked independently with native ffprobe/ffmpeg).
    const [va, vb] = [nativeVideoCheck(await readEntry(cliOut, VIDEO_OUT)), nativeVideoCheck(await readEntry(webOut, VIDEO_OUT))];
    const shape = (v: ReturnType<typeof nativeVideoCheck>) => v.streams.map((s) => [s.codec_type, s.codec_name, s.width, s.height, s.pix_fmt].join(':'));
    expect(shape(vb)).toEqual(shape(va));
    expect(Math.abs(va.duration - vb.duration)).toBeLessThan(0.25);
    expect(va.decodeErrors + vb.decodeErrors).toBe('');
    // The video operation was applied by both engines.
    const videoStatus = (r: OptimizationReport) => r.operations.find((o) => o.op === 'transcode-video' && o.path === VIDEO)?.status;
    expect([videoStatus(cli), videoStatus(web)]).toEqual(['applied', 'applied']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
