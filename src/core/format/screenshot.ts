/**
 * The project thumbnail, screenshot.png. eXeLearning generates it from the first page at 1280×720
 * and accepts an uploaded image with a 16:9 ratio and at least 600 px of width, scaled to fit
 * 1280×720 (public/app/yjs/YjsProjectBridge.js `_captureHtmlAsScreenshot`,
 * public/app/workarea/project/properties/formProperties.js `resizeAndConvertToPng`). A replacement
 * given to elpx-optimizer follows the same rules.
 */

export const SCREENSHOT_PATH = 'screenshot.png';
export const SCREENSHOT_WIDTH = 1280;
export const SCREENSHOT_HEIGHT = 720;
export const SCREENSHOT_MIN_WIDTH = 600;
/** Largest replacement accepted (a 1280×720 PNG of a busy page is well under this). */
export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk, or undefined when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** True when an image of this size is 16:9 and wide enough to become a thumbnail. */
export function screenshotRatioOk(width: number, height: number): boolean {
  return width >= SCREENSHOT_MIN_WIDTH && height > 0 && Math.abs(width / height - 16 / 9) < 0.05;
}

/** Why these bytes cannot be the project thumbnail, or undefined when they can. */
export function screenshotProblem(bytes: Uint8Array): string | undefined {
  if (bytes.length > SCREENSHOT_MAX_BYTES) return `larger than ${SCREENSHOT_MAX_BYTES} bytes`;
  const size = pngSize(bytes);
  if (!size) return 'not a PNG image';
  if (size.width > SCREENSHOT_WIDTH || size.height > SCREENSHOT_HEIGHT)
    return `${size.width}×${size.height} is larger than ${SCREENSHOT_WIDTH}×${SCREENSHOT_HEIGHT}`;
  if (!screenshotRatioOk(size.width, size.height)) return `${size.width}×${size.height} is not 16:9 with at least ${SCREENSHOT_MIN_WIDTH} px of width`;
  return undefined;
}
