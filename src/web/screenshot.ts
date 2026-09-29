import { SCREENSHOT_HEIGHT as HEIGHT, SCREENSHOT_WIDTH as WIDTH, screenshotRatioOk } from '../core/format/screenshot.js';

/**
 * A new project thumbnail (screenshot.png), made the way eXeLearning makes it
 * (public/app/yjs/YjsProjectBridge.js `generateScreenshotFromFirstPage`,
 * public/app/workarea/project/properties/formProperties.js), from the first
 * page or from an image chosen by the user.
 *
 * The first page is drawn as an SVG image (`<foreignObject>`) rather than in a
 * frame: an image never runs scripts and never loads anything from the
 * network, so the project's HTML is shown, not executed, and nothing leaves
 * the browser. Its style sheets, images and fonts are inlined from the package
 * as data: URLs; whatever is not in the package simply does not appear.
 */

/** Reads a file of the analyzed project (undefined when it does not exist). */
export type ReadEntry = (path: string) => Promise<Blob | undefined>;

/** Why a thumbnail could not be made; `code` selects the interface message. */
export class ScreenshotError extends Error {
  constructor(
    readonly code: 'no-page' | 'render' | 'unreadable' | 'too-large' | 'ratio',
    message: string,
  ) {
    super(message);
  }
}

/** Largest image accepted for upload, as in eXeLearning. */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

const MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/** eXeLearning's clean-up: only the content, without navigation, search or footer. */
const CLEANUP_CSS = `
#siteNav, .single-page-nav { display: none !important; }
.nav-buttons, .nav-button { display: none !important; }
#made-with-eXe { display: none !important; }
.exe-search-form, #exe-search-form, [id*="search"] form { display: none !important; }
#skipNav { display: none !important; }
.exe-pagination { display: none !important; }
.box-toggle { display: none !important; }
.exe-content { margin: 0 !important; padding: 16px !important; }
main.page, .exe-web-site main.page { padding-left: 16px !important; padding-right: 16px !important; max-width: 100% !important; }
#siteFooter, .exe-web-site #siteFooter { padding-left: 0 !important; display: none !important; }
body, .exe-content.exe-export { padding-left: 0 !important; padding-right: 0 !important; }
`;

/** The package path a relative reference in `from` points to, or undefined (absolute URLs, fragments, outside the package). */
export function packagePath(from: string, ref: string): string | undefined {
  const value = ref.trim();
  if (value === '' || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  const url = new URL(value, `https://package.invalid/${from}`);
  if (url.host !== 'package.invalid') return undefined;
  try {
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return undefined;
  }
}

/** Inlines the files of a package as data: URLs, each read once. */
class Inliner {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  constructor(private readonly read: ReadEntry) {}

  dataUrl(path: string): Promise<string | undefined> {
    let result = this.cache.get(path);
    if (!result) {
      result = this.load(path);
      this.cache.set(path, result);
    }
    return result;
  }

  private async load(path: string): Promise<string | undefined> {
    const mime = MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
    const blob = mime ? await this.read(path) : undefined;
    if (!blob) return undefined;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(new Blob([blob], { type: mime }));
    });
  }

  /** Replaces url(…) in CSS read from `from` with data: URLs; @import rules are dropped. */
  async css(text: string, from: string): Promise<string> {
    const out = text.replace(/@import[^;]*;/gi, '');
    const urls = [...out.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)];
    const inlined = await Promise.all(urls.map((m) => this.pathData(from, m[2]!)));
    let i = 0;
    return out.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (match) => {
      const data = inlined[i++];
      return data ? `url("${data}")` : match;
    });
  }

  private pathData(from: string, ref: string): Promise<string | undefined> {
    const path = packagePath(from, ref);
    return path === undefined ? Promise.resolve(undefined) : this.dataUrl(path);
  }

  /** Inlines style sheets, images and style attributes of a page read from `from`. */
  async page(doc: Document, from: string): Promise<void> {
    for (const el of doc.querySelectorAll('script, noscript, base, meta, iframe, object, embed')) el.remove();
    const jobs: Promise<void>[] = [];
    for (const link of doc.querySelectorAll('link')) {
      const href = link.getAttribute('href');
      const path = href === null ? undefined : packagePath(from, href);
      const blob = /\bstylesheet\b/i.test(link.getAttribute('rel') ?? '') && path !== undefined ? this.read(path) : undefined;
      jobs.push(
        (async () => {
          const sheet = await blob;
          if (sheet && path !== undefined) {
            const style = doc.createElement('style');
            style.textContent = await this.css(await sheet.text(), path);
            link.replaceWith(style);
          } else link.remove();
        })(),
      );
    }
    for (const style of doc.querySelectorAll('style')) jobs.push(this.css(style.textContent ?? '', from).then((t) => void (style.textContent = t)));
    for (const el of doc.querySelectorAll('[style]')) {
      jobs.push(this.css(el.getAttribute('style')!, from).then((t) => el.setAttribute('style', t)));
    }
    for (const img of doc.querySelectorAll('img')) {
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
      const src = img.getAttribute('src');
      if (src !== null) jobs.push(this.pathData(from, src).then((data) => (data ? img.setAttribute('src', data) : img.removeAttribute('src'))));
    }
    await Promise.all(jobs);
  }
}

/** Draws an image into a white canvas of the given size and returns it as PNG. */
async function toPng(image: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new ScreenshotError('render', 'The browser could not encode the thumbnail');
  return blob;
}

/** Draws the first page (index.html) of the package at 1280×720, as eXeLearning does. */
export async function renderFirstPage(read: ReadEntry): Promise<Blob> {
  const html = await read('index.html');
  if (!html) throw new ScreenshotError('no-page', 'The package has no index.html');
  // A parsed document is inert: nothing in it runs or loads.
  const doc = new DOMParser().parseFromString(await html.text(), 'text/html');
  await new Inliner(read).page(doc, 'index.html');
  const cleanup = doc.createElement('style');
  cleanup.textContent = CLEANUP_CSS;
  doc.head.append(cleanup);
  const xhtml = new XMLSerializer().serializeToString(doc.documentElement);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><foreignObject x="0" y="0" width="${WIDTH}" height="${HEIGHT}">${xhtml}</foreignObject></svg>`;
  try {
    const image = new Image(WIDTH, HEIGHT);
    // A data: URL, not blob:, which Chromium treats as cross-origin for a <foreignObject> and taints the canvas.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    return await toPng(image, WIDTH, HEIGHT);
  } catch (error) {
    throw error instanceof ScreenshotError ? error : new ScreenshotError('render', (error as Error).message || 'The page could not be drawn');
  }
}

/** Turns an image chosen by the user into a thumbnail: 16:9, at least 600 px wide, scaled to fit 1280×720. */
export async function thumbnailFromImage(file: Blob): Promise<Blob> {
  if (file.size > UPLOAD_MAX_BYTES) throw new ScreenshotError('too-large', 'The image is larger than 2 MB');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ScreenshotError('unreadable', 'The browser cannot read this image');
  }
  try {
    const { width, height } = bitmap;
    if (!screenshotRatioOk(width, height)) throw new ScreenshotError('ratio', `${width}×${height} is not 16:9 with at least 600 px of width`);
    const scale = Math.min(1, WIDTH / width, HEIGHT / height);
    return await toPng(bitmap, Math.round(width * scale), Math.round(height * scale));
  } finally {
    bitmap.close();
  }
}
