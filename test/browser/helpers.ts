import type { ImageCapabilities, ImageJob } from '../../src/core/media/image-policy.js';
import { decideImage } from '../../src/core/media/image-policy.js';
import { inspectImage } from '../../src/core/media/image-inspect.js';
import { BROWSER_LIMITS } from '../../src/core/limits.js';
import { normalizeOptions, type OptionsInput } from '../../src/core/plan/options.js';

/** Fetches a fixture served by Vite (imported with `?url`) as bytes. */
export async function fixtureBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Fetches a fixture as a File with the given name. */
export async function fixtureFile(url: string, name: string): Promise<File> {
  return new File([(await fixtureBytes(url)) as Uint8Array<ArrayBuffer>], name);
}

const IMAGE_CAPS: ImageCapabilities = { available: true, encoders: { jpeg: 'jsquash', png: 'jsquash', webp: 'jsquash' }, canResize: true };

/** Builds the job the core would plan for an image (forced, so efficient sources are still encoded). */
export function imageJobFor(bytes: Uint8Array, format: 'jpeg' | 'png' | 'webp', images: NonNullable<OptionsInput['images']> = {}): ImageJob {
  const options = normalizeOptions({ images: { force: true, ...images } }).images;
  const decision = decideImage(
    { format, size: bytes.length, info: inspectImage(bytes, format), extensionMatches: true, resolutionSensitive: false },
    options,
    IMAGE_CAPS,
    BROWSER_LIMITS,
  );
  if (decision.action !== 'encode') throw new Error(`image not encodable: ${decision.detail}`);
  return decision.job;
}

/** Encodes a solid, fully opaque PNG of the given size with the browser's canvas. */
export async function opaquePng(width: number, height: number, color = '#3366cc'): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/** Resolves after the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls a condition until it holds (or fails after the timeout). */
export async function waitFor(condition: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}
