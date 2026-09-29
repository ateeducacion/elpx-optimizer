import { expect, test, type Page, type Request } from '@playwright/test';
import { join } from 'node:path';
import { strFromU8 } from 'fflate';
import {
  assertOnlyStaticRequests,
  analyzeFile,
  dropFile,
  E2E_FIXTURES,
  FIXTURES,
  nativeVideoCheck,
  qpdfCli,
  readEntry,
  recordRequests,
  sha256File,
  ui,
  zipEntries,
} from './helpers.js';

/**
 * The static web app recompresses videos in the browser with ffmpeg.wasm.
 * Every download is re-opened in Node and checked with independent native
 * tools (ffprobe/ffmpeg); native FFmpeg never processes anything for the page.
 */

const COURSE = join(FIXTURES, 'elpx', 'course-video.elpx');
const EFFICIENT = join(FIXTURES, 'elpx', 'efficient.elpx');
const LEGACY = join(FIXTURES, 'elpx', 'legacy-folders.elpx');
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

/** Keeps the original file names (clean names are on by default), for checks that read entries by name. */
async function keepFileNames(page: Page): Promise<void> {
  await expect(ui.cleanNames(page)).toBeChecked();
  await ui.cleanNames(page).uncheck();
}

type OutputInfo = { outputPath: (n: string) => string };

/** Runs the confirmed plan; returns the downloaded file path. */
async function runDownload(page: Page, testInfo: OutputInfo, expectStatus = /optimizado|optimized/i): Promise<{ path: string; name: string }> {
  await ui.optimize(page).click();
  await expect(page.locator('.result-status')).toHaveText(expectStatus, { timeout: 280_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  return { path, name: download.suggestedFilename() };
}

/** Reviews the plan and runs it; returns the downloaded file path. */
async function planRunDownload(page: Page, testInfo: OutputInfo, expectStatus?: RegExp): Promise<{ path: string; name: string }> {
  await ui.reviewPlan(page).click();
  await expect(ui.planHeading(page)).toBeVisible();
  return runDownload(page, testInfo, expectStatus);
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
  await keepFileNames(page);

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

  // The footer links elsewhere, but nothing is ever requested from another origin.
  await expect(page.getByRole('link', { name: /^(Código fuente en GitHub|Source code on GitHub)/ })).toHaveAttribute(
    'href',
    'https://github.com/ateeducacion/elpx-optimizer',
  );
  await expect(page.locator('footer a[target="_blank"]')).toHaveCount(2);
  expect(assertOnlyStaticRequests(requests, 'http://127.0.0.1:4173', '/')).toEqual([]);
});

test('serves from a subdirectory and loads the WASM engine from there', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await page.goto('http://127.0.0.1:4174/tools/elpx/');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await keepFileNames(page);
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
  await keepFileNames(page);
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

test('optimizes PDFs with qpdf in a worker, keeping signed ones as they are @cross-browser', async ({ page }, testInfo) => {
  const course = join(E2E_FIXTURES, 'pdf-course.elpx');
  const requests = recordRequests(page);
  await page.goto('/');
  await page.setInputFiles('#file-input', course);
  await waitForReview(page);
  await expect(page.locator('.inventory')).toContainText(/2 páginas|2 pages/);
  await expect(page.locator('.inventory')).toContainText(/firmado|signed/);
  await ui.reviewPlan(page).click();
  await expect(page.locator('.plan-group')).toContainText(/PDF a optimizar|PDFs to optimize/);
  await expect(page.locator('.plan-skipped')).toContainText('firmado.pdf');
  const { path } = await runDownload(page, testInfo);

  const original = await readEntry(course, 'content/resources/ficha.pdf');
  const pdf = await readEntry(path, 'content/resources/ficha.pdf');
  expect(pdf.length).toBeLessThan(original.length / 10);
  expect(qpdfCli(pdf, ['--check', '/in.pdf'])).toContain('No syntax or stream encoding errors');
  expect(qpdfCli(pdf, ['--show-npages', '/in.pdf']).trim()).toBe('2');
  const signed = await readEntry(path, 'content/resources/firmado.pdf');
  expect(Buffer.from(signed).equals(Buffer.from(await readEntry(course, 'content/resources/firmado.pdf')))).toBe(true);
  expect((await analyzeFile(path)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(requests.some((r) => /\/assets\/qpdf-[^/]*\.wasm$/.test(r.url()))).toBe(true);
  expect(assertOnlyStaticRequests(requests, 'http://127.0.0.1:4173', '/')).toEqual([]);
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
  await ui.reviewPlan(page).click();
  await ui.optimize(page).click();
  await expect(page.locator('.progress-text')).toContainText(/Recodificando|Re-encoding/, { timeout: 120_000 });
  await expect(page.locator('.progress-text')).toContainText(/ de | of /);
  const started = Date.now();
  await ui.cancel(page).click();
  await expect(page.locator('.step-error')).toContainText(/Cancelado|Cancelled/, { timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(10_000);
  // The same page, a new project.
  await ui.startOver(page).click();
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await keepFileNames(page);
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
  await keepFileNames(page);
  const { path } = await planRunDownload(page, testInfo);
  expect((await readEntry(path, VIDEO_ENTRY)).length).toBeLessThan((await readEntry(COURSE, VIDEO_ENTRY)).length);
});

test('a video above the memory/size limit is kept as original', async ({ page }, testInfo) => {
  await page.goto('/?maxVideoMiB=1');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await keepFileNames(page);
  await ui.reviewPlan(page).click();
  await expect(page.locator('.plan-skipped')).toContainText('clase 1.mp4');
  await ui.optimize(page).click();
  await expect(page.locator('.result-status')).toBeVisible({ timeout: 120_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const path = testInfo.outputPath('limited.elpx');
  await download.saveAs(path);
  expect(Buffer.from(await readEntry(path, VIDEO_ENTRY)).equals(Buffer.from(await readEntry(COURSE, VIDEO_ENTRY)))).toBe(true);
});

test('keeps working with the network blocked once the components are loaded', async ({ page, context }, testInfo) => {
  const pdfCourse = join(E2E_FIXTURES, 'pdf-course.elpx');
  await page.goto('/');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await planRunDownload(page, testInfo);
  // qpdf is loaded by a project with PDFs.
  await ui.another(page).click();
  await page.setInputFiles('#file-input', pdfCourse);
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
  await ui.another(page).click();
  await page.setInputFiles('#file-input', EFFICIENT);
  await waitForReview(page);
  await planRunDownload(page, testInfo, /No se ha conseguido|could not be reduced/);
  // Every qpdf run loads the module again: from the browser's cache.
  await ui.another(page).click();
  await page.setInputFiles('#file-input', pdfCourse);
  await waitForReview(page);
  await expect(page.locator('.inventory')).toContainText(/2 páginas|2 pages/);
  const { path } = await planRunDownload(page, testInfo);
  expect((await readEntry(path, 'content/resources/ficha.pdf')).length).toBeLessThan((await readEntry(pdfCourse, 'content/resources/ficha.pdf')).length / 10);
  expect(failed.filter((u) => !u.startsWith('blob:'))).toEqual([]);
  expect(network).toEqual([]);
});

test('uses the multi-thread core when the server enables cross-origin isolation', async ({ page }, testInfo) => {
  await page.goto('http://127.0.0.1:4175/');
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  await expect(page.locator('.engine-line')).toContainText(/varios hilos|multi-thread/);
  await keepFileNames(page);
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
  // The file button is reached with Tab, right after the header controls.
  const choose = ui.chooseFile(page);
  for (let i = 0; i < 8 && !(await choose.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(choose).toBeFocused();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles(COURSE);
  await waitForReview(page);
  await expect(page.locator('#h-step2')).toBeFocused();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await ui.reviewPlan(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#h-step4')).toBeFocused();
});

test('flattens eXeLearning 3 folders and takes out broken references @cross-browser', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', LEGACY);
  await waitForReview(page);
  await expect(page.getByTestId('legacy-alert')).toContainText(/Carpetas de eXeLearning 3|eXeLearning 3 folders/);
  await expect(page.getByTestId('broken-alert')).toContainText(/Referencias a archivos que no existen|References to files that do not exist/);
  const flatten = page.getByRole('switch', { name: /^(Aplanar carpetas de eXeLearning 3|Flatten eXeLearning 3 folders)$/ });
  const unlink = page.getByRole('switch', { name: /^(Quitar referencias rotas|Remove broken references)$/ });
  await expect(flatten).not.toBeChecked();
  await expect(unlink).not.toBeChecked();
  await flatten.check();
  await unlink.check();
  // With the default clean names, a second file with the same name becomes name-2 (not name_2).
  await expect(ui.cleanNames(page)).toBeChecked();
  await ui.reviewPlan(page).click();
  await expect(ui.planHeading(page)).toBeVisible();
  await expect(page.locator('.stepper-item.is-current')).toContainText(/Plan/);
  const plan = page.locator('.plan-ops');
  await expect(plan).toContainText(/Archivos a mover|Files to move/);
  await expect(plan).toContainText('content/resources/foto-2.jpg');
  await expect(plan).toContainText(/Archivos ausentes cuyas referencias se quitan|Missing files whose references are removed/);
  await expect(plan).toContainText('borrada.jpg');
  const { path } = await runDownload(page, testInfo);
  await expect(page.locator('.op-results')).toContainText('foto-2.jpg');

  // The downloaded ZIP, read with fflate: no editor folders left, renamed files in place.
  const files = zipEntries(path);
  const names = Object.keys(files);
  expect(names.filter((n) => /^content\/resources\/\d{14}[A-Za-z0-9]{6}\//.test(n))).toEqual([]);
  expect(names).toContain('content/resources/foto-2.jpg');
  expect(names).toContain('content/resources/foto.jpg');
  expect(names).toContain('content/resources/mis fotos/playa.jpg');
  const xml = strFromU8(files['content.xml']!);
  expect(xml).not.toContain('borrada.jpg');
  expect(xml).not.toContain('apuntes.pdf');
  // The link keeps its text.
  expect(xml).toContain('<a>Apuntes</a>');
  expect(xml).toContain('{{context_path}}/content/resources/foto-2.jpg');
  const analysis = await analyzeFile(path);
  expect(analysis.ok).toBe(true);
  expect(analysis.package?.legacyFolders).toEqual({ folders: 0, files: 0 });
  expect(analysis.diagnostics.filter((d) => d.severity === 'error' || d.code === 'missing-resource')).toEqual([]);
});

test('follows the system colour scheme @cross-browser', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-bs-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(18, 21, 31)');
  // A change while the page is open is followed too.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-bs-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(243, 244, 248)');
});

test('previews an image and a video of the project in the browser', async ({ page }) => {
  const requests = recordRequests(page);
  await page.goto('/');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  // The image is read from the project in the worker and shown in a modal window.
  await page.getByRole('button', { name: /^(Ver la imagen|View the image) fotos\/foto&paisaje\.jpg$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'fotos/foto&paisaje.jpg' });
  await expect(dialog).toBeVisible();
  const img = dialog.getByRole('img', { name: 'fotos/foto&paisaje.jpg' });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: /^(Cerrar|Close)$/ }).click();
  await expect(dialog).toHaveCount(0);
  // The video plays in the page's own <video>.
  await page.getByRole('button', { name: /^(Ver el vídeo|Watch the video) media\/clase 1\.mp4$/ }).click();
  const player = page.getByRole('dialog', { name: 'media/clase 1.mp4' });
  await expect(player).toContainText('640×360');
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(player).toHaveCount(0);
  // Previews use blob: URLs only.
  expect(assertOnlyStaticRequests(requests, 'http://127.0.0.1:4173', '/')).toEqual([]);
});

test('the licenses panel links texts served by the site itself', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^(Licencias|Licenses)$/ }).click();
  const panel = page.getByRole('dialog', { name: /Licencias y créditos|Licenses and credits/ });
  await expect(panel).toBeVisible();
  const hrefs = await panel.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')!));
  const local = hrefs.filter((href) => !/^https?:/.test(href));
  expect(local.length).toBeGreaterThan(10);
  for (const href of local) {
    const response = await request.get(href);
    expect(response.status(), href).toBe(200);
    expect((await response.text()).length, href).toBeGreaterThan(100);
  }
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('re-encodes audio: WAV, FLAC and AIFF become MP3 with their references and types rewritten @cross-browser', async ({ page }, testInfo) => {
  const AUDIO = join(FIXTURES, 'elpx', 'audio-course.elpx');
  const A = 'content/resources/audio';
  await page.goto('/');
  await page.setInputFiles('#file-input', AUDIO);
  await waitForReview(page);
  // Audio rows are described and can be excluded like images and videos.
  await expect(page.locator('.inventory')).toContainText('pcm_s16le');
  await expect(page.locator('.inventory')).toContainText(/estéreo|stereo|mono/);
  await expect(page.getByRole('switch', { name: /^(Optimizar|Optimize) content\/resources\/audio\/lectura\.wav$/ })).toBeChecked();
  await ui.reviewPlan(page).click();
  await expect(ui.planHeading(page)).toBeVisible();
  const plan = page.locator('.plan-ops');
  await expect(plan).toContainText(/Audios a recomprimir|Audio to recompress/);
  await expect(plan).toContainText('audio/lectura.wav → audio/lectura.mp3');
  await expect(page.locator('.risks')).toContainText(/pasan a MP3 con extensión \.mp3|become MP3 with the \.mp3 extension/);
  // A file a script names cannot be renamed safely: it is left as is.
  await expect(page.locator('.plan-skipped')).toContainText('audio/codigo.wav');
  const { path } = await runDownload(page, testInfo);

  const files = zipEntries(path);
  const names = Object.keys(files).filter((n) => n.startsWith(`${A}/`));
  expect(names.sort()).toEqual([`${A}/alta.mp3`, `${A}/codigo.wav`, `${A}/lectura.mp3`, `${A}/musica.mp3`, `${A}/pista.mp3`]);
  const xml = strFromU8(files['content.xml']!);
  expect(xml).toContain(`src="{{context_path}}/${A}/lectura.mp3" type="audio/mpeg"`);
  expect(xml).toContain(`<source src="{{context_path}}/${A}/musica.mp3" type="audio/mpeg">`);
  expect(xml).toContain(`<a href="{{context_path}}/${A}/pista.mp3">Pista</a>`);
  expect(xml).toContain(`"audio":"{{context_path}}/${A}/lectura.mp3"`);
  expect(xml).not.toMatch(/type="audio\/(wav|flac|aiff)"/);
  expect(xml).toContain(`var extra = "${A}/codigo.wav";`);
  // Each new file is real MP3 audio (checked with native ffprobe/ffmpeg), smaller than its source.
  for (const [name, source] of [
    ['lectura.mp3', 'lectura.wav'],
    ['musica.mp3', 'musica.flac'],
    ['pista.mp3', 'pista.aiff'],
    ['alta.mp3', 'alta.mp3'],
  ]) {
    const check = nativeVideoCheck(files[`${A}/${name}`]!);
    expect(
      check.streams.map((s) => `${s.codec_type}:${s.codec_name}`),
      name,
    ).toEqual(['audio:mp3']);
    expect(check.decodeErrors, name).toBe('');
    expect(files[`${A}/${name}`]!.length, name).toBeLessThan((await readEntry(AUDIO, `${A}/${source}`)).length);
  }
  const analysis = await analyzeFile(path);
  expect(analysis.ok).toBe(true);
  expect(analysis.diagnostics.filter((d) => d.severity === 'error' || d.code === 'missing-resource')).toEqual([]);
});

test('cleans file names by default and rewrites every reference @cross-browser', async ({ page }, testInfo) => {
  const R = 'content/resources';
  await page.goto('/');
  await page.setInputFiles('#file-input', COURSE);
  await waitForReview(page);
  // On by default, with how many names change and an example.
  await expect(ui.cleanNames(page)).toBeChecked();
  await expect(page.locator('form.options')).toContainText(/4 archivos tendrán un nombre limpio|4 files will get a clean name/);
  await page.getByLabel(/Quitar archivos sin ninguna referencia|Remove files with no reference/).check();
  await page.getByLabel(/Unificar archivos idénticos|Merge identical files/).check();
  await ui.reviewPlan(page).click();
  const plan = page.locator('.plan-ops');
  await expect(plan).toContainText(/Archivos con nombre limpio|Files with a clean name/);
  await expect(plan).toContainText('media/clase 1.mp4 → media/clase-1.mp4');
  await expect(page.locator('.risks')).toContainText(/nombre limpio|clean name/);
  const { path } = await runDownload(page, testInfo);

  const files = zipEntries(path);
  const names = Object.keys(files).filter((n) => n.startsWith(`${R}/`) && !n.endsWith('/'));
  for (const clean of [`${R}/media/clase-1.mp4`, `${R}/media/clase-1.vtt`, `${R}/fotos/foto-paisaje.jpg`]) expect(names).toContain(clean);
  // Every remaining user file has a clean name.
  expect(names.filter((n) => /[^a-z0-9._-]/.test(n.slice(n.lastIndexOf('/') + 1)))).toEqual([]);
  const xml = strFromU8(files['content.xml']!);
  expect(xml).not.toContain('clase 1.mp4');
  expect(xml).not.toContain('foto&amp;paisaje.jpg');
  expect(xml).toContain(`{{context_path}}/${R}/media/clase-1.mp4`);
  expect(xml).toContain(`{{context_path}}/${R}/media/clase-1.vtt`);
  const analysis = await analyzeFile(path);
  expect(analysis.ok).toBe(true);
  expect(analysis.diagnostics.filter((d) => d.severity === 'error' || d.code === 'missing-resource' || d.code === 'manifest-stale')).toEqual([]);
  // The video under its new name is still the recompressed one.
  expect(files[`${R}/media/clase-1.mp4`]!.length).toBeLessThan((await readEntry(COURSE, VIDEO_ENTRY)).length);
});
