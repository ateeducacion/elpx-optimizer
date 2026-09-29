import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  estimateJpegQuality,
  findIfd0Entry,
  inspectImage,
  jpegSegmentKind,
  jpegSegments,
  pngChunks,
  readExifOrientation,
  webpChunks,
} from '../../../src/core/media/image-inspect.js';
import { MEDIA } from '../../helpers/native.js';
import {
  be32,
  buildGif,
  buildJpeg,
  buildPng,
  buildWebp,
  cat,
  dqt,
  exifApp1,
  ihdr,
  jfifApp0,
  jpegSegment,
  latin1,
  pngChunk,
  riffChunk,
  sof,
  tiff,
  vp8,
  vp8l,
  vp8x,
} from '../../helpers/image-craft.js';

/** IJG standard luminance quantisation table (quality 50). */
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103,
  77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(MEDIA, name)));
const orientationTiff = (little: boolean, value: number): Uint8Array => tiff(little, [{ tag: 0x0112, type: 3, value }]);

/** Adobe APP14 segment with the given colour transform. */
function adobe(transform: number): Uint8Array {
  return jpegSegment(0xee, cat(latin1('Adobe'), [0, 100, 0, 0, 0, 0, transform]));
}

describe('JPEG inspection', () => {
  const xmp = jpegSegment(0xe1, latin1('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
  const icc = jpegSegment(0xe2, latin1('ICC_PROFILE\0\x01\x01profile'));
  const iptc = jpegSegment(0xed, latin1('Photoshop 3.0\x008BIM'));
  const mpf = jpegSegment(0xe2, latin1('MPF\0MM\0*'));
  const comment = jpegSegment(0xfe, latin1('made by a test'));
  const other = jpegSegment(0xe5, latin1('Ducky'));
  const exif = exifApp1(orientationTiff(true, 6));

  it('collects metadata kinds, dimensions and quality from the header', () => {
    const bytes = buildJpeg([jfifApp0(), exif, xmp, icc, iptc, mpf, comment, other, adobe(1), dqt(STD_LUMA), sof(640, 480)]);
    const info = inspectImage(bytes, 'jpeg');
    expect(info).toMatchObject({
      format: 'jpeg',
      width: 640,
      height: 480,
      bitDepth: 8,
      colorModel: 'rgb',
      progressive: false,
      lossless: false,
      hasAlpha: false,
      animated: false,
      hasExif: true,
      orientation: 6,
      hasXmp: true,
      hasIcc: true,
      hasIptc: true,
      multiImage: true,
      hasText: false,
      jpegQuality: 50,
    });
    expect(info.error).toBeUndefined();
    // JFIF and Adobe segments are structural, everything else counts as metadata.
    expect(info.metadataBytes).toBe([exif, xmp, icc, iptc, mpf, comment, other].reduce((s, x) => s + x.length, 0));
  });

  it('classifies APP segments by identifier', () => {
    const bytes = buildJpeg([
      jfifApp0(),
      jpegSegment(0xe0, latin1('JFXX\0\x10')),
      jpegSegment(0xe0, latin1('AVI1')),
      jpegSegment(0xe1, latin1('http://ns.adobe.com/xmp/extension/\0')),
      jpegSegment(0xe1, latin1('Other')),
      jpegSegment(0xe2, latin1('FPXR')),
      jpegSegment(0xed, latin1('Other')),
      jpegSegment(0xee, latin1('NotAdobe')),
      adobe(2),
      jpegSegment(0xfe, latin1('c')),
      sof(8, 8),
    ]);
    const segments = jpegSegments(bytes);
    expect(segments.map((s) => jpegSegmentKind(bytes, s))).toEqual([
      'jfif',
      'jfif',
      'other',
      'xmp',
      'other',
      'other',
      'other',
      'other',
      'adobe',
      'comment',
      'other',
      'other',
    ]);
    expect(segments.at(-1)!.marker).toBe(0xda);
  });

  it.each([
    [0xc0, false],
    [0xc1, false],
    [0xc2, true],
    [0xc3, false],
    [0xc6, true],
    [0xca, true],
    [0xce, true],
  ])('reads frame header marker 0x%s (progressive %s)', (marker, progressive) => {
    const info = inspectImage(buildJpeg([sof(33, 17, { marker, bitDepth: 12 })]), 'jpeg');
    expect(info).toMatchObject({ width: 33, height: 17, bitDepth: 12, progressive });
  });

  it('does not mistake DHT, JPG or DAC markers for frame headers', () => {
    const bytes = buildJpeg([jpegSegment(0xc4, [0, 1, 2, 3]), jpegSegment(0xc8, [9, 9, 9, 9, 9, 9]), jpegSegment(0xcc, [0, 1]), sof(12, 34)]);
    expect(inspectImage(bytes, 'jpeg')).toMatchObject({ width: 12, height: 34 });
    expect(inspectImage(buildJpeg([jpegSegment(0xc4, [0, 1, 2, 3, 4, 5, 6, 7])]), 'jpeg').error).toBe('JPEG frame header not found');
  });

  it('estimates quality from 8-bit and 16-bit tables, using the first luminance table', () => {
    const doubled = STD_LUMA.map((v) => v * 2);
    const sixteen = inspectImage(buildJpeg([dqt(doubled, { sixteen: true }), sof(8, 8)]), 'jpeg');
    expect(sixteen.jpegQuality).toBe(25);
    const chromaFirst = cat(jpegSegment(0xdb, cat([0x01], new Uint8Array(64).fill(99), [0x00], STD_LUMA)));
    expect(inspectImage(buildJpeg([chromaFirst, dqt(doubled), sof(8, 8)]), 'jpeg').jpegQuality).toBe(50);
    expect(inspectImage(buildJpeg([sof(8, 8)]), 'jpeg')).not.toHaveProperty('jpegQuality');
  });

  it('distinguishes gray, CMYK and YCCK JPEGs', () => {
    expect(inspectImage(buildJpeg([sof(8, 8, { components: 1 })]), 'jpeg').colorModel).toBe('gray');
    expect(inspectImage(buildJpeg([sof(8, 8, { components: 4 })]), 'jpeg').colorModel).toBe('cmyk');
    expect(inspectImage(buildJpeg([adobe(0), sof(8, 8, { components: 4 })]), 'jpeg').colorModel).toBe('cmyk');
    expect(inspectImage(buildJpeg([adobe(2), sof(8, 8, { components: 4 })]), 'jpeg').colorModel).toBe('ycck');
    expect(inspectImage(buildJpeg([adobe(2), sof(8, 8, { components: 3 })]), 'jpeg').colorModel).toBe('rgb');
  });

  it('handles fill bytes and standalone markers before the frame header', () => {
    const bytes = cat([0xff, 0xd8, 0xff], [0xff, 0xd0], [0xff, 0x01], sof(5, 6), [0xff, 0xd9]);
    const segments = jpegSegments(bytes);
    expect(segments.map((s) => s.marker)).toEqual([0xd0, 0x01, 0xc0, 0xd9]);
    expect(segments[0]).toEqual({ marker: 0xd0, start: 3, end: 5, dataStart: 5 });
    expect(inspectImage(bytes, 'jpeg')).toMatchObject({ width: 5, height: 6 });
  });

  it('reports structural problems', () => {
    expect(inspectImage(cat([0xff, 0xd8, 0xff, 0xd9]), 'jpeg').error).toBe('JPEG frame header not found');
    expect(inspectImage(buildJpeg([sof(8, 8)], { eoi: false }), 'jpeg').error).toMatch(/end-of-image marker missing/);
    // Trailing bytes after EOI are tolerated.
    expect(inspectImage(cat(buildJpeg([sof(8, 8)]), new Uint8Array(100)), 'jpeg').error).toBeUndefined();
    expect(inspectImage(cat([0xff, 0xd8, 0x00]), 'jpeg').error).toBe('Corrupt JPEG marker stream');
    expect(inspectImage(cat([0xff, 0xd8, 0xff, 0xe0]), 'jpeg').error).toBe('Truncated JPEG segment');
    expect(inspectImage(cat([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]), 'jpeg').error).toBe('Truncated JPEG segment');
    expect(inspectImage(cat([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 1, 2]), 'jpeg').error).toBe('Truncated JPEG segment');
    expect(inspectImage(latin1('GIF89a'), 'jpeg')).toMatchObject({ format: 'jpeg', error: 'Not a JPEG', animated: false, metadataBytes: 0 });
    expect(jpegSegments(cat([0xff, 0xd8]))).toEqual([]);
  });

  it.each([
    ['photo-exif-icc.jpg', { width: 320, height: 240, orientation: 6, hasIcc: true, hasExif: true, hasXmp: true, progressive: false }],
    ['cmyk.jpg', { colorModel: 'cmyk', hasIcc: false }],
    ['progressive.jpg', { progressive: true, jpegQuality: 97 }],
    ['efficient.jpg', { jpegQuality: 31 }],
    ['truncated.jpg', { error: 'JPEG end-of-image marker missing (truncated file)' }],
  ])('inspects the %s fixture', (name, expected) => {
    expect(inspectImage(load(name), 'jpeg')).toMatchObject(expected);
  });

  it('estimates IJG quality from quantisation tables', () => {
    expect(estimateJpegQuality(STD_LUMA)).toBe(50);
    expect(estimateJpegQuality(STD_LUMA.map((v) => Math.max(1, Math.round(v / 5))))).toBe(90);
    expect(estimateJpegQuality(new Array<number>(64).fill(1))).toBe(99);
    expect(estimateJpegQuality(new Array<number>(64).fill(0))).toBe(100);
    expect(estimateJpegQuality(new Array<number>(64).fill(65535))).toBe(1);
  });
});

describe('EXIF orientation', () => {
  it('reads the orientation tag in both byte orders', () => {
    expect(readExifOrientation(orientationTiff(true, 6))).toBe(6);
    expect(readExifOrientation(orientationTiff(false, 3))).toBe(3);
    expect(readExifOrientation(orientationTiff(true, 9))).toBeUndefined();
    expect(readExifOrientation(orientationTiff(false, 0))).toBeUndefined();
    expect(readExifOrientation(tiff(true, [{ tag: 0x010f, type: 3, value: 1 }]))).toBeUndefined();
  });

  it('locates IFD0 entries defensively', () => {
    const t = tiff(true, [
      { tag: 0x010f, type: 4, value: 7 },
      { tag: 0x0112, type: 3, value: 1 },
    ]);
    expect(findIfd0Entry(t, 0x0112)).toEqual({ little: true, valueOffset: 8 + 2 + 12 + 8, type: 3 });
    expect(findIfd0Entry(t, 0x010f)).toEqual({ little: true, valueOffset: 18, type: 4 });
    expect(findIfd0Entry(t, 0x9999)).toBeUndefined();
    expect(findIfd0Entry(t.subarray(0, 7), 0x0112)).toBeUndefined();
    const badOrder = t.slice();
    badOrder.set(latin1('XX'), 0);
    expect(findIfd0Entry(badOrder, 0x0112)).toBeUndefined();
    const badMagic = t.slice();
    badMagic[2] = 43;
    expect(findIfd0Entry(badMagic, 0x0112)).toBeUndefined();
    const badOffset = t.slice();
    badOffset.set([0xff, 0, 0, 0], 4);
    expect(findIfd0Entry(badOffset, 0x0112)).toBeUndefined();
    // The entry count promises more entries than the block holds.
    const truncated = t.subarray(0, 8 + 2 + 12 + 6);
    expect(findIfd0Entry(truncated, 0x0112)).toBeUndefined();
  });
});

describe('PNG inspection', () => {
  const xmpText = pngChunk('iTXt', latin1('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>'));

  it('collects animation, colour profile, EXIF and text chunks', () => {
    const meta = [
      pngChunk('iCCP', latin1('icc\0\0xyz')),
      pngChunk('eXIf', orientationTiff(false, 8)),
      pngChunk('tEXt', latin1('Author\0me')),
      pngChunk('zTXt', latin1('Comment\0\0x')),
      xmpText,
      pngChunk('tIME', [7, 234, 1, 1, 0, 0, 0]),
    ];
    const bytes = buildPng([
      ihdr(10, 20, 8, 6),
      pngChunk('acTL', cat(be32(3), be32(0))),
      ...meta,
      pngChunk('IDAT', [1, 2, 3]),
      pngChunk('IEND'),
      pngChunk('tEXt', latin1('after\0end')),
    ]);
    const info = inspectImage(bytes, 'png');
    expect(info).toMatchObject({
      format: 'png',
      width: 10,
      height: 20,
      bitDepth: 8,
      colorModel: 'rgb',
      hasAlpha: true,
      animated: true,
      frames: 3,
      hasIcc: true,
      hasExif: true,
      orientation: 8,
      hasText: true,
      hasXmp: true,
      hasIptc: false,
      lossless: true,
    });
    expect(info.metadataBytes).toBe(meta.reduce((s, c) => s + c.length, 0));
    expect(pngChunks(bytes).at(-1)!.type).toBe('IEND');
  });

  it.each([
    [0, 'gray', false],
    [4, 'gray', true],
    [2, 'rgb', false],
    [6, 'rgb', true],
    [3, 'palette', false],
  ])('maps colour type %i', (colorType, colorModel, hasAlpha) => {
    const info = inspectImage(buildPng([ihdr(4, 4, 8, colorType), pngChunk('IEND')]), 'png');
    expect(info).toMatchObject({ colorModel, hasAlpha, animated: false });
    expect(info).not.toHaveProperty('frames');
  });

  it('treats tRNS as transparency and plain iTXt as text only', () => {
    const info = inspectImage(
      buildPng([ihdr(4, 4, 8, 3), pngChunk('PLTE', [0, 0, 0]), pngChunk('tRNS', [0]), pngChunk('iTXt', latin1('Title\0\0\0\0\0Hola')), pngChunk('IEND')]),
      'png',
    );
    expect(info).toMatchObject({ hasAlpha: true, hasText: true, hasXmp: false });
  });

  it('reports structural problems', () => {
    expect(inspectImage(buildPng([ihdr(4, 4), cat(be32(100), latin1('IDAT'), new Uint8Array(10))]), 'png').error).toBe('Truncated PNG chunk');
    expect(inspectImage(buildPng([pngChunk('IDAT', [1]), ihdr(4, 4)]), 'png').error).toBe('PNG without IHDR');
    expect(inspectImage(buildPng([]), 'png').error).toBe('PNG without IHDR');
    expect(inspectImage(latin1('not a png at all'), 'png')).toMatchObject({ format: 'png', error: 'Not a PNG' });
    // Fewer than 12 trailing bytes after the last chunk are ignored.
    expect(pngChunks(cat(buildPng([ihdr(4, 4)]), [0, 0, 0])).map((c) => c.type)).toEqual(['IHDR']);
  });

  it.each([
    ['alpha-text.png', { width: 200, height: 150, hasAlpha: true, hasText: true, animated: false }],
    ['deep-16bit.png', { bitDepth: 16, hasAlpha: false }],
    ['animated.png', { animated: true, frames: 5 }],
    ['palette-efficient.png', { colorModel: 'palette', bitDepth: 4 }],
  ])('inspects the %s fixture', (name, expected) => {
    expect(inspectImage(load(name), 'png')).toMatchObject(expected);
  });
});

describe('WebP inspection', () => {
  it('reads an extended animated file with metadata', () => {
    const iccp = riffChunk('ICCP', [1, 2, 3]);
    const exif = riffChunk('EXIF', cat(latin1('Exif\0\0'), orientationTiff(true, 3)));
    const xmp = riffChunk('XMP ', latin1('<x:xmpmeta/>'));
    const bytes = buildWebp([
      vp8x(0x02 | 0x10 | 0x20 | 0x08 | 0x04, 100, 50),
      iccp,
      riffChunk('ANIM', [0, 0, 0, 0, 0, 0]),
      riffChunk('ANMF', new Uint8Array(16)),
      riffChunk('ANMF', new Uint8Array(16)),
      exif,
      xmp,
    ]);
    const info = inspectImage(bytes, 'webp');
    expect(info).toMatchObject({
      format: 'webp',
      width: 100,
      height: 50,
      animated: true,
      frames: 2,
      hasAlpha: true,
      hasIcc: true,
      hasExif: true,
      orientation: 3,
      hasXmp: true,
      lossless: false,
    });
    expect(info.metadataBytes).toBe(iccp.length + exif.length + xmp.length);
    // Odd-sized chunks are padded.
    expect(iccp.length).toBe(12);
    expect(webpChunks(bytes).map((c) => c.fourcc)).toEqual(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ANMF', 'EXIF', 'XMP ']);
  });

  it('reads simple lossy and lossless files', () => {
    const lossy = inspectImage(buildWebp([vp8(30, 20)]), 'webp');
    expect(lossy).toMatchObject({ width: 30, height: 20, lossless: false, hasAlpha: false, animated: false });
    expect(lossy).not.toHaveProperty('frames');
    expect(inspectImage(buildWebp([vp8l(16, 8, true)]), 'webp')).toMatchObject({ width: 16, height: 8, lossless: true, hasAlpha: true });
    expect(inspectImage(buildWebp([vp8l(16, 8, false)]), 'webp')).toMatchObject({ hasAlpha: false });
  });

  it('prefers the canvas size of VP8X and detects ALPH chunks', () => {
    expect(inspectImage(buildWebp([vp8x(0, 40, 30), riffChunk('ALPH', [0]), vp8(99, 99)]), 'webp')).toMatchObject({ width: 40, height: 30, hasAlpha: true });
    expect(inspectImage(buildWebp([vp8x(0, 40, 30), vp8l(99, 99, true)]), 'webp')).toMatchObject({ width: 40, height: 30, hasAlpha: true, lossless: true });
  });

  it('reports no dimensions when there is no image chunk', () => {
    const info = inspectImage(buildWebp([riffChunk('XMP ', latin1('<x/>'))]), 'webp');
    expect(info).toMatchObject({ hasXmp: true, animated: false });
    expect(info).not.toHaveProperty('width');
    expect(info).not.toHaveProperty('height');
  });

  it('reads EXIF without the Exif header', () => {
    expect(inspectImage(buildWebp([vp8(2, 2), riffChunk('EXIF', orientationTiff(false, 5))]), 'webp').orientation).toBe(5);
  });

  it('reports structural problems and tolerates a missing final pad byte', () => {
    const bytes = buildWebp([vp8(2, 2), riffChunk('XMP ', latin1('abc'))]);
    expect(inspectImage(bytes.subarray(0, bytes.length - 1), 'webp').error).toBeUndefined();
    expect(inspectImage(bytes.subarray(0, bytes.length - 3), 'webp').error).toBe('Truncated WebP chunk');
    expect(inspectImage(latin1('RIFF\x04\x00\x00\x00AVI '), 'webp').error).toBe('Not a WebP');
    expect(inspectImage(latin1('RIFF'), 'webp').error).toBe('Not a WebP');
  });

  it.each([
    ['animated.webp', { animated: true, frames: 5, width: 64, height: 48 }],
    ['lossless-alpha.webp', { lossless: true, hasAlpha: true, width: 160 }],
    ['lossy-meta.webp', { lossless: false, hasIcc: true, hasExif: true, orientation: 1 }],
  ])('inspects the %s fixture', (name, expected) => {
    expect(inspectImage(load(name), 'webp')).toMatchObject(expected);
  });
});

describe('GIF inspection', () => {
  it('counts frames and detects transparency with global and local colour tables', () => {
    const info = inspectImage(buildGif(10, 5, [{ localTable: 1, transparent: true }, {}], { globalTable: 2, comment: 'hola' }), 'gif');
    expect(info).toMatchObject({ format: 'gif', width: 10, height: 5, frames: 2, animated: true, hasAlpha: true, colorModel: 'palette', lossless: true });
  });

  it('reads a single opaque frame', () => {
    expect(inspectImage(buildGif(3, 4, [{}]), 'gif')).toMatchObject({ frames: 1, animated: false, hasAlpha: false });
    // Without the trailer the scan simply stops at the end of the data.
    const bytes = buildGif(3, 4, [{}, {}]);
    expect(inspectImage(bytes.subarray(0, bytes.length - 1), 'gif').frames).toBe(2);
  });

  it('rejects unknown blocks', () => {
    const bytes = cat(buildGif(3, 4, []).subarray(0, 13), [0x99]);
    expect(inspectImage(bytes, 'gif')).toMatchObject({ format: 'gif', error: 'Corrupt GIF block' });
  });

  it('inspects the animated fixture', () => {
    expect(inspectImage(load('animated.gif'), 'gif')).toMatchObject({ animated: true, frames: 5, hasAlpha: true });
  });
});

describe('inspectImage', () => {
  it('returns an empty description for other formats', () => {
    expect(inspectImage(latin1('BM....'), 'bmp')).toEqual({
      format: 'other',
      animated: false,
      multiImage: false,
      hasIcc: false,
      hasExif: false,
      hasXmp: false,
      hasIptc: false,
      hasText: false,
      metadataBytes: 0,
    });
  });
});
