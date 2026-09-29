import { BROWSER_LIMITS } from '../core/limits.js';
import type { ThreadingPreference } from '../adapters/browser/ffmpeg-loader.js';

/** Settings a page URL may override (for tests and devices with little memory). */
export interface UrlSettings {
  /** From `?maxVideoMiB=N`: largest video processed, capped at the browser default. */
  readonly maxVideoBytes?: number;
  /** From `?threads=single|auto`: initial FFmpeg core preference. */
  readonly threading?: ThreadingPreference;
}

/** Reads `?maxVideoMiB` and `?threads` from a query string; invalid values are ignored. */
export function readUrlSettings(search: string): UrlSettings {
  const params = new URLSearchParams(search);
  const settings: { maxVideoBytes?: number; threading?: ThreadingPreference } = {};
  const mib = params.get('maxVideoMiB')?.trim() ?? '';
  if (/^\d+$/.test(mib) && Number(mib) > 0) settings.maxVideoBytes = Math.min(BROWSER_LIMITS.maxVideoBytes, Number(mib) * 1024 * 1024);
  const threads = params.get('threads');
  if (threads === 'single' || threads === 'auto') settings.threading = threads;
  return settings;
}
