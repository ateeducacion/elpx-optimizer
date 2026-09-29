import { describe, expect, it } from 'vitest';
import { canonicalJson, normalizeOptions, parseResolution, type OptionsInput } from '../../../src/core/plan/options.js';
import { ElpxError } from '../../../src/core/errors.js';
import { VIDEO_PROFILES } from '../../../src/core/media/video-policy.js';
import { IMAGE_PROFILES } from '../../../src/core/media/image-policy.js';

/** Expects normalizeOptions to reject the input with an invalid-options error. */
function rejects(input: unknown, message: RegExp): void {
  let error: unknown;
  try {
    normalizeOptions(input as OptionsInput);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ElpxError);
  expect((error as ElpxError).code).toBe('invalid-options');
  expect((error as ElpxError).message).toMatch(message);
}

describe('normalizeOptions', () => {
  it('fills every default from the balanced profile', () => {
    const o = normalizeOptions();
    expect(o).toEqual({
      preset: 'balanced',
      video: {
        enabled: true,
        preset: 'balanced',
        crf: VIDEO_PROFILES.balanced.crf,
        maxShortSide: 1080,
        audioBitrateKbps: 128,
        x264Preset: undefined,
        minSavingsPercent: 5,
        minSavingsBytes: 10 * 1024,
        force: false,
        dropDataStreams: false,
      },
      images: {
        enabled: true,
        preset: 'balanced',
        jpegQuality: IMAGE_PROFILES.balanced.jpegQuality,
        webpQuality: IMAGE_PROFILES.balanced.webpQuality,
        maxDimension: undefined,
        png: true,
        stripMetadata: false,
        minSavingsPercent: 5,
        minSavingsBytes: 1024,
        force: false,
        includeScreenshot: false,
      },
      removeUnused: 'off',
      deduplicate: 'off',
      flatten: 'off',
      missingReferences: 'keep',
      exclude: [],
    });
    expect(normalizeOptions({})).toEqual(o);
  });

  it('applies profile defaults and explicit values', () => {
    const aggressive = normalizeOptions({ preset: 'aggressive' });
    expect(aggressive.video).toMatchObject({ crf: 28, maxShortSide: 720, audioBitrateKbps: 96 });
    expect(aggressive.images.maxDimension).toBe(1920);
    expect(normalizeOptions({ preset: 'aggressive', images: { maxDimension: null } }).images.maxDimension).toBeUndefined();
    const custom = normalizeOptions({
      preset: 'conservative',
      minSavingsPercent: 0,
      minSavingsBytes: 50_000,
      video: { enabled: false, crf: 16, maxResolution: '720p', audioBitrate: 320, x264Preset: 'veryslow', force: true, dropDataStreams: true },
      images: { enabled: false, jpegQuality: 30, webpQuality: 100, maxDimension: 64, png: false, stripMetadata: true, force: true, includeScreenshot: true },
      removeUnused: 'safe',
      deduplicate: 'exact',
      flatten: 'legacy',
      missingReferences: 'remove',
      exclude: ['b', 'a', 'b'],
    });
    expect(custom.video).toMatchObject({
      enabled: false,
      crf: 16,
      maxShortSide: 720,
      audioBitrateKbps: 320,
      x264Preset: 'veryslow',
      force: true,
      dropDataStreams: true,
      minSavingsPercent: 0,
      minSavingsBytes: 50_000,
    });
    expect(custom.images).toMatchObject({
      enabled: false,
      jpegQuality: 30,
      webpQuality: 100,
      maxDimension: 64,
      png: false,
      stripMetadata: true,
      force: true,
      includeScreenshot: true,
      minSavingsBytes: 50_000,
    });
    expect(custom.exclude).toEqual(['a', 'b']);
    expect(custom.removeUnused).toBe('safe');
    expect(custom.deduplicate).toBe('exact');
    expect(custom.flatten).toBe('legacy');
    expect(custom.missingReferences).toBe('remove');
  });

  it.each([
    ['x', /must be an object/],
    [null, /must be an object/],
    [{ ffmpegArgs: ['-i', '/etc/passwd'] }, /Unknown option ffmpegArgs/],
    [{ video: { args: '-y' } }, /Unknown option video\.args/],
    [{ images: { quality: 5 } }, /Unknown option images\.quality/],
    [{ preset: 'ultra' }, /preset must be one of conservative, balanced, aggressive/],
    [{ minSavingsPercent: 91 }, /minSavingsPercent must be an integer between 0 and 90/],
    [{ minSavingsPercent: -1 }, /minSavingsPercent/],
    [{ minSavingsPercent: 2.5 }, /minSavingsPercent/],
    [{ minSavingsPercent: '5' }, /minSavingsPercent/],
    [{ minSavingsBytes: 1_000_000_001 }, /minSavingsBytes/],
    [{ video: 'fast' }, /video must be an object/],
    [{ video: { crf: 15 } }, /video\.crf must be an integer between 16 and 35/],
    [{ video: { crf: 36 } }, /video\.crf/],
    [{ video: { x264Preset: 'placebo' } }, /video\.x264Preset must be one of/],
    [{ video: { maxResolution: 999 } }, /maxResolution must be one of 360, 480, 720, 1080, 1440, 2160 or "original"/],
    [{ video: { maxResolution: 'huge' } }, /maxResolution/],
    [{ video: { audioBitrate: 32 } }, /video\.audioBitrate/],
    [{ video: { enabled: 'yes' } }, /video\.enabled must be true or false/],
    [{ video: { force: 1 } }, /video\.force/],
    [{ video: { dropDataStreams: 'no' } }, /video\.dropDataStreams/],
    [{ images: 3 }, /images must be an object/],
    [{ images: { jpegQuality: 29 } }, /images\.jpegQuality must be an integer between 30 and 100/],
    [{ images: { webpQuality: 101 } }, /images\.webpQuality/],
    [{ images: { maxDimension: 63 } }, /images\.maxDimension must be an integer between 64 and 20000/],
    [{ images: { png: 'true' } }, /images\.png/],
    [{ images: { stripMetadata: 0 } }, /images\.stripMetadata/],
    [{ images: { force: null } }, /images\.force/],
    [{ images: { includeScreenshot: 'y' } }, /images\.includeScreenshot/],
    [{ images: { enabled: 1 } }, /images\.enabled/],
    [{ removeUnused: 'all' }, /removeUnused must be "off" or "safe"/],
    [{ deduplicate: 'fuzzy' }, /deduplicate must be "off" or "exact"/],
    [{ flatten: 'all' }, /flatten must be "off" or "legacy"/],
    [{ missingReferences: 'hide' }, /missingReferences must be "keep" or "remove"/],
    [{ exclude: 'a.png' }, /exclude must be a list of paths/],
    [{ exclude: ['a.png', 3] }, /exclude must be a list of paths/],
  ])('rejects %j', (input, message) => {
    rejects(input, message);
  });
});

describe('parseResolution', () => {
  it('accepts caps as numbers, strings and "p" suffixes', () => {
    expect(parseResolution(720)).toBe(720);
    expect(parseResolution('1080')).toBe(1080);
    expect(parseResolution('2160P')).toBe(2160);
    expect(parseResolution('original')).toBe('original');
    expect(() => parseResolution(undefined)).toThrow(/maxResolution/);
    expect(() => parseResolution(721)).toThrow(/maxResolution/);
  });
});

describe('canonicalJson', () => {
  it('sorts keys, skips undefined members and is stable', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x', null, undefined], c: undefined }, e: true })).toBe('{"a":{"d":[1,"x",null,null]},"b":1,"e":true}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson({ z: 1, y: 2 })).toBe(canonicalJson({ y: 2, z: 1 }));
    expect(canonicalJson({ B: 1, a: 1, 'b b': 1 })).toBe('{"B":1,"a":1,"b b":1}');
  });
});
