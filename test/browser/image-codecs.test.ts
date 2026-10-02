import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import photoUrl from '../fixtures/media/photo-exif-icc.jpg?url';
import progressiveUrl from '../fixtures/media/progressive.jpg?url';
import alphaPngUrl from '../fixtures/media/alpha-text.png?url';
import alphaWebpUrl from '../fixtures/media/lossless-alpha.webp?url';
import lossyWebpUrl from '../fixtures/media/lossy-meta.webp?url';
import { CODEC_VERSIONS, createJsquashCodecs, type ImageCodecs, type RawImage } from '../../src/adapters/browser/image-codecs.js';
import { BrowserMediaEngine } from '../../src/adapters/browser/browser-media-engine.js';
import { BlobStore } from '../../src/adapters/browser/blob-io.js';
import { FFMPEG_ASSETS } from '../../src/adapters/browser/ffmpeg-assets.js';
import { inspectImage } from '../../src/core/media/image-inspect.js';
import type { ImageJob } from '../../src/core/media/image-policy.js';
import { fixtureBytes, imageJobFor, opaquePng } from './helpers.js';

const ctx = { resourcePath: 'content/resources/x', timeoutMs: 60_000 };

/** True when any pixel is not fully opaque. */
function transparent(img: RawImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 255) return true;
  return false;
}

// Production runs the codecs in image workers; the in-process run exercises the same code on this page.
describe.each([
  ['the image worker pool', false],
  ['in-process codecs', true],
] as const)('jSquash codecs (real WebAssembly) through %s', (_via, inProcess) => {
  let codecs: ImageCodecs;
  let engine: BrowserMediaEngine;
  let photo: Uint8Array;
  let alphaPng: Uint8Array;
  let alphaWebp: Uint8Array;

  beforeAll(async () => {
    codecs = createJsquashCodecs();
    engine = new BrowserMediaEngine({ store: new BlobStore(), assets: FFMPEG_ASSETS, threading: 'single', ...(inProcess ? { codecs } : {}) });
    [photo, alphaPng, alphaWebp] = await Promise.all([fixtureBytes(photoUrl), fixtureBytes(alphaPngUrl), fixtureBytes(alphaWebpUrl)]);
  });

  afterAll(async () => {
    await engine.dispose();
  });

  it('advertises the pinned codec versions', async () => {
    const info = await engine.info();
    expect(info.versions).toMatchObject(CODEC_VERSIONS);
    expect(info.image).toMatchObject({
      available: true,
      canResize: true,
      encoders: { jpeg: CODEC_VERSIONS['@jsquash/jpeg'], png: CODEC_VERSIONS['@jsquash/oxipng'], webp: CODEC_VERSIONS['@jsquash/webp'] },
    });
  });

  it('re-encodes a JPEG lossily at the target quality and verifies it', async () => {
    const job = imageJobFor(photo, 'jpeg', { jpegQuality: 60 });
    expect(job).toMatchObject({ format: 'jpeg', mode: 'lossy', quality: 60, resize: undefined });
    const out = await engine.encodeImage(photo, job, ctx);
    const info = inspectImage(out, 'jpeg');
    expect(info).toMatchObject({ format: 'jpeg', width: job.expected.width, height: job.expected.height, progressive: true });
    expect(info.error).toBeUndefined();
    expect(out.length).toBeLessThan(photo.length);
    const v = await engine.verifyImage(photo, out, job, ctx);
    expect(v).toEqual({ ok: true, width: job.expected.width, height: job.expected.height, hasAlpha: false, problems: [] });
  });

  it('uses quality 82 when a lossy job carries no quality', async () => {
    const progressive = await fixtureBytes(progressiveUrl);
    const job = imageJobFor(progressive, 'jpeg', { jpegQuality: 82 });
    const implicit = await engine.encodeImage(progressive, { ...job, quality: undefined }, ctx);
    const explicit = await engine.encodeImage(progressive, job, ctx);
    // MozJPEG is deterministic: the same quality gives the same bytes.
    expect(implicit).toEqual(explicit);
    expect(await engine.encodeImage(progressive, { ...job, quality: 50 }, ctx)).not.toEqual(explicit);
  });

  it('recompresses a PNG losslessly with OxiPNG, pixel-identical', async () => {
    const job = imageJobFor(alphaPng, 'png');
    expect(job).toMatchObject({ format: 'png', mode: 'lossless', resize: undefined, expected: { hasAlpha: true } });
    const out = await engine.encodeImage(alphaPng, job, ctx);
    expect(inspectImage(out, 'png').error).toBeUndefined();
    expect(out.length).toBeLessThanOrEqual(alphaPng.length);
    const v = await engine.verifyImage(alphaPng, out, job, ctx);
    expect(v).toMatchObject({ ok: true, hasAlpha: true, identicalPixels: true, problems: [] });
  });

  it('recompresses a lossless WebP keeping exact pixels and alpha', async () => {
    const job = imageJobFor(alphaWebp, 'webp');
    expect(job).toMatchObject({ format: 'webp', mode: 'lossless', expected: { hasAlpha: true } });
    const out = await engine.encodeImage(alphaWebp, job, ctx);
    expect(inspectImage(out, 'webp')).toMatchObject({ format: 'webp', lossless: true, hasAlpha: true });
    const v = await engine.verifyImage(alphaWebp, out, job, ctx);
    expect(v).toMatchObject({ ok: true, hasAlpha: true, identicalPixels: true });
  });

  it('resizes PNG, JPEG and lossy WebP to the planned size', async () => {
    const pngJob = imageJobFor(alphaPng, 'png', { maxDimension: 64 });
    expect(pngJob.resize).toBeDefined();
    const png = await engine.encodeImage(alphaPng, pngJob, ctx);
    expect(inspectImage(png, 'png')).toMatchObject({ width: pngJob.resize!.width, height: pngJob.resize!.height });
    // Resized lossless jobs are not compared pixel by pixel; transparency must survive.
    const pngCheck = await engine.verifyImage(alphaPng, png, pngJob, ctx);
    expect(pngCheck).toMatchObject({ ok: true, hasAlpha: true });
    expect(pngCheck.identicalPixels).toBeUndefined();

    const jpegJob = imageJobFor(photo, 'jpeg', { maxDimension: 100 });
    const jpeg = await engine.encodeImage(photo, jpegJob, ctx);
    expect(inspectImage(jpeg, 'jpeg')).toMatchObject({ width: jpegJob.resize!.width, height: jpegJob.resize!.height });

    const lossyWebp = await fixtureBytes(lossyWebpUrl);
    const webpJob = imageJobFor(lossyWebp, 'webp', { maxDimension: 64 });
    expect(webpJob).toMatchObject({ mode: 'lossy', quality: 82 });
    const webp = await engine.encodeImage(lossyWebp, webpJob, ctx);
    expect(inspectImage(webp, 'webp')).toMatchObject({ width: webpJob.resize!.width, height: webpJob.resize!.height, lossless: false });
    const lossyDefault = await engine.encodeImage(lossyWebp, { ...webpJob, quality: undefined }, ctx);
    expect(inspectImage(lossyDefault, 'webp').lossless).toBe(false);
  });

  it('resizes without adding colours, so the PNG compresses as with sharp (#36)', async () => {
    // One colour under an alpha gradient: premultiplied or linear-light resizing rounds it into many.
    const width = 256;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([200, 120, 40, 1 + (i % width)], i * 4);
    const encodePng = (await import('@jsquash/png/encode.js')).default;
    const png = new Uint8Array(await encodePng(new ImageData(data, width, height)));
    const job = imageJobFor(png, 'png', { maxDimension: 128 });
    const out = await codecs.decode('png', await engine.encodeImage(png, job, ctx));
    const colours = new Set<number>();
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3]! > 0) colours.add((out.data[i]! << 16) | (out.data[i + 1]! << 8) | out.data[i + 2]!);
    expect(colours.size).toBe(1);
  });

  it('rejects candidates of the wrong size', async () => {
    const job = imageJobFor(photo, 'jpeg');
    const out = await engine.encodeImage(photo, job, ctx);
    const v = await engine.verifyImage(photo, out, { ...job, expected: { ...job.expected, width: job.expected.width + 2 } }, ctx);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([`size ${job.expected.width}x${job.expected.height} instead of ${job.expected.width + 2}x${job.expected.height}`]);
  });

  it('rejects lossless candidates whose pixels changed or whose size differs', async () => {
    const job = imageJobFor(alphaPng, 'png');
    const { width, height } = job.expected;
    const changed = await engine.verifyImage(alphaPng, await opaquePng(width, height), job, ctx);
    expect(changed).toMatchObject({ ok: false, identicalPixels: false, hasAlpha: false, problems: ['lossless re-encoding changed pixel values'] });
    const smaller = await engine.verifyImage(alphaPng, await opaquePng(width - 2, height), job, ctx);
    expect(smaller.identicalPixels).toBe(false);
    expect(smaller.problems).toHaveLength(2);
  });

  it('rejects candidates that lost transparency', async () => {
    const job = imageJobFor(alphaPng, 'png', { maxDimension: 64 });
    const { width, height } = job.resize!;
    const v = await engine.verifyImage(alphaPng, await opaquePng(width, height), job, ctx);
    expect(v).toMatchObject({ ok: false, hasAlpha: false, problems: ['transparency was lost'] });
    // An opaque original may produce an opaque candidate even when alpha was expected.
    const opaque = await opaquePng(200, 100);
    const opaqueJob: ImageJob = { ...imageJobFor(opaque, 'png', { maxDimension: 64 }), expected: { width: 64, height: 32, hasAlpha: true } };
    const ok = await engine.verifyImage(opaque, await opaquePng(64, 32), opaqueJob, ctx);
    expect(ok).toMatchObject({ ok: true, hasAlpha: false });
  });

  it('rejects undecodable candidates', async () => {
    const job = imageJobFor(photo, 'jpeg');
    const v = await engine.verifyImage(photo, new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]), job, ctx);
    expect(v).toMatchObject({ ok: false, width: 0, height: 0, hasAlpha: false });
    expect(v.problems[0]).toMatch(/^candidate cannot be decoded: /);
    const webp = await engine.verifyImage(alphaWebp, new TextEncoder().encode('RIFF....WEBPjunk'), imageJobFor(alphaWebp, 'webp'), ctx);
    expect(webp.ok).toBe(false);
  });

  it('decodes each format without colour conversion', async () => {
    const png = await codecs.decode('png', alphaPng);
    expect(transparent(png)).toBe(true);
    const jpeg = await codecs.decode('jpeg', photo);
    expect(transparent(jpeg)).toBe(false);
    expect(jpeg.data.length).toBe(jpeg.width * jpeg.height * 4);
  });
});
