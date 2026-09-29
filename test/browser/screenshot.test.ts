import { describe, expect, it, vi } from 'vitest';
import { pngSize, screenshotProblem } from '../../src/core/format/screenshot.js';
import { packagePath, renderFirstPage, ScreenshotError, thumbnailFromImage, type ReadEntry } from '../../src/web/screenshot.js';

/** A PNG of one colour, made by the browser. */
async function solidPng(width: number, height: number, colour: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Colour of one pixel of a PNG. */
async function pixel(png: Blob, x: number, y: number): Promise<number[]> {
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}

function reader(files: Record<string, Blob | string>, log: string[] = []): ReadEntry {
  return (path) => {
    log.push(path);
    const f = files[path];
    return Promise.resolve(f === undefined ? undefined : typeof f === 'string' ? new Blob([f]) : f);
  };
}

describe('packagePath', () => {
  it.each([
    ['index.html', 'theme/style.css', 'theme/style.css'],
    ['theme/style.css', 'img/bg.png', 'theme/img/bg.png'],
    ['theme/style.css', '../content/a%20b.png?v=1#x', 'content/a b.png'],
    ['index.html', 'https://example.com/a.png', undefined],
    ['index.html', '//example.com/a.png', undefined],
    ['index.html', 'data:image/png;base64,AAAA', undefined],
    ['index.html', '#top', undefined],
    ['index.html', '', undefined],
    ['index.html', 'bad%E0%A4%A.png', undefined],
    // Backslashes are slashes to the URL parser: \\host/x names another host, not a package file.
    ['index.html', '\\\\example.com/a.png', undefined],
    ['css/a.css', '../../../../outside.png', 'outside.png'],
  ])('%s + %s → %s', (from, ref, expected) => {
    expect(packagePath(from, ref)).toBe(expected);
  });
});

describe('renderFirstPage', () => {
  it('draws index.html at 1280×720 with its style sheets and images, without running or fetching anything', async () => {
    const log: string[] = [];
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="theme/style.css">
      <script>document.title = 'ran'</script>
      </head><body>
      <nav id="siteNav" style="height:720px;background:#f00">navigation</nav>
      <main class="page"><img id="pic" src="content/resources/red.png" onerror="parent.hacked = true" width="200" height="100"></main>
      <img src="https://example.com/remote.png">
      </body></html>`;
    const png = await renderFirstPage(
      reader(
        {
          'index.html': html,
          'theme/style.css': 'body { margin: 0; background: url(img/bg.png) repeat; } @import url("https://example.com/x.css");',
          'theme/img/bg.png': await solidPng(8, 8, '#0000ff'),
          'content/resources/red.png': await solidPng(200, 100, '#00ff00'),
        },
        log,
      ),
    );
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect(pngSize(bytes)).toEqual({ width: 1280, height: 720 });
    expect(screenshotProblem(bytes)).toBeUndefined();
    // Navigation is hidden (eXeLearning's clean-up), the style sheet's background and the image show.
    expect(await pixel(png, 1200, 20)).toEqual([0, 0, 255, 255]);
    const green = await pixel(png, 100, 60);
    expect(green[1]).toBeGreaterThan(200);
    expect(green[0]).toBeLessThan(50);
    expect((globalThis as { hacked?: boolean }).hacked).toBeUndefined();
    expect(log.sort()).toEqual(['content/resources/red.png', 'index.html', 'theme/img/bg.png', 'theme/style.css']);
  });

  it('drops what is not in the package, reads only images and fonts, and inlines style attributes', async () => {
    const log: string[] = [];
    const html = `<html><head>
      <link rel="stylesheet" href="missing.css"><link rel="icon" href="favicon.ico"><link rel="stylesheet" href="https://example.com/x.css">
      <style>h1 { background: url('img/h.png') } p { background: url(nowhere.png) }</style>
      </head><body>
      <div style="width:1280px;height:720px;background:url(img/h.png)"></div>
      <img src="doc.pdf"><img src="gone.png"><img>
      </body></html>`;
    const png = await renderFirstPage(reader({ 'index.html': html, 'img/h.png': await solidPng(4, 4, '#ff0000'), 'doc.pdf': 'x' }, log));
    expect(await pixel(png, 640, 360)).toEqual([255, 0, 0, 255]);
    expect(log.sort()).toEqual(['gone.png', 'img/h.png', 'index.html', 'missing.css', 'nowhere.png']);
  });

  it('removes links that are not style sheets or have no address, and keeps empty style elements', async () => {
    const log: string[] = [];
    const html = '<html><head><link href="a.css"><link rel="stylesheet"><style></style></head><body></body></html>';
    const png = await renderFirstPage(reader({ 'index.html': html, 'a.css': 'body{}' }, log));
    expect(pngSize(new Uint8Array(await png.arrayBuffer()))).toEqual({ width: 1280, height: 720 });
    expect(log).toEqual(['index.html']);
  });

  it('reports a page the browser cannot draw or encode', async () => {
    const files = reader({ 'index.html': '<p>x</p>' });
    const decode = vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error(''));
    await expect(renderFirstPage(files)).rejects.toMatchObject({ code: 'render', message: 'The page could not be drawn' });
    decode.mockRestore();
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementationOnce((callback) => callback(null));
    await expect(renderFirstPage(files)).rejects.toMatchObject({ code: 'render', message: 'The browser could not encode the thumbnail' });
    toBlob.mockRestore();
  });

  it('draws a page whose text carries characters XML does not allow', async () => {
    const html = '<html><body style="margin:0;min-height:720px;background:#00ff00"><p>Pegado\u000B desde\u0008 Word\u0001</p></body></html>';
    const png = await renderFirstPage(reader({ 'index.html': html }));
    expect(await pixel(png, 640, 360)).toEqual([0, 255, 0, 255]);
  });

  it('draws a page whose comments hold "--", which XML does not allow', async () => {
    const html = '<html><body style="margin:0;min-height:720px;background:#00ff00"><!----comment node----><p>x</p></body></html>';
    const decode = vi.spyOn(HTMLImageElement.prototype, 'decode');
    const png = await renderFirstPage(reader({ 'index.html': html }));
    expect(decode).toHaveBeenCalledTimes(1);
    decode.mockRestore();
    expect(await pixel(png, 640, 360)).toEqual([0, 255, 0, 255]);
  });

  it('inlines the images of inline SVG (href and xlink:href) and drops those not in the package', async () => {
    const html = `<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1280" height="720">
      <image href="content/resources/a b.png" x="0" y="0" width="640" height="720"/>
      <image xlink:href="content/resources/a%20b.png" x="640" y="0" width="640" height="720"/>
      <image href="content/resources/gone.png" x="0" y="0" width="10" height="10"/></svg></body></html>`;
    const png = await renderFirstPage(reader({ 'index.html': html, 'content/resources/a b.png': await solidPng(8, 8, '#ff0000') }));
    expect(await pixel(png, 320, 360)).toEqual([255, 0, 0, 255]);
    expect(await pixel(png, 960, 360)).toEqual([255, 0, 0, 255]);
  });

  it('tries again without images when the page with them cannot be drawn', async () => {
    const log: string[] = [];
    const html = '<html><body style="margin:0;min-height:720px;background:#0000ff"><img src="a.png"></body></html>';
    const files = reader({ 'index.html': html, 'a.png': await solidPng(8, 8, '#ff0000') }, log);
    const decode = vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValueOnce(new Error('The source image cannot be decoded.'));
    const png = await renderFirstPage(files);
    decode.mockRestore();
    expect(await pixel(png, 640, 360)).toEqual([0, 0, 255, 255]);
    // The image was read once, for the first attempt only.
    expect(log.filter((p) => p === 'a.png')).toHaveLength(1);
  });

  it('needs index.html', async () => {
    await expect(renderFirstPage(reader({}))).rejects.toMatchObject({ code: 'no-page' });
  });
});

describe('thumbnailFromImage', () => {
  it('scales a 16:9 image down to fit 1280×720, as PNG', async () => {
    const png = await thumbnailFromImage(await solidPng(1920, 1080, '#123456'));
    expect(pngSize(new Uint8Array(await png.arrayBuffer()))).toEqual({ width: 1280, height: 720 });
  });

  it('keeps a smaller image at its size', async () => {
    const png = await thumbnailFromImage(await solidPng(800, 450, '#123456'));
    expect(pngSize(new Uint8Array(await png.arrayBuffer()))).toEqual({ width: 800, height: 450 });
  });

  it.each([
    ['ratio', 1000, 1000],
    ['ratio', 480, 270],
  ] as const)('refuses %s (%i×%i)', async (code, w, h) => {
    await expect(thumbnailFromImage(await solidPng(w, h, '#000'))).rejects.toMatchObject({ code });
  });

  it('refuses what is not an image, and images over 2 MB', async () => {
    await expect(thumbnailFromImage(new Blob(['not an image']))).rejects.toBeInstanceOf(ScreenshotError);
    await expect(thumbnailFromImage(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]))).rejects.toMatchObject({ code: 'too-large' });
  });
});
