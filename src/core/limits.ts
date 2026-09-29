/**
 * Resource limits applied while reading hostile input. Every adapter passes a
 * Limits object; the defaults differ between the native CLI and the browser,
 * where memory is tighter.
 */
export interface Limits {
  /** Maximum size of the input archive in bytes. */
  maxArchiveBytes: number;
  /** Maximum number of entries in the central directory. */
  maxEntries: number;
  /** Maximum sum of declared uncompressed sizes. */
  maxTotalUncompressedBytes: number;
  /** Maximum declared uncompressed size of a single entry. */
  maxEntryUncompressedBytes: number;
  /** Maximum uncompressed/compressed ratio for entries larger than ratioThresholdBytes. */
  maxCompressionRatio: number;
  /** Entries below this uncompressed size are exempt from the ratio check. */
  ratioThresholdBytes: number;
  /** Maximum size of a text entry (XML, HTML, CSS, JS, JSON) loaded into memory. */
  maxTextEntryBytes: number;
  /** Maximum length of an entry name in bytes. */
  maxNameBytes: number;
  /** Maximum number of path segments in an entry name. */
  maxPathDepth: number;
  /** Maximum XML element nesting depth. */
  maxXmlDepth: number;
  /** Maximum JSON nesting depth. */
  maxJsonDepth: number;
  /** Maximum nested encoding layers followed when looking for references. */
  maxDecodeLayers: number;
  /** Maximum image area (width x height) that will be decoded. */
  maxImagePixels: number;
  /** Maximum size of an image file that will be processed. */
  maxImageBytes: number;
  /** Maximum size of a video file that will be processed. */
  maxVideoBytes: number;
  /** Largest PDF rewritten (qpdf holds it and its output in a WebAssembly heap). */
  maxPdfBytes: number;
  /** Maximum video frame area (width x height) that will be processed. */
  maxVideoPixels: number;
  /** Maximum video duration in seconds that will be processed. */
  maxVideoDurationSeconds: number;
  /** Wall-clock timeout for a single video job in milliseconds. */
  videoTimeoutMs: number;
  /** Wall-clock timeout for a single image job in milliseconds. */
  imageTimeoutMs: number;
}

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

/** Defaults for the native CLI and the skill. */
export const NATIVE_LIMITS: Readonly<Limits> = Object.freeze({
  maxArchiveBytes: 16 * GiB,
  maxEntries: 50_000,
  maxTotalUncompressedBytes: 32 * GiB,
  maxEntryUncompressedBytes: 8 * GiB,
  maxCompressionRatio: 1000,
  ratioThresholdBytes: 1 * MiB,
  maxTextEntryBytes: 128 * MiB,
  maxNameBytes: 1024,
  maxPathDepth: 64,
  maxXmlDepth: 512,
  maxJsonDepth: 256,
  maxDecodeLayers: 6,
  maxImagePixels: 100_000_000,
  maxImageBytes: 256 * MiB,
  maxVideoBytes: 8 * GiB,
  maxPdfBytes: 512 * MiB,
  maxVideoPixels: 7680 * 4320,
  maxVideoDurationSeconds: 6 * 3600,
  videoTimeoutMs: 2 * 3600 * 1000,
  imageTimeoutMs: 120 * 1000,
});

/**
 * Defaults for the browser. Video limits reflect what the pinned single-thread
 * ffmpeg.wasm core can hold in its 32-bit heap (the encoded output lives in
 * MEMFS); see docs/web-limits.md for the measured cases.
 */
export const BROWSER_LIMITS: Readonly<Limits> = Object.freeze({
  ...NATIVE_LIMITS,
  maxArchiveBytes: 8 * GiB,
  maxTotalUncompressedBytes: 16 * GiB,
  maxEntryUncompressedBytes: 4 * GiB,
  maxTextEntryBytes: 64 * MiB,
  maxImagePixels: 40_000_000,
  maxImageBytes: 64 * MiB,
  maxVideoBytes: 1 * GiB,
  maxPdfBytes: 256 * MiB,
  maxVideoPixels: 3840 * 2160,
  maxVideoDurationSeconds: 2 * 3600,
  videoTimeoutMs: 3 * 3600 * 1000,
  imageTimeoutMs: 60 * 1000,
});

/** Merges user overrides into a base set of limits, rejecting invalid values. */
export function resolveLimits(base: Readonly<Limits>, overrides: Partial<Limits> = {}): Limits {
  const out: Limits = { ...base };
  for (const [key, value] of Object.entries(overrides) as [keyof Limits, number | undefined][]) {
    if (value === undefined) continue;
    if (!(key in base)) throw new Error(`Unknown limit: ${String(key)}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid value for limit ${String(key)}: ${String(value)}`);
    }
    out[key] = value;
  }
  return out;
}
