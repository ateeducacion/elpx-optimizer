import { describe, expect, it } from 'vitest';
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
