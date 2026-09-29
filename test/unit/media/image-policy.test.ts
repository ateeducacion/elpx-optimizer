import { describe, expect, it } from 'vitest';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import type { ImageInfo } from '../../../src/core/media/image-inspect.js';
import {
  decideImage,
  IMAGE_PROFILES,
  type ImageCapabilities,
  type ImageDecision,
  type ImageInput,
  type ImageJob,
  type ImageOptions,
} from '../../../src/core/media/image-policy.js';

/** Header facts for a plain 800x600 image. */
function info(extra: Partial<ImageInfo> = {}): ImageInfo {
  return {
    format: 'jpeg',
    width: 800,
    height: 600,
    hasAlpha: false,
    animated: false,
    multiImage: false,
    hasIcc: false,
    hasExif: false,
    hasXmp: false,
    hasIptc: false,
    hasText: false,
    metadataBytes: 0,
    colorModel: 'rgb',
    bitDepth: 8,
    jpegQuality: 95,
    ...extra,
  };
}

const caps: ImageCapabilities = { available: true, encoders: { jpeg: 'mozjpeg', png: 'oxipng', webp: 'libwebp' }, canResize: true };
const options: ImageOptions = {
  enabled: true,
  preset: 'balanced',
  jpegQuality: 82,
  webpQuality: 82,
  maxDimension: undefined,
  png: true,
  stripMetadata: false,
  minSavingsPercent: 5,
  minSavingsBytes: 1024,
  force: false,
};

/** Runs decideImage with overrides. */
function decide(i: Partial<ImageInput> = {}, o: Partial<ImageOptions> = {}, c: Partial<ImageCapabilities> = {}): ImageDecision {
  return decideImage(
    { format: 'jpeg', size: 100_000, info: info(), extensionMatches: true, resolutionSensitive: false, ...i },
    { ...options, ...o },
    { ...caps, ...c },
    NATIVE_LIMITS,
  );
}

/** Asserts an encode decision and returns its job. */
function job(d: ImageDecision): ImageJob {
  if (d.action !== 'encode') throw new Error(`expected encode, got ${d.reason}: ${d.detail}`);
  return d.job;
}

describe('decideImage skip reasons', () => {
  it.each<[string, () => ImageDecision, RegExp]>([
    ['images-disabled', () => decide({}, { enabled: false }), /disabled/],
    ['engine-unavailable', () => decide({}, {}, { available: false, reason: 'sharp missing' }), /sharp missing/],
    ['engine-unavailable', () => decide({}, {}, { available: false }), /No image engine/],
    ['vector-image', () => decide({ format: 'svg' }), /never rasterized/],
    ['unsupported-format', () => decide({ format: 'gif' }), /"gif"/],
    ['corrupt', () => decide({ info: undefined }), /could not be read/],
    ['corrupt', () => decide({ info: info({ error: 'JPEG end-of-image marker missing' }) }), /end-of-image/],
    ['corrupt', () => decide({ info: info({ width: undefined }) }), /could not be read/],
    ['corrupt', () => decide({ info: info({ height: 0 }) }), /could not be read/],
    ['extension-mismatch', () => decide({ extensionMatches: false }), /extension/],
    ['animated', () => decide({ format: 'webp', info: info({ format: 'webp', animated: true, frames: 12 }) }), /12 frames/],
    ['animated', () => decide({ format: 'png', info: info({ format: 'png', animated: true }) }), /\? frames/],
    ['multi-image', () => decide({ info: info({ multiImage: true }) }), /MPF/],
    ['cmyk', () => decide({ info: info({ colorModel: 'cmyk' }) }), /CMYK/],
    ['cmyk', () => decide({ info: info({ colorModel: 'ycck' }) }), /CMYK/],
    ['high-bit-depth', () => decide({ format: 'png', info: info({ format: 'png', bitDepth: 16 }) }), /16-bit/],
    ['exceeds-size-limit', () => decide({ size: NATIVE_LIMITS.maxImageBytes + 1 }), /Larger than/],
    ['exceeds-resolution-limit', () => decide({ info: info({ width: 20000, height: 10000 }) }), /20000x10000/],
    ['engine-capability', () => decide({ format: 'webp', info: info({ format: 'webp' }) }, {}, { encoders: { jpeg: 'x' } }), /No webp encoder/],
    ['png-disabled', () => decide({ format: 'png', info: info({ format: 'png' }) }, { png: false }), /PNG optimization is disabled/],
    ['already-efficient', () => decide({ info: info({ jpegQuality: 84 }) }), /84 is not above the target 82/],
    ['already-efficient', () => decide({ format: 'webp', info: info({ format: 'webp', lossless: false }) }), /quality cannot be estimated/],
  ])('skips with %s', (reason, run, detail) => {
    const d = run();
    expect(d.action).toBe('skip');
    if (d.action === 'skip') {
      expect(d.reason).toBe(reason);
      expect(d.detail).toMatch(detail);
    }
  });
});

describe('decideImage jobs', () => {
  it('re-encodes JPEG lossily at the profile quality', () => {
    const j = job(decide());
    expect(j).toEqual({
      format: 'jpeg',
      mode: 'lossy',
      quality: 82,
      resize: undefined,
      metadata: { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true },
      expected: { width: 800, height: 600, hasAlpha: false },
      conversions: ['JPEG re-encoded at quality 82 (lossy)'],
    });
    // Unknown quality, forced, or resized: always re-encoded.
    expect(decide({ info: info({ jpegQuality: undefined }) }).action).toBe('encode');
    expect(decide({ info: info({ jpegQuality: 50 }) }, { force: true }).action).toBe('encode');
    expect(job(decide({ info: info({ jpegQuality: 50 }) }, { maxDimension: 400 })).resize).toEqual({ width: 400, height: 300 });
  });

  it('recompresses PNG losslessly, with or without resizing', () => {
    const png = { format: 'png', info: info({ format: 'png', hasAlpha: true, jpegQuality: undefined, lossless: true }) } as const;
    const j = job(decide(png));
    expect(j).toMatchObject({ format: 'png', mode: 'lossless', quality: undefined, expected: { hasAlpha: true } });
    expect(j.conversions).toEqual(['PNG recompressed losslessly']);
    const resized = job(decide(png, { maxDimension: 200 }));
    expect(resized.conversions).toEqual(['PNG resized and recompressed', 'resize 800x600 → 200x150']);
    expect(resized.expected).toEqual({ width: 200, height: 150, hasAlpha: true });
  });

  it('keeps WebP lossless when the source is lossless and lossy WebP only when forced or resized', () => {
    const lossless = job(decide({ format: 'webp', info: info({ format: 'webp', lossless: true }) }));
    expect(lossless).toMatchObject({ mode: 'lossless', quality: undefined, conversions: ['WebP recompressed losslessly'] });
    const forced = job(decide({ format: 'webp', info: info({ format: 'webp', lossless: false }) }, { force: true }));
    expect(forced).toMatchObject({ mode: 'lossy', quality: 82, conversions: ['WebP re-encoded at quality 82 (lossy)'] });
    const resized = job(decide({ format: 'webp', info: info({ format: 'webp' }) }, { maxDimension: 100, webpQuality: 70 }));
    expect(resized).toMatchObject({ mode: 'lossy', quality: 70, resize: { width: 100, height: 75 } });
  });

  it('never resizes resolution-sensitive images, small images or without resize support', () => {
    expect(job(decide({ resolutionSensitive: true, info: info({ jpegQuality: 99 }) }, { maxDimension: 100 })).resize).toBeUndefined();
    expect(job(decide({ info: info({ jpegQuality: 99 }) }, { maxDimension: 100 }, { canResize: false })).resize).toBeUndefined();
    expect(job(decide({ info: info({ jpegQuality: 99 }) }, { maxDimension: 800 })).resize).toBeUndefined();
    // Portrait images are capped by the long side; extreme ratios keep at least one pixel.
    expect(job(decide({ info: info({ width: 300, height: 1200 }) }, { maxDimension: 600 })).resize).toEqual({ width: 150, height: 600 });
    expect(job(decide({ info: info({ width: 10000, height: 2 }) }, { maxDimension: 1000 })).resize).toEqual({ width: 1000, height: 1 });
  });

  it('strips metadata on request, keeping ICC and orientation EXIF', () => {
    const plain = job(decide({}, { stripMetadata: true }));
    expect(plain.metadata).toEqual({ keepIcc: true, keepExif: false, keepXmp: false, keepIptc: false, keepText: false });
    expect(plain.conversions.at(-1)).toBe('metadata removed except colour profile');
    const rotated = job(decide({ info: info({ orientation: 6 }) }, { stripMetadata: true }));
    expect(rotated.metadata.keepExif).toBe(true);
    expect(rotated.conversions.at(-1)).toBe('metadata removed except colour profile and EXIF (needed for orientation)');
    expect(job(decide({ info: info({ orientation: 1 }) }, { stripMetadata: true })).metadata.keepExif).toBe(false);
  });

  it('defines stricter profiles for stronger presets', () => {
    expect(IMAGE_PROFILES.conservative.jpegQuality).toBeGreaterThan(IMAGE_PROFILES.balanced.jpegQuality);
    expect(IMAGE_PROFILES.balanced.jpegQuality).toBeGreaterThan(IMAGE_PROFILES.aggressive.jpegQuality);
    expect(IMAGE_PROFILES.aggressive.maxDimension).toBe(1920);
    expect(IMAGE_PROFILES.balanced.maxDimension).toBeUndefined();
  });
});
