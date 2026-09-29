import type { Limits } from '../limits.js';
import type { ImageInfo } from './image-inspect.js';
import type { MetadataPolicy } from './image-metadata.js';
import type { Preset } from './video-policy.js';

/**
 * Image policy shared by both engines: which images are eligible, target
 * quality per profile, lossy/lossless mode, metadata handling and
 * validation thresholds. Format and extension are always preserved.
 */

export interface ImageProfile {
  readonly jpegQuality: number;
  readonly webpQuality: number;
  /** Longest side cap; undefined keeps the original resolution. */
  readonly maxDimension: number | undefined;
}

export const IMAGE_PROFILES: Readonly<Record<Preset, ImageProfile>> = Object.freeze({
  // Larger images make no sense in a page: eXeLearning's content column is far narrower, even on 2x screens.
  conservative: { jpegQuality: 90, webpQuality: 90, maxDimension: 2560 },
  balanced: { jpegQuality: 82, webpQuality: 82, maxDimension: 1920 },
  aggressive: { jpegQuality: 72, webpQuality: 75, maxDimension: 1600 },
});

export interface ImageOptions {
  readonly enabled: boolean;
  readonly preset: Preset;
  readonly jpegQuality: number;
  readonly webpQuality: number;
  readonly maxDimension: number | undefined;
  /** Optimize PNG losslessly (never lossy). */
  readonly png: boolean;
  /** Remove EXIF/XMP/IPTC/text metadata (ICC is always kept). */
  readonly stripMetadata: boolean;
  readonly minSavingsPercent: number;
  readonly minSavingsBytes: number;
  /** Re-encode even when the source looks already optimized. */
  readonly force: boolean;
}

export interface ImageCapabilities {
  readonly available: boolean;
  readonly reason?: string;
  /** Library used per format, e.g. { jpeg: 'mozjpeg (sharp 0.35.5)' }. */
  readonly encoders: Readonly<Partial<Record<'jpeg' | 'png' | 'webp', string>>>;
  readonly canResize: boolean;
}

export type ImageSkipReason =
  | 'images-disabled'
  | 'engine-unavailable'
  | 'engine-capability'
  | 'unsupported-format'
  | 'vector-image'
  | 'animated'
  | 'multi-image'
  | 'corrupt'
  | 'extension-mismatch'
  | 'cmyk'
  | 'high-bit-depth'
  | 'exceeds-size-limit'
  | 'exceeds-resolution-limit'
  | 'already-efficient'
  | 'png-disabled';

export interface ImageJob {
  readonly format: 'jpeg' | 'png' | 'webp';
  readonly mode: 'lossy' | 'lossless';
  readonly quality: number | undefined;
  readonly resize: { width: number; height: number } | undefined;
  readonly metadata: MetadataPolicy;
  readonly expected: { width: number; height: number; hasAlpha: boolean };
  readonly conversions: readonly string[];
}

export type ImageDecision =
  { readonly action: 'encode'; readonly job: ImageJob } | { readonly action: 'skip'; readonly reason: ImageSkipReason; readonly detail: string };

export interface ImageInput {
  readonly format: string;
  readonly size: number;
  readonly info: ImageInfo | undefined;
  readonly extensionMatches: boolean | undefined;
  /** Used where its resolution matters (e.g. a magnifier iDevice): never resized. */
  readonly resolutionSensitive: boolean;
}

/** Decides whether and how an image is re-encoded. */
export function decideImage(input: ImageInput, options: ImageOptions, caps: ImageCapabilities, limits: Limits): ImageDecision {
  const skip = (reason: ImageSkipReason, detail: string): ImageDecision => ({ action: 'skip', reason, detail });
  if (!options.enabled) return skip('images-disabled', 'Image optimization is disabled');
  if (!caps.available) return skip('engine-unavailable', caps.reason ?? 'No image engine available');
  if (input.format === 'svg') return skip('vector-image', 'SVG images are never rasterized');
  if (input.format !== 'jpeg' && input.format !== 'png' && input.format !== 'webp') {
    return skip('unsupported-format', `Format "${input.format}" is not optimized`);
  }
  const format = input.format;
  const info = input.info;
  if (!info || info.error || !info.width || !info.height) return skip('corrupt', info?.error ?? 'Image header could not be read');
  if (input.extensionMatches === false) return skip('extension-mismatch', 'File extension does not match its content');
  if (info.animated) return skip('animated', `Animated image (${info.frames ?? '?'} frames) is preserved`);
  if (info.multiImage) return skip('multi-image', 'JPEG with additional images (MPF) is preserved');
  if (info.colorModel === 'cmyk' || info.colorModel === 'ycck') return skip('cmyk', 'CMYK JPEG is preserved to keep colour fidelity');
  if (info.bitDepth !== undefined && info.bitDepth > 8) return skip('high-bit-depth', `${info.bitDepth}-bit image is preserved`);
  if (input.size > limits.maxImageBytes) return skip('exceeds-size-limit', `Larger than ${limits.maxImageBytes} bytes`);
  if (info.width * info.height > limits.maxImagePixels) return skip('exceeds-resolution-limit', `${info.width}x${info.height} exceeds the limit`);
  if (!caps.encoders[format]) return skip('engine-capability', `No ${format} encoder in this engine`);
  if (format === 'png' && !options.png) return skip('png-disabled', 'PNG optimization is disabled');

  const conversions: string[] = [];
  let resize: { width: number; height: number } | undefined;
  if (options.maxDimension !== undefined && !input.resolutionSensitive && caps.canResize) {
    const longSide = Math.max(info.width, info.height);
    if (longSide > options.maxDimension) {
      const scale = options.maxDimension / longSide;
      resize = { width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)) };
      conversions.push(`resize ${info.width}x${info.height} → ${resize.width}x${resize.height}`);
    }
  }
  let mode: 'lossy' | 'lossless';
  let quality: number | undefined;
  if (format === 'jpeg') {
    mode = 'lossy';
    quality = options.jpegQuality;
    if (!options.force && !resize && info.jpegQuality !== undefined && info.jpegQuality <= quality + 2) {
      return skip('already-efficient', `Estimated JPEG quality ${info.jpegQuality} is not above the target ${quality}`);
    }
    conversions.unshift(`JPEG re-encoded at quality ${quality} (lossy)`);
  } else if (format === 'png') {
    mode = 'lossless';
    quality = undefined;
    conversions.unshift(resize ? 'PNG resized and recompressed' : 'PNG recompressed losslessly');
  } else if (info.lossless) {
    mode = 'lossless';
    quality = undefined;
    conversions.unshift('WebP recompressed losslessly');
  } else {
    mode = 'lossy';
    quality = options.webpQuality;
    if (!options.force && !resize) {
      return skip('already-efficient', 'Lossy WebP is not re-encoded without resizing (quality cannot be estimated)');
    }
    conversions.unshift(`WebP re-encoded at quality ${quality} (lossy)`);
  }
  // Orientation lives in EXIF; pixels are never rotated, so EXIF is kept when it carries a rotation.
  const orientationNeedsExif = info.orientation !== undefined && info.orientation !== 1;
  const metadata: MetadataPolicy = {
    keepIcc: true,
    keepExif: !options.stripMetadata || orientationNeedsExif,
    keepXmp: !options.stripMetadata,
    keepIptc: !options.stripMetadata,
    keepText: !options.stripMetadata,
  };
  if (options.stripMetadata) {
    conversions.push(
      orientationNeedsExif ? 'metadata removed except colour profile and EXIF (needed for orientation)' : 'metadata removed except colour profile',
    );
  }
  return {
    action: 'encode',
    job: {
      format,
      mode,
      quality,
      resize,
      metadata,
      expected: { width: resize?.width ?? info.width, height: resize?.height ?? info.height, hasAlpha: info.hasAlpha === true },
      conversions,
    },
  };
}
