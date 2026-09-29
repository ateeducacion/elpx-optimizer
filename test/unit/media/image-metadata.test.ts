import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { crc32 } from '../../../src/core/io/crc32.js';
import { inspectImage, jpegSegmentKind, jpegSegments, pngChunks, webpChunks } from '../../../src/core/media/image-inspect.js';
import { extractMetadata, injectMetadata, type MetadataPolicy, type PreservedMetadata } from '../../../src/core/media/image-metadata.js';
import { MEDIA } from '../../helpers/native.js';
import {
  be32,
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
  pngTypes,
  readExifIfdValue,
  readLatin1,
  riffChunk,
  sof,
  tiff,
  vp8,
  vp8l,
  vp8x,
  webpTypes,
  type TiffEntry,
} from '../../helpers/image-craft.js';

const ALL: MetadataPolicy = { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true };
const NONE: MetadataPolicy = { keepIcc: false, keepExif: false, keepXmp: false, keepIptc: false, keepText: false };
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(MEDIA, name)));
const table = new Array<number>(64).fill(4);

/** A TIFF block with orientation in IFD0 and pixel dimensions in the ExifIFD. */
function exifTiff(little: boolean, type: number, width: number, height: number, extra: TiffEntry[] = []): Uint8Array {
  return tiff(little, [{ tag: 0x0112, type: 3, value: 6 }], [{ tag: 0xa002, type, value: width }, { tag: 0xa003, type, value: height }, ...extra]);
}

/** The TIFF block inside the first EXIF APP1 segment of a JPEG. */
function jpegExifTiff(bytes: Uint8Array): Uint8Array {
  const s = jpegSegments(bytes).find((x) => jpegSegmentKind(bytes, x) === 'exif')!;
  return bytes.subarray(s.dataStart + 6, s.end);
}

/** Kinds of the APP/COM segments of a JPEG, in order. */
function jpegKinds(bytes: Uint8Array): string[] {
  return jpegSegments(bytes)
    .filter((s) => (s.marker >= 0xe0 && s.marker <= 0xef) || s.marker === 0xfe)
    .map((s) => jpegSegmentKind(bytes, s));
}

describe('JPEG metadata', () => {
  const exif = exifApp1(exifTiff(true, 3, 4000, 3000));
  const xmp = jpegSegment(0xe1, latin1('http://ns.adobe.com/xap/1.0/\0<x/>'));
  const icc = jpegSegment(0xe2, latin1('ICC_PROFILE\0\x01\x01data'));
  const iptc = jpegSegment(0xed, latin1('Photoshop 3.0\x008BIM'));
  const comment = jpegSegment(0xfe, latin1('caption'));
  const original = buildJpeg([
    jfifApp0(),
    exif,
    xmp,
    icc,
    iptc,
    comment,
    jpegSegment(0xe2, latin1('MPF\0MM')),
    jpegSegment(0xe5, latin1('Ducky')),
    dqt(table),
    sof(4000, 3000),
  ]);

  it('extracts the kinds allowed by the policy', () => {
    const all = extractMetadata(original, 'jpeg', ALL);
    expect(all.format).toBe('jpeg');
    expect(all.blocks.map((b) => b.kind)).toEqual(['exif', 'xmp', 'icc', 'iptc', 'comment']);
    expect(all.blocks[0]!.bytes).toEqual(exif);
    expect(extractMetadata(original, 'jpeg', NONE).blocks).toEqual([]);
    expect(extractMetadata(original, 'jpeg', { ...NONE, keepIcc: true, keepExif: true }).blocks.map((b) => b.kind)).toEqual(['exif', 'icc']);
    expect(extractMetadata(original, 'jpeg', { ...NONE, keepText: true, keepIptc: true, keepXmp: true }).blocks.map((b) => b.kind)).toEqual([
      'xmp',
      'iptc',
      'comment',
    ]);
  });

  it('returns the encoded bytes untouched when nothing is preserved', () => {
    const encoded = buildJpeg([dqt(table), sof(8, 8)]);
    expect(injectMetadata(encoded, { format: 'jpeg', blocks: [] })).toBe(encoded);
  });

  it('inserts preserved segments after JFIF, replacing the encoder copies and patching dimensions', () => {
    const encoderExif = exifApp1(tiff(true, [{ tag: 0x0131, type: 4, value: 1 }]));
    const adobe = jpegSegment(0xee, cat(latin1('Adobe'), [0, 100, 0, 0, 0, 0, 1]));
    const encoded = buildJpeg([jfifApp0(), encoderExif, adobe, dqt(table), sof(400, 300)]);
    const out = injectMetadata(encoded, extractMetadata(original, 'jpeg', ALL), { width: 400, height: 300 });
    expect(jpegKinds(out)).toEqual(['jfif', 'exif', 'xmp', 'icc', 'iptc', 'comment', 'adobe']);
    const t = jpegExifTiff(out);
    expect(readExifIfdValue(t, 0xa002)).toBe(400);
    expect(readExifIfdValue(t, 0xa003)).toBe(300);
    // The original block is not modified in place.
    expect(readExifIfdValue(jpegExifTiff(original), 0xa002)).toBe(4000);
    const info = inspectImage(out, 'jpeg');
    expect(info).toMatchObject({ width: 400, height: 300, orientation: 6, hasIcc: true, hasXmp: true, hasIptc: true });
    expect(info.error).toBeUndefined();
  });

  it('handles encoder output without APP segments and output made only of APP segments', () => {
    const bare = buildJpeg([dqt(table), sof(8, 8)]);
    const preserved = extractMetadata(original, 'jpeg', { ...NONE, keepIcc: true });
    const out = injectMetadata(bare, preserved);
    expect(jpegKinds(out)).toEqual(['icc']);
    expect(out.subarray(2, 2 + icc.length)).toEqual(icc);
    const onlyApp = cat([0xff, 0xd8], jfifApp0());
    expect(injectMetadata(onlyApp, preserved)).toEqual(cat([0xff, 0xd8], jfifApp0(), icc));
  });

  it('patches LONG dimensions in big-endian EXIF and leaves other tags alone', () => {
    const block = exifApp1(
      exifTiff(false, 4, 4000, 3000, [
        { tag: 0x9000, type: 7, value: 0x30323330 },
        { tag: 0xa005, type: 5, value: 77 },
      ]),
    );
    const out = injectMetadata(buildJpeg([sof(8, 8)]), { format: 'jpeg', blocks: [{ kind: 'exif', bytes: block }] }, { width: 1234, height: 567 });
    const t = jpegExifTiff(out);
    expect(readExifIfdValue(t, 0xa002)).toBe(1234);
    expect(readExifIfdValue(t, 0xa003)).toBe(567);
    expect(readExifIfdValue(t, 0x9000)).toBe(0x30323330);
    expect(readExifIfdValue(t, 0xa005)).toBe(77);
  });

  it('ignores dimension fields of unexpected types', () => {
    const block = exifApp1(exifTiff(true, 5, 4000, 3000));
    const out = injectMetadata(buildJpeg([sof(8, 8)]), { format: 'jpeg', blocks: [{ kind: 'exif', bytes: block }] }, { width: 1, height: 1 });
    expect(readExifIfdValue(jpegExifTiff(out), 0xa002)).toBe(4000);
  });

  it('leaves EXIF unchanged without new dimensions or a usable ExifIFD', () => {
    const encoded = buildJpeg([sof(8, 8)]);
    const run = (t: Uint8Array, options: { width?: number; height?: number }): Uint8Array =>
      jpegExifTiff(injectMetadata(encoded, { format: 'jpeg', blocks: [{ kind: 'exif', bytes: exifApp1(t) }] }, options));
    const full = exifTiff(true, 3, 4000, 3000);
    expect(run(full, {})).toEqual(full);
    expect(run(full, { width: 10 })).toEqual(full);
    const noExifIfd = tiff(true, [{ tag: 0x0112, type: 3, value: 1 }]);
    expect(run(noExifIfd, { width: 1, height: 1 })).toEqual(noExifIfd);
    const dangling = tiff(true, [{ tag: 0x8769, type: 4, value: 9999 }]);
    expect(run(dangling, { width: 1, height: 1 })).toEqual(dangling);
    // The ExifIFD claims two entries but the block ends inside the second one.
    const truncated = full.subarray(0, full.length - 4 - 6);
    const patched = run(truncated, { width: 11, height: 22 });
    expect(readExifIfdValue(patched, 0xa002)).toBe(11);
    expect(patched.subarray(patched.length - 6)).toEqual(truncated.subarray(truncated.length - 6));
  });

  it('keeps orientation, ICC and XMP of a real photo through a sharp re-encode', async () => {
    const photo = load('photo-exif-icc.jpg');
    const encoded = new Uint8Array(await sharp(photo).resize(160).jpeg({ quality: 70 }).toBuffer());
    expect(inspectImage(encoded, 'jpeg').hasIcc).toBe(false);
    const out = injectMetadata(encoded, extractMetadata(photo, 'jpeg', ALL), { width: 160, height: 120 });
    const info = inspectImage(out, 'jpeg');
    expect(info).toMatchObject({ width: 160, height: 120, orientation: 6, hasIcc: true, hasXmp: true, hasExif: true });
    const meta = await sharp(out).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.icc?.length).toBe((await sharp(photo).metadata()).icc?.length);
  });
});

describe('PNG metadata', () => {
  const eXIf = pngChunk('eXIf', exifTiff(false, 4, 4000, 3000));
  const iccp = pngChunk('iCCP', latin1('icc\0\0xyz'));
  const text = pngChunk('tEXt', latin1('Author\0me'));
  const xmp = pngChunk('iTXt', latin1('XML:com.adobe.xmp\0\0\0\0\0<x/>'));
  const caption = pngChunk('iTXt', latin1('Caption\0\0\0\0\0hola'));
  const original = buildPng([
    ihdr(4000, 3000),
    iccp,
    pngChunk('cHRM', new Uint8Array(32)),
    pngChunk('cICP', [1, 13, 0, 1]),
    pngChunk('pHYs', new Uint8Array(9)),
    eXIf,
    text,
    pngChunk('zTXt', latin1('C\0\0x')),
    xmp,
    caption,
    pngChunk('tIME', new Uint8Array(7)),
    pngChunk('bKGD', [0, 0]),
    pngChunk('IDAT', [1, 2, 3]),
    pngChunk('IEND'),
  ]);

  it('extracts colour, EXIF and text chunks according to the policy', () => {
    expect(extractMetadata(original, 'png', ALL).blocks.map((b) => b.kind)).toEqual([
      'iCCP',
      'cHRM',
      'cICP',
      'pHYs',
      'eXIf',
      'tEXt',
      'zTXt',
      'iTXt',
      'iTXt',
      'tIME',
    ]);
    expect(
      extractMetadata(original, 'png', { ...ALL, keepXmp: false })
        .blocks.filter((b) => b.kind === 'iTXt')
        .map((b) => b.bytes),
    ).toEqual([caption]);
    expect(extractMetadata(original, 'png', { ...NONE, keepIcc: true }).blocks.map((b) => b.kind)).toEqual(['iCCP', 'cHRM', 'cICP', 'pHYs']);
    expect(extractMetadata(original, 'png', NONE).blocks).toEqual([]);
  });

  it('inserts the chunks after IHDR, dropping encoder colour chunks and rebuilding eXIf', () => {
    const encoded = buildPng([
      ihdr(400, 300),
      pngChunk('sRGB', [0]),
      pngChunk('gAMA', be32(45455)),
      pngChunk('pHYs', new Uint8Array(9)),
      pngChunk('tEXt', latin1('Software\0encoder')),
      pngChunk('IDAT', [9, 9]),
      pngChunk('IEND'),
    ]);
    const out = injectMetadata(encoded, extractMetadata(original, 'png', ALL), { width: 400, height: 300 });
    expect(pngTypes(out)).toEqual(['IHDR', 'iCCP', 'cHRM', 'cICP', 'pHYs', 'eXIf', 'tEXt', 'zTXt', 'iTXt', 'iTXt', 'tIME', 'IDAT', 'IEND']);
    const chunk = pngChunks(out).find((c) => c.type === 'eXIf')!;
    const data = out.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    expect(readExifIfdValue(data, 0xa002)).toBe(400);
    expect(readExifIfdValue(data, 0xa003)).toBe(300);
    const storedCrc = new DataView(out.buffer, out.byteOffset + chunk.end - 4, 4).getUint32(0);
    expect(storedCrc).toBe(crc32(out.subarray(chunk.start + 4, chunk.end - 4)));
    expect(readLatin1(out).includes('encoder')).toBe(false);
    expect(inspectImage(out, 'png')).toMatchObject({ width: 400, height: 300, hasIcc: true, hasExif: true, orientation: 6, hasXmp: true, hasText: true });
  });

  it('keeps the encoder colour chunks when no colour metadata is preserved', () => {
    const encoded = buildPng([ihdr(4, 4), pngChunk('sRGB', [0]), pngChunk('gAMA', be32(45455)), pngChunk('IDAT', [1]), pngChunk('IEND')]);
    const out = injectMetadata(encoded, { format: 'png', blocks: [{ kind: 'tEXt', bytes: text }] });
    expect(pngTypes(out)).toEqual(['IHDR', 'tEXt', 'sRGB', 'gAMA', 'IDAT', 'IEND']);
  });

  it('keeps text chunks of a real PNG through a sharp re-encode', async () => {
    const png = load('alpha-text.png');
    const encoded = new Uint8Array(await sharp(png).png({ compressionLevel: 9 }).toBuffer());
    expect(inspectImage(encoded, 'png').hasText).toBe(false);
    const out = injectMetadata(encoded, extractMetadata(png, 'png', ALL));
    expect(inspectImage(out, 'png')).toMatchObject({ hasText: true, hasAlpha: true, width: 200, height: 150 });
    expect((await sharp(out).metadata()).width).toBe(200);
  });
});

describe('WebP metadata', () => {
  const iccPayload = latin1('icc-profile');
  const exifPayload = cat(latin1('Exif\0\0'), exifTiff(true, 4, 4000, 3000));
  const xmpPayload = latin1('<x:xmpmeta/>');
  const original = buildWebp([
    vp8x(0x2c, 4000, 3000),
    riffChunk('ICCP', iccPayload),
    vp8(4000, 3000),
    riffChunk('EXIF', exifPayload),
    riffChunk('XMP ', xmpPayload),
  ]);

  it('extracts chunk payloads according to the policy', () => {
    const all = extractMetadata(original, 'webp', ALL);
    expect(all.blocks).toEqual([
      { kind: 'ICCP', bytes: iccPayload },
      { kind: 'EXIF', bytes: exifPayload },
      { kind: 'XMP ', bytes: xmpPayload },
    ]);
    expect(extractMetadata(original, 'webp', { ...NONE, keepExif: true }).blocks.map((b) => b.kind)).toEqual(['EXIF']);
    expect(extractMetadata(original, 'webp', NONE).blocks).toEqual([]);
    expect(extractMetadata(load('lossy-meta.webp'), 'webp', ALL).blocks.map((b) => b.kind)).toEqual(['ICCP', 'EXIF']);
  });

  it('rebuilds a simple lossy file as an extended one', () => {
    const out = injectMetadata(buildWebp([vp8(400, 300)]), extractMetadata(original, 'webp', ALL), { width: 400, height: 300 });
    expect(webpTypes(out)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'EXIF', 'XMP ']);
    expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
    expect(out[20]).toBe(0x2c);
    const info = inspectImage(out, 'webp');
    expect(info).toMatchObject({ width: 400, height: 300, hasIcc: true, hasExif: true, hasXmp: true, orientation: 6, hasAlpha: false });
    const exif = webpChunks(out).find((c) => c.fourcc === 'EXIF')!;
    const t = out.subarray(exif.dataStart + 6, exif.dataStart + exif.size);
    expect(readExifIfdValue(t, 0xa002)).toBe(400);
    expect(readExifIfdValue(t, 0xa003)).toBe(300);
  });

  it('patches EXIF payloads without the Exif header and pads odd payloads', () => {
    const raw = exifTiff(false, 3, 4000, 3000);
    const oddXmp = latin1('<x/>a');
    const out = injectMetadata(
      buildWebp([vp8(8, 8)]),
      {
        format: 'webp',
        blocks: [
          { kind: 'EXIF', bytes: raw },
          { kind: 'XMP ', bytes: oddXmp },
        ],
      },
      { width: 8, height: 8 },
    );
    const exif = webpChunks(out).find((c) => c.fourcc === 'EXIF')!;
    expect(readExifIfdValue(out.subarray(exif.dataStart, exif.dataStart + exif.size), 0xa002)).toBe(8);
    expect(out.length % 2).toBe(0);
    expect(out[20]).toBe(0x0c);
  });

  it('carries alpha from VP8X, ALPH and VP8L chunks', () => {
    const xmpOnly: PreservedMetadata = { format: 'webp', blocks: [{ kind: 'XMP ', bytes: xmpPayload }] };
    const withAlph = injectMetadata(buildWebp([vp8x(0x10, 40, 30), riffChunk('ALPH', [0, 1]), vp8(40, 30)]), xmpOnly);
    expect(webpTypes(withAlph)).toEqual(['VP8X', 'ALPH', 'VP8 ', 'XMP ']);
    expect(withAlph[20]).toBe(0x14);
    expect(inspectImage(withAlph, 'webp')).toMatchObject({ width: 40, height: 30, hasAlpha: true });
    const alphOnly = injectMetadata(buildWebp([vp8x(0, 40, 30), riffChunk('ALPH', [0]), vp8(40, 30)]), xmpOnly);
    expect(alphOnly[20]).toBe(0x14);
    const lossless = injectMetadata(buildWebp([vp8l(17, 9, true)]), xmpOnly);
    expect(inspectImage(lossless, 'webp')).toMatchObject({ width: 17, height: 9, hasAlpha: true, lossless: true, hasXmp: true });
    const opaque = injectMetadata(buildWebp([vp8x(0, 17, 9), vp8l(17, 9, false)]), xmpOnly);
    expect(opaque[20]).toBe(0x04);
  });

  it('keeps encoder metadata chunks that are not replaced and announces them in VP8X', () => {
    const encoded = buildWebp([vp8x(0x20, 8, 8), riffChunk('ICCP', latin1('encoder-icc')), vp8(8, 8), riffChunk('EXIF', latin1('encoder-exif'))]);
    const out = injectMetadata(encoded, { format: 'webp', blocks: [{ kind: 'EXIF', bytes: exifPayload }] });
    expect(webpTypes(out)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'EXIF']);
    expect(out[20]).toBe(0x28);
    expect(readLatin1(out).includes('encoder-exif')).toBe(false);
    expect(readLatin1(out).includes('encoder-icc')).toBe(true);
  });

  it('keeps the ICC profile of the encoder visible to decoders', async () => {
    const encoded = new Uint8Array(await sharp(load('lossy-meta.webp')).withIccProfile('srgb').webp({ quality: 50 }).toBuffer());
    expect(webpTypes(encoded)).toContain('ICCP');
    const out = injectMetadata(encoded, { format: 'webp', blocks: [{ kind: 'XMP ', bytes: latin1('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>') }] });
    const meta = await sharp(out).metadata();
    expect(meta.icc?.length).toBeGreaterThan(0);
    expect(meta.xmp?.length).toBeGreaterThan(0);
  });

  it('refuses encoder output with animation chunks', () => {
    const animated = buildWebp([vp8x(0x02, 8, 8), riffChunk('ANIM', new Uint8Array(6)), riffChunk('ANMF', new Uint8Array(16))]);
    expect(() => injectMetadata(animated, { format: 'webp', blocks: [{ kind: 'XMP ', bytes: xmpPayload }] })).toThrow(
      'Unsupported WebP chunk ANIM in encoder output',
    );
  });

  it('keeps ICC and EXIF of a real WebP through a sharp re-encode', async () => {
    const webp = load('lossy-meta.webp');
    const encoded = new Uint8Array(await sharp(webp).resize(100).webp({ quality: 60 }).toBuffer());
    expect(webpTypes(encoded)).toEqual(['VP8 ']);
    const out = injectMetadata(encoded, extractMetadata(webp, 'webp', ALL), { width: 100, height: 75 });
    expect(inspectImage(out, 'webp')).toMatchObject({ width: 100, height: 75, hasIcc: true, hasExif: true });
    const meta = await sharp(out).metadata();
    expect(meta.icc?.length).toBe((await sharp(webp).metadata()).icc?.length);
    expect(meta.exif?.length).toBeGreaterThan(0);
  });
});
