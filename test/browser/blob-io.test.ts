import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { BlobByteSource, BlobOutputTarget, BlobResource, BlobSink, BlobStore } from '../../src/adapters/browser/blob-io.js';
import { MemoryByteSource } from '../../src/core/io/byte-source.js';
import { BROWSER_LIMITS } from '../../src/core/limits.js';
import { openZip } from '../../src/core/zip/reader.js';

const enc = new TextEncoder();

/** Bytes 0..n-1 (mod 256), easy to check after ranged reads. */
function ramp(n: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: n }, (_, i) => i % 256);
}

/** Reads a Blob back into bytes. */
async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** A Blob-shaped object whose reads always fail (a moved or modified File). */
function unreadableBlob(size: number): Blob {
  return { size, slice: () => ({ arrayBuffer: () => Promise.reject(new DOMException('NotReadableError')) }) } as unknown as Blob;
}

describe('BlobByteSource', () => {
  it('reads byte ranges without loading the whole blob', async () => {
    const src = new BlobByteSource(new Blob([ramp(1000)]));
    expect(src.size).toBe(1000);
    expect([...(await src.read(10, 5))]).toEqual([10, 11, 12, 13, 14]);
    expect(await src.read(1000, 0)).toHaveLength(0);
    expect(await bytesOf(src.slice(998, 1000))).toEqual(new Uint8Array([998 % 256, 999 % 256]));
  });

  it('rejects invalid ranges and unreadable files', async () => {
    const src = new BlobByteSource(new Blob([ramp(10)]));
    await expect(src.read(5, 10)).rejects.toMatchObject({ code: 'zip-structure' });
    await expect(src.read(-1, 1)).rejects.toMatchObject({ code: 'io' });
    await expect(new BlobByteSource(unreadableBlob(10)).read(0, 4)).rejects.toMatchObject({ code: 'io', message: expect.stringMatching(/could not be read/) });
  });
});

describe('BlobSink', () => {
  it('collects written chunks and zero-copy Blob slices', async () => {
    const sink = new BlobSink();
    const chunk = enc.encode('head');
    await sink.write(chunk);
    chunk.fill(0); // the sink keeps its own copy
    const source = new BlobByteSource(new Blob([enc.encode('0123456789')]));
    await sink.writeRange(source, 2, 6);
    expect(sink.bytesWritten).toBe(8);
    const out = sink.toBlob();
    expect(out.type).toBe('application/zip');
    expect(new TextDecoder().decode(await bytesOf(out))).toBe('head2345');
    expect(sink.toBlob('text/plain').type).toBe('text/plain');
  });

  it('streams ranges of non-Blob sources, with and without a signal', async () => {
    const sink = new BlobSink();
    const mem = new MemoryByteSource(enc.encode('abcdefghij'));
    await sink.writeRange(mem, 0, 3);
    await sink.writeRange(mem, 7, 10, new AbortController().signal);
    expect(sink.bytesWritten).toBe(6);
    expect(new TextDecoder().decode(await bytesOf(sink.toBlob()))).toBe('abchij');
  });

  it('refuses to write after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const sink = new BlobSink();
    await expect(sink.writeRange(new BlobByteSource(new Blob(['xyz'])), 0, 3, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(sink.bytesWritten).toBe(0);
  });
});

describe('BlobResource', () => {
  it('opens its blob until it is released', async () => {
    const r = new BlobResource(new Blob(['12345']), 'r1.bin');
    expect(r.size).toBe(5);
    expect(r.name).toBe('r1.bin');
    const src = await r.open();
    expect(new TextDecoder().decode(await src.read(1, 3))).toBe('234');
    await r.dispose();
    expect(r.size).toBe(0);
    await expect(r.open()).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('BlobStore', () => {
  const video = ramp(200_000);
  const text = enc.encode('hello '.repeat(5000));

  /** Opens a ZIP built with fflate over a Blob (stored and deflated entries). */
  async function archive(): Promise<Awaited<ReturnType<typeof openZip>>> {
    const zip = zipSync({ 'media/stored.mp4': [video, { level: 0 }], 'text/deflated.txt': [text, { level: 6 }] });
    return openZip(new BlobByteSource(new Blob([zip])), BROWSER_LIMITS);
  }

  it('exposes stored entries as slices of the input and inflates deflated ones', async () => {
    const zip = await archive();
    const stored = zip.byName.get('media/stored.mp4')!;
    const deflated = zip.byName.get('text/deflated.txt')!;
    expect(stored.method).toBe(0);
    expect(deflated.method).toBe(8);
    const store = new BlobStore();
    const a = await store.fromEntry(zip, stored, 'MP4');
    expect(a.name).toBe('r1.mp4');
    expect(await bytesOf(a.blob)).toEqual(video);
    const b = await store.fromEntry(zip, deflated, 'txt', new AbortController().signal);
    expect(b.name).toBe('r2.txt');
    expect(b.size).toBe(text.length);
    expect(await bytesOf(b.blob)).toEqual(text);
  });

  it('copies stored entries when the archive is not backed by a Blob', async () => {
    const zip = zipSync({ 'a.bin': [ramp(300), { level: 0 }] });
    const mem = await openZip(new MemoryByteSource(zip), BROWSER_LIMITS);
    const store = new BlobStore();
    const r = await store.fromEntry(mem, mem.byName.get('a.bin')!, 'bin');
    expect(await bytesOf(r.blob)).toEqual(ramp(300));
  });

  it('stops extracting when cancelled', async () => {
    const zip = await archive();
    const controller = new AbortController();
    controller.abort();
    await expect(new BlobStore().fromEntry(zip, zip.byName.get('text/deflated.txt')!, 'txt', controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('wraps bytes and engine blobs with safe synthetic names, and releases them all', async () => {
    const store = new BlobStore();
    const bytes = enc.encode('png!');
    const fromBytes = await store.fromBytes(bytes, 'png');
    bytes.fill(0);
    expect(new TextDecoder().decode(await bytesOf(fromBytes.blob))).toBe('png!');
    const adopted = store.adopt(new Blob(['out']), '../../etc');
    expect(fromBytes.name).toBe('r1.png');
    expect(adopted.name).toBe('r2.bin');
    expect(store.adopt(new Blob([]), 'toolongext').name).toBe('r3.bin');
    await store.disposeAll();
    await expect(fromBytes.open()).rejects.toMatchObject({ code: 'internal' });
    await expect(adopted.open()).rejects.toMatchObject({ code: 'internal' });
    // Already cleared: a second call is a no-op.
    await store.disposeAll();
  });
});

describe('BlobOutputTarget', () => {
  it('delivers the written parts on finish', async () => {
    const target = new BlobOutputTarget();
    expect(target.blob).toBeUndefined();
    await target.sink.write(enc.encode('PK-data'));
    const out = await target.finish();
    expect(out).toBeInstanceOf(BlobByteSource);
    expect(out.size).toBe(7);
    expect(target.blob?.type).toBe('application/zip');
    expect(new TextDecoder().decode(await bytesOf(target.blob!))).toBe('PK-data');
    await target.discard();
    expect(target.blob).toBeUndefined();
  });

  it('delivers the original file for "no improvement"', async () => {
    const original = new File([ramp(64)], 'curso.elpx', { type: '' });
    const target = new BlobOutputTarget();
    const copy = await target.useOriginal(new BlobByteSource(original));
    expect(copy.size).toBe(64);
    expect(target.blob?.type).toBe('application/zip');
    expect(await bytesOf(target.blob!)).toEqual(ramp(64));
  });

  it('rejects originals that are not Blob-backed', async () => {
    const target = new BlobOutputTarget();
    await expect(target.useOriginal(new MemoryByteSource(ramp(4)))).rejects.toMatchObject({ code: 'internal' });
    expect(target.blob).toBeUndefined();
  });
});
