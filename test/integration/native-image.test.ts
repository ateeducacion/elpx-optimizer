import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { NativeMediaEngine } from '../../src/adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../src/adapters/node/resource-store.js';
import { decideImage, IMAGE_PROFILES, type ImageOptions } from '../../src/core/media/image-policy.js';
import { inspectImage } from '../../src/core/media/image-inspect.js';
import { extractMetadata, injectMetadata } from '../../src/core/media/image-metadata.js';
import { sniff, extensionMatches } from '../../src/core/media/sniff.js';
import { NATIVE_LIMITS } from '../../src/core/limits.js';
import { MEDIA } from '../helpers/native.js';

const opts: ImageOptions = {
  enabled: true,
  preset: 'balanced',
  jpegQuality: IMAGE_PROFILES.balanced.jpegQuality,
  webpQuality: IMAGE_PROFILES.balanced.webpQuality,
  maxDimension: undefined,
  png: true,
  stripMetadata: false,
  minSavingsPercent: 5,
  minSavingsBytes: 512,
  force: false,
};

const load = (name: string) => new Uint8Array(readFileSync(join(MEDIA, name)));

describe('native image pipeline', () => {
  let store: NodeResourceStore;
  let engine: NativeMediaEngine;
  beforeAll(async () => {
    store = await NodeResourceStore.create();
    engine = new NativeMediaEngine(store);
  });
  afterAll(() => store.disposeAll());
  const ctx = { resourcePath: 'x', timeoutMs: 60_000 };

  async function decide(name: string, o: Partial<ImageOptions> = {}, sensitive = false) {
    const bytes = load(name);
    const s = sniff(bytes.subarray(0, 512), name);
    const info = s.kind === 'image' ? inspectImage(bytes, s.format) : undefined;
    const caps = (await engine.info()).image;
    return {
      bytes,
      info,
      decision: decideImage(
        { format: s.format, size: bytes.length, info, extensionMatches: extensionMatches(name, s), resolutionSensitive: sensitive },
        { ...opts, ...o },
        caps,
        NATIVE_LIMITS,
      ),
    };
  }

  it('re-encodes a high quality JPEG keeping EXIF orientation, ICC and XMP', async () => {
    const { bytes, info, decision } = await decide('photo-exif-icc.jpg');
    expect(info?.orientation).toBe(6);
    expect(info?.hasIcc).toBe(true);
    expect(info?.hasXmp).toBe(true);
    expect(info?.jpegQuality).toBeGreaterThanOrEqual(95);
    expect(decision.action).toBe('encode');
    if (decision.action !== 'encode') return;
    const encoded = await engine.encodeImage(bytes, decision.job, ctx);
    const out = injectMetadata(encoded, extractMetadata(bytes, 'jpeg', decision.job.metadata));
    expect(out.length).toBeLessThan(bytes.length);
    const outInfo = inspectImage(out, 'jpeg');
    expect(outInfo.orientation).toBe(6);
    expect(outInfo.hasIcc).toBe(true);
    expect(outInfo.hasXmp).toBe(true);
    expect(outInfo.width).toBe(320);
    const meta = await sharp(out).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.icc?.length).toBe((await sharp(bytes).metadata()).icc?.length);
    const v = await engine.verifyImage(bytes, out, decision.job, ctx);
    expect(v.ok).toBe(true);
  });

  it('strips authorship metadata only on request, keeping ICC and orientation EXIF', async () => {
    const { bytes, decision } = await decide('photo-exif-icc.jpg', { stripMetadata: true });
    if (decision.action !== 'encode') throw new Error('expected encode');
    expect(decision.job.metadata).toMatchObject({ keepIcc: true, keepExif: true, keepXmp: false });
    const encoded = await engine.encodeImage(bytes, decision.job, ctx);
    const out = injectMetadata(encoded, extractMetadata(bytes, 'jpeg', decision.job.metadata));
    const outInfo = inspectImage(out, 'jpeg');
    expect(outInfo.hasXmp).toBe(false);
    expect(outInfo.orientation).toBe(6);
  });

  it('optimizes PNG losslessly, keeping alpha and text chunks, with pixel verification', async () => {
    const { bytes, info, decision } = await decide('alpha-text.png');
    expect(info?.hasAlpha).toBe(true);
    expect(info?.hasText).toBe(true);
    if (decision.action !== 'encode') throw new Error('expected encode');
    expect(decision.job.mode).toBe('lossless');
    const encoded = await engine.encodeImage(bytes, decision.job, ctx);
    const out = injectMetadata(encoded, extractMetadata(bytes, 'png', decision.job.metadata));
    expect(out.length).toBeLessThan(bytes.length);
    expect(inspectImage(out, 'png').hasText).toBe(true);
    const v = await engine.verifyImage(bytes, out, decision.job, ctx);
    expect(v).toMatchObject({ ok: true, identicalPixels: true, hasAlpha: true });
  });

  it('recompresses lossless WebP with alpha and resizes JPEG when capped', async () => {
    const { bytes, decision } = await decide('lossless-alpha.webp');
    if (decision.action !== 'encode') throw new Error('expected encode');
    const encoded = await engine.encodeImage(bytes, decision.job, ctx);
    const v = await engine.verifyImage(bytes, encoded, decision.job, ctx);
    expect(v.identicalPixels).toBe(true);
    const r = await decide('progressive.jpg', { maxDimension: 160 });
    if (r.decision.action !== 'encode') throw new Error('expected encode');
    expect(r.decision.job.resize).toEqual({ width: 160, height: 120 });
    const resized = await engine.encodeImage(r.bytes, r.decision.job, ctx);
    expect((await engine.verifyImage(r.bytes, resized, r.decision.job, ctx)).ok).toBe(true);
    const sensitive = await decide('progressive.jpg', { maxDimension: 160 }, true);
    expect(sensitive.decision.action === 'encode' && sensitive.decision.job.resize).toBeUndefined();
  });

  it('keeps ICC and EXIF in WebP output', async () => {
    const { bytes, info, decision } = await decide('lossy-meta.webp', { force: true });
    expect(info?.hasIcc).toBe(true);
    expect(info?.hasExif).toBe(true);
    if (decision.action !== 'encode') throw new Error('expected encode');
    const encoded = await engine.encodeImage(bytes, decision.job, ctx);
    const out = injectMetadata(encoded, extractMetadata(bytes, 'webp', decision.job.metadata));
    const outInfo = inspectImage(out, 'webp');
    expect(outInfo.hasIcc).toBe(true);
    expect(outInfo.hasExif).toBe(true);
    expect((await sharp(out).metadata()).icc?.length).toBeGreaterThan(0);
  });

  it.each([
    ['efficient.jpg', 'already-efficient'],
    ['cmyk.jpg', 'cmyk'],
    ['deep-16bit.png', 'high-bit-depth'],
    ['animated.png', 'animated'],
    ['animated.webp', 'animated'],
    ['animated.gif', 'unsupported-format'],
    ['jpeg-named.png', 'extension-mismatch'],
    ['truncated.jpg', 'corrupt'],
    ['diagram.svg', 'vector-image'],
    ['lossy-meta.webp', 'already-efficient'],
  ])('skips %s (%s)', async (name, reason) => {
    const { decision } = await decide(name);
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') expect(decision.reason).toBe(reason);
  });

  it('reports verification problems for a wrong candidate', async () => {
    const { bytes, decision } = await decide('alpha-text.png');
    if (decision.action !== 'encode') throw new Error('expected encode');
    const wrong = new Uint8Array(await sharp(bytes).flatten({ background: '#fff' }).resize(10, 10).png().toBuffer());
    const v = await engine.verifyImage(bytes, wrong, decision.job, ctx);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/size|transparency|pixel/);
    const garbage = await engine.verifyImage(bytes, new Uint8Array([1, 2, 3]), decision.job, ctx);
    expect(garbage.ok).toBe(false);
  });
});
