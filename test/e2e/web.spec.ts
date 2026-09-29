import { expect, test, type Page, type Request } from '@playwright/test';
import { join } from 'node:path';
import { assertOnlyStaticRequests, analyzeFile, dropFile, E2E_FIXTURES, FIXTURES, nativeVideoCheck, readEntry, recordRequests, sha256File } from './helpers.js';

/**
 * The static web app recompresses videos in the browser with ffmpeg.wasm.
 * Every download is re-opened in Node and checked with independent native
 * tools (ffprobe/ffmpeg); native FFmpeg never processes anything for the page.
 */

const COURSE = join(FIXTURES, 'elpx', 'course-video.elpx');
const EFFICIENT = join(FIXTURES, 'elpx', 'efficient.elpx');
const VIDEO_ENTRY = 'content/resources/media/clase 1.mp4';

/** True when a finished request was served from the browser cache (no network transfer). */
async function isFromCache(r: Request): Promise<boolean> {
  const sizes = await r.sizes().catch(() => undefined);
  return sizes !== undefined && sizes.responseHeadersSize <= 0;
}

/** Waits for the review step after selecting a file. */
async function waitForReview(page: Page): Promise<void> {
  await expect(page.locator('.inventory')).toBeVisible({ timeout: 180_000 });
}

/** Reviews the plan and runs it; returns the downloaded file path. */
async function planRunDownload(
  page: Page,
  testInfo: { outputPath: (n: string) => string },
  expectStatus = /optimizado|optimized/i,
): Promise<{ path: string; name: string }> {
  await page.locator('form.options button[type=submit]').click();
  await expect(page.locator('.step-step4')).toBeVisible();
  await page.locator('.step-step4 .button.primary').click();
  await expect(page.locator('.result-status')).toHaveText(expectStatus, { timeout: 280_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  return { path, name: download.suggestedFilename() };
}

test('recompresses the video in the browser: single-thread, no isolation, no uploads @cross-browser', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await page.goto('/');
  const env = await page.evaluate(() => ({ isolated: globalThis.crossOriginIsolated, sab: typeof SharedArrayBuffer }));
  expect(env).toEqual({ isolated: false, sab: 'undefined' });
  await dropFile(page, COURSE, 'course-video.elpx');
  await waitForReview(page);
  await expect(page.locator('.inventory')).toContainText('clase 1.mp4');
  await expect(page.locator('.inventory')).toContainText('h264 640×360');
  await expect(page.locator('.engine-line')).toContainText(/un hilo|single-thread/);

  const { path, name } = await planRunDownload(page, testInfo);
  expect(name).toBe('course-video_optimized.elpx');

  // Independent verification of the downloaded package.
  const original = await readEntry(COURSE, VIDEO_ENTRY);
  const video = await readEntry(path, VIDEO_ENTRY);
  expect(video.length).toBeLessThan(original.length / 2);
  const before = nativeVideoCheck(original);
  const after = nativeVideoCheck(video);
  expect(before.streams.find((s) => s.codec_type === 'video')?.profile).toMatch(/4:4:4/);
  const v = after.streams.find((s) => s.codec_type === 'video')!;
  expect(v).toMatchObject({ codec_name: 'h264', width: 640, height: 360, pix_fmt: 'yuv420p' });
  expect(v.profile).toBe('High');
  expect(after.streams.map((s) => s.codec_type)).toEqual(['video', 'audio']);
  expect(Math.abs(after.duration - before.duration)).toBeLessThan(0.25);
  expect(after.decodeErrors).toBe('');

  const analysis = await analyzeFile(path);
  expect(analysis.ok).toBe(true);
  expect(analysis.diagnostics.filter((d) => d.severity === 'error' || d.code === 'manifest-stale' || d.code === 'lenient-resolution')).toEqual([]);
  // The editable project is untouched: same content.xml bytes, same pages and iDevices.
  expect(Buffer.from(await readEntry(path, 'content.xml')).equals(Buffer.from(await readEntry(COURSE, 'content.xml')))).toBe(true);
  expect(analysis.package).toMatchObject({ pages: 2, components: 5, variant: 'v4' });

  expect(assertOnlyStaticRequests(requests, 'http://127.0.0.1:4173', '/')).toEqual([]);
});

test('serves from a subdirectory and loads the WASM engine from there', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await page.goto('http://127.0.0.1:4174/tools/elpx/');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  const { path } = await planRunDownload(page, testInfo);
  expect((await readEntry(path, VIDEO_ENTRY)).length).toBeLessThan((await readEntry(COURSE, VIDEO_ENTRY)).length);
  expect(requests.some((r) => /\/tools\/elpx\/assets\/ffmpeg-core-.*\.wasm$/.test(r.url()))).toBe(true);
  expect(assertOnlyStaticRequests(requests, 'http://127.0.0.1:4174', '/tools/elpx/')).toEqual([]);
});

test('merges duplicates and removes unused files with rewritten references', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await page.getByLabel(/Quitar archivos sin ninguna referencia|Remove files with no reference/).check();
  await page.getByLabel(/Unificar archivos idénticos|Merge identical files/).check();
  const { path } = await planRunDownload(page, testInfo);
  const analysis = await analyzeFile(path);
  const names = analysis.entries.map((e) => e.path);
  expect(names).not.toContain('content/resources/sin-uso/viejo.webp');
  expect(names).not.toContain('content/resources/fotos/copia-foto.jpg');
  expect(names).not.toContain('content/resources/juego/diapositiva.png');
  expect(analysis.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const xml = new TextDecoder().decode(await readEntry(path, 'content.xml'));
  expect(xml).not.toContain('copia-foto.jpg');
  expect(xml).toContain('{{context_path}}/content/resources/fotos/foto&paisaje.jpg" alt="Copia"');
  const manifest = new TextDecoder().decode(await readEntry(path, 'libs/elpx-manifest.js'));
  expect(manifest).not.toContain('viejo.webp');
});

test('an input without improvement is delivered byte for byte @cross-browser', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', EFFICIENT);
  await waitForReview(page);
  const { path, name } = await planRunDownload(page, testInfo, /No se ha conseguido|could not be reduced/);
  expect(name).toBe('efficient_optimized.elpx');
  expect(sha256File(path)).toBe(sha256File(EFFICIENT));
});

test('cancelling stops the codec and a second optimization works without reloading', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', join(E2E_FIXTURES, 'long-video.elpx'));
  await waitForReview(page);
  await page.locator('form.options button[type=submit]').click();
  await page.locator('.step-step4 .button.primary').click();
  await expect(page.locator('.progress-text')).toContainText(/Recodificando|Re-encoding/, { timeout: 120_000 });
  await expect(page.locator('.progress-text')).toContainText(/ de | of /);
  const started = Date.now();
  await page.locator('.button.danger').click();
  await expect(page.locator('.step-error')).toContainText(/Cancelado|Cancelled/, { timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(10_000);
  // The same page, a new project.
  await page.getByRole('button', { name: /Volver a empezar|Start over/ }).click();
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  const { path } = await planRunDownload(page, testInfo);
  expect((await readEntry(path, VIDEO_ENTRY)).length).toBeLessThan((await readEntry(COURSE, VIDEO_ENTRY)).length);
});

test('a failing engine load is reported, and a retry works in the same page', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.route(/ffmpeg-core-[^/]*\.wasm$/, (route) => route.abort());
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await expect(page.locator('.engine-line')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('.inventory')).toContainText(/sin inspeccionar|not inspected/);
  await page.unroute(/ffmpeg-core-[^/]*\.wasm$/);
  await page.evaluate(() => (window as unknown as { elpxApp: { reset(): void } }).elpxApp.reset());
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await expect(page.locator('.inventory')).toContainText('h264 640×360');
  const { path } = await planRunDownload(page, testInfo);
  expect((await readEntry(path, VIDEO_ENTRY)).length).toBeLessThan((await readEntry(COURSE, VIDEO_ENTRY)).length);
});

test('a video above the memory/size limit is kept as original', async ({ page }, testInfo) => {
  await page.goto('/?maxVideoMiB=1');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await page.locator('form.options button[type=submit]').click();
  await expect(page.locator('.plan-skipped')).toContainText('clase 1.mp4');
  await page.locator('.step-step4 .button.primary').click();
  await expect(page.locator('.result-status')).toBeVisible({ timeout: 120_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const path = testInfo.outputPath('limited.elpx');
  await download.saveAs(path);
  expect(Buffer.from(await readEntry(path, VIDEO_ENTRY)).equals(Buffer.from(await readEntry(COURSE, VIDEO_ENTRY)))).toBe(true);
});

test('keeps working with the network blocked once the components are loaded', async ({ page, context }, testInfo) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await planRunDownload(page, testInfo);
  // Real offline mode (page.route would disable the HTTP cache, which a real offline visit keeps):
  // workers restarted for the second job may only use the static files already cached.
  const failed: string[] = [];
  const network: string[] = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('requestfinished', async (r) => {
    const response = await r.response();
    if (response && !response.fromServiceWorker() && !r.url().startsWith('blob:') && !(await isFromCache(r))) network.push(r.url());
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: /Optimizar otro proyecto|Optimize another project/ }).click();
  await page.setInputFiles('#file-input', EFFICIENT);
  await waitForReview(page);
  await planRunDownload(page, testInfo, /No se ha conseguido|could not be reduced/);
  expect(failed.filter((u) => !u.startsWith('blob:'))).toEqual([]);
  expect(network).toEqual([]);
});

test('uses the multi-thread core when the server enables cross-origin isolation', async ({ page }, testInfo) => {
  await page.goto('http://127.0.0.1:4175/');
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await expect(page.locator('.engine-line')).toContainText(/varios hilos|multi-thread/);
  const { path } = await planRunDownload(page, testInfo);
  const video = await readEntry(path, VIDEO_ENTRY);
  expect(video.length).toBeLessThan((await readEntry(COURSE, VIDEO_ENTRY)).length / 2);
  expect(nativeVideoCheck(video).decodeErrors).toBe('');
});

test('rejects a legacy .elp with a concrete message', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', join(FIXTURES, 'upstream', 'verdaderofalso.elp'));
  await expect(page.locator('.step-error')).toContainText(/eXeLearning/);
  await expect(page.locator('.step-error')).toContainText(/\.elpx/);
});

test('is usable with the keyboard and fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('label[for=file-input]')).toBeFocused();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles(COURSE);
  await waitForReview(page);
  await expect(page.locator('#h-step2')).toBeFocused();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('form.options button[type=submit]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#h-step4')).toBeFocused();
});
