#!/usr/bin/env bun
/**
 * Renders the social preview image (Open Graph / Twitter card, 1200×630)
 * into src/web/public/social-card.png: the app's name and a real capture of
 * its result step, taken by optimizing test/fixtures/elpx/legacy-folders.elpx
 * in headless Chromium against the built dist/web.
 *
 * Usage: bun run build:web && bun scripts/make-social-card.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createStaticServer } from '../src/cli/static-server.ts';

const root = join(import.meta.dir, '..');
const out = join(root, 'src', 'web', 'public', 'social-card.png');
const dataUri = (file: string, mime: string): string => `data:${mime};base64,${readFileSync(file).toString('base64')}`;

const server = createStaticServer({ root: join(root, 'dist', 'web'), host: '127.0.0.1', port: 0, base: '/', isolation: false });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
const browser = await chromium.launch();
try {
  // 1. A real capture of the result step.
  const app = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'es-ES' });
  await app.goto(url);
  await app.setInputFiles('#file-input', join(root, 'test', 'fixtures', 'elpx', 'legacy-folders.elpx'));
  await app.locator('#h-step2').waitFor();
  for (const id of ['opt-removeUnused', 'opt-deduplicate', 'opt-flatten', 'opt-missingReferences']) await app.locator(`#${id}`).check();
  await app.locator('form.options button[type=submit]').click();
  await app.locator('#h-step4').waitFor();
  await app.locator('.step-step4 .btn-primary').first().click();
  await app.locator('.saved-figure').waitFor({ timeout: 120_000 });
  await app.mouse.move(0, 0);
  const shot = await app.locator('.step-step6').screenshot({ animations: 'disabled' });

  // 2. The card.
  const font = dataUri(join(root, 'node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2'), 'font/woff2');
  const fontRegular = dataUri(join(root, 'node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2'), 'font/woff2');
  const feather = readFileSync(join(root, 'node_modules/bootstrap-icons/icons/feather.svg'), 'utf8');
  const ate = dataUri(join(root, 'src/web/assets/ate-logo.png'), 'image/png');
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await card.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: A; font-weight: 700; src: url(${font}) format('woff2'); }
    @font-face { font-family: A; font-weight: 400; src: url(${fontRegular}) format('woff2'); }
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; overflow: hidden; font-family: A, sans-serif; color: #fff;
      background: radial-gradient(circle at 85% 20%, #56629f 0, transparent 55%), #3f4c8a; position: relative; }
    .text { position: absolute; left: 72px; top: 72px; width: 560px; }
    .mark { display: inline-grid; place-items: center; width: 72px; height: 72px; border-radius: 18px; background: #fff; color: #3f4c8a; }
    .mark svg { width: 38px; height: 38px; }
    h1 { font-size: 92px; line-height: 1; letter-spacing: -0.03em; margin-top: 36px; }
    h2 { font-size: 40px; font-weight: 400; margin-top: 10px; opacity: .92; }
    p { font-size: 27px; line-height: 1.35; margin-top: 30px; opacity: .88; }
    .ate { position: absolute; left: 72px; bottom: 56px; display: flex; align-items: center; gap: 16px; font-size: 21px; opacity: .9; }
    .ate img { height: 46px; filter: brightness(0) invert(1); }
    .shot { position: absolute; left: 690px; top: 70px; width: 620px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 30px 60px rgba(12, 16, 40, .45); transform: rotate(-2.5deg); background: #fff; }
    .shot img { display: block; width: 100%; }
  </style></head><body>
    <div class="text">
      <span class="mark">${feather.replace('<svg', '<svg fill="currentColor"')}</span>
      <h1>Optimizador</h1>
      <h2>de proyectos eXeLearning</h2>
      <p>Aligera tus .elpx en el navegador: vídeo, imágenes y audio más ligeros, sin subir nada.</p>
    </div>
    <div class="ate"><img src="${ate}" alt=""><span>Área de Tecnología Educativa · Gobierno de Canarias</span></div>
    <div class="shot"><img src="data:image/png;base64,${shot.toString('base64')}" alt=""></div>
  </body></html>`);
  await card.evaluate(() => document.fonts.ready);
  const png = await card.screenshot({ type: 'png' });
  mkdirSync(join(root, 'src', 'web', 'public'), { recursive: true });
  writeFileSync(out, await sharp(png).png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toBuffer());
  console.log(`Social card written to ${out}`);
} finally {
  await browser.close();
  server.close();
}
