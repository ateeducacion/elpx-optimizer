import { describe, expect, it } from 'vitest';
import { assertRange, collectBytes, DEFAULT_CHUNK_SIZE, MemoryByteSource, streamRange } from '../../../src/core/io/byte-source.js';
import { MemoryByteSink } from '../../../src/core/io/byte-sink.js';
import { Sha256, sha256Hex, utf8Encode } from '../../../src/core/io/hash.js';
import { Crc32, crc32 } from '../../../src/core/io/crc32.js';
import {
  bytesEqual,
  concatBytes,
  cp437Decode,
  isAscii,
  isValidUtf8,
  utf8DecodeLenient,
  utf8DecodeStrict,
  utf8Encode as reexportedUtf8Encode,
} from '../../../src/core/io/text.js';
import { ElpxError } from '../../../src/core/errors.js';

const enc = new TextEncoder();

/** Returns the ElpxError code thrown by a synchronous function. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ElpxError ? e.code : 'not-elpx';
  }
  return undefined;
}

/** Returns the ElpxError code of a rejected promise. */
async function rejectedCode(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof ElpxError ? e.code : 'not-elpx'),
  );
}

/** Wraps an array as an async iterable of chunks. */
async function* chunks(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}

describe('MemoryByteSource', () => {
  it('reads copy-free ranges', async () => {
    const bytes = enc.encode('0123456789');
    const src = new MemoryByteSource(bytes);
    expect(src.size).toBe(10);
    const view = await src.read(2, 3);
    expect(new TextDecoder().decode(view)).toBe('234');
    expect(view.buffer).toBe(bytes.buffer);
    expect((await src.read(10, 0)).length).toBe(0);
  });

  it('rejects invalid and out-of-range reads', async () => {
    const src = new MemoryByteSource(new Uint8Array(4));
    // Callers always await read(), so a synchronous throw surfaces as a rejection.
    const read = async (offset: number, length: number): Promise<Uint8Array> => src.read(offset, length);
    await expect(read(-1, 1)).rejects.toThrow(/Invalid read range/);
    expect(await rejectedCode(read(0.5, 1))).toBe('io');
    expect(await rejectedCode(read(0, -2))).toBe('io');
    expect(await rejectedCode(read(0, Number.MAX_SAFE_INTEGER + 2))).toBe('io');
    expect(await rejectedCode(read(3, 2))).toBe('zip-structure');
    await expect(read(3, 2)).rejects.toThrow(/Read beyond end of data \(3\+2 > 4\)/);
  });

  it('assertRange accepts the exact end', () => {
    expect(codeOf(() => assertRange(4, 0, 4))).toBeUndefined();
    expect(codeOf(() => assertRange(4, 4, 0))).toBeUndefined();
    expect(codeOf(() => assertRange(4, 4, 1))).toBe('zip-structure');
    expect(codeOf(() => assertRange(4, Number.NaN, 1))).toBe('io');
  });
});

describe('streamRange and collectBytes', () => {
  it('streams a range in bounded chunks', async () => {
    const data = new Uint8Array(100).map((_, i) => i);
    const src = new MemoryByteSource(data);
    const sizes: number[] = [];
    const parts: Uint8Array[] = [];
    for await (const c of streamRange(src, 5, 95, { chunkSize: 32 })) {
      sizes.push(c.length);
      parts.push(c);
    }
    expect(sizes).toEqual([32, 32, 26]);
    expect(Array.from(concatBytes(parts))).toEqual(Array.from(data.subarray(5, 95)));
  });

  it('uses the default chunk size and yields nothing for an empty range', async () => {
    const src = new MemoryByteSource(new Uint8Array(DEFAULT_CHUNK_SIZE + 10));
    const sizes: number[] = [];
    for await (const c of streamRange(src, 0, src.size)) sizes.push(c.length);
    expect(sizes).toEqual([DEFAULT_CHUNK_SIZE, 10]);
    const none: Uint8Array[] = [];
    for await (const c of streamRange(src, 7, 7)) none.push(c);
    expect(none).toEqual([]);
  });

  it('stops when cancelled between chunks', async () => {
    const src = new MemoryByteSource(new Uint8Array(64));
    const controller = new AbortController();
    const seen: number[] = [];
    const run = (async () => {
      for await (const c of streamRange(src, 0, 64, { chunkSize: 16, signal: controller.signal })) {
        seen.push(c.length);
        controller.abort();
      }
    })();
    expect(await rejectedCode(run)).toBe('cancelled');
    expect(seen).toEqual([16]);
  });

  it('collects chunks and enforces the maximum', async () => {
    const out = await collectBytes(chunks([enc.encode('ab'), enc.encode(''), enc.encode('cde')]), 5);
    expect(new TextDecoder().decode(out)).toBe('abcde');
    expect((await collectBytes(chunks([]), 0)).length).toBe(0);
    await expect(collectBytes(chunks([enc.encode('abc'), enc.encode('def')]), 5, 'Entry "x"')).rejects.toThrow(/Entry "x" exceeds the limit of 5 bytes/);
    expect(await rejectedCode(collectBytes(chunks([enc.encode('abcdef')]), 5))).toBe('limit-exceeded');
    await expect(collectBytes(chunks([enc.encode('abcdef')]), 5)).rejects.toThrow(/^data exceeds/);
  });
});

describe('MemoryByteSink', () => {
  it('stores copies of written chunks and concatenates them', async () => {
    const sink = new MemoryByteSink();
    expect(sink.bytesWritten).toBe(0);
    expect(sink.toBytes().length).toBe(0);
    const chunk = enc.encode('hello');
    await sink.write(chunk);
    chunk[0] = 0x4a; // later mutation must not leak into the sink
    await sink.write(enc.encode(' world'));
    expect(sink.bytesWritten).toBe(11);
    expect(new TextDecoder().decode(sink.toBytes())).toBe('hello world');
  });
});

describe('hashing', () => {
  it('matches SHA-256 test vectors for strings and bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(enc.encode('abc'))).toBe(sha256Hex('abc'));
    expect(sha256Hex('é')).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });

  it('hashes incrementally', () => {
    const h = new Sha256();
    expect(h.update(enc.encode('ab'))).toBe(h);
    h.update(enc.encode('c'));
    expect(h.digestHex()).toBe(sha256Hex('abc'));
  });

  it('encodes UTF-8 with the runtime encoder (also re-exported from text)', () => {
    expect(Array.from(utf8Encode('añ€'))).toEqual([0x61, 0xc3, 0xb1, 0xe2, 0x82, 0xac]);
    expect(reexportedUtf8Encode).toBe(utf8Encode);
  });

  it('matches CRC-32 test vectors incrementally and in one shot', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    const c = new Crc32();
    expect(c.update(enc.encode('1234'))).toBe(c);
    c.update(enc.encode('56789'));
    expect(c.digest()).toBe(0xcbf43926);
    expect(crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe(0xffffffff);
  });
});

describe('text helpers', () => {
  it('decodes UTF-8 strictly or leniently', () => {
    const bad = new Uint8Array([0x61, 0xff, 0x62]);
    expect(utf8DecodeStrict(enc.encode('añ'))).toBe('añ');
    expect(() => utf8DecodeStrict(bad, 'content.xml')).toThrow(/Invalid UTF-8 in content.xml/);
    expect(codeOf(() => utf8DecodeStrict(bad))).toBe('io');
    expect(() => utf8DecodeStrict(bad)).toThrow(/Invalid UTF-8 in text/);
    expect(utf8DecodeLenient(bad)).toBe('a�b');
    // The BOM is kept (ignoreBOM) so offsets match the raw text.
    expect(utf8DecodeStrict(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a');
  });

  it('validates UTF-8', () => {
    expect(isValidUtf8(enc.encode('ok ñ 😀'))).toBe(true);
    expect(isValidUtf8(new Uint8Array([0xc3]))).toBe(false);
    expect(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false);
    expect(isValidUtf8(new Uint8Array(0))).toBe(true);
  });

  it('decodes CP437 including the high half', () => {
    expect(cp437Decode(enc.encode('abc'))).toBe('abc');
    expect(cp437Decode(new Uint8Array([0x80, 0x81, 0x9b, 0xa4, 0xe1, 0xff]))).toBe('Çü¢ñß ');
  });

  it('detects ASCII', () => {
    expect(isAscii(enc.encode('plain/path.txt'))).toBe(true);
    expect(isAscii(new Uint8Array([0x7f]))).toBe(true);
    expect(isAscii(new Uint8Array([0x61, 0x80]))).toBe(false);
    expect(isAscii(new Uint8Array(0))).toBe(true);
  });

  it('concatenates and compares byte arrays', () => {
    expect(Array.from(concatBytes([new Uint8Array([1]), new Uint8Array(0), new Uint8Array([2, 3])]))).toEqual([1, 2, 3]);
    expect(concatBytes([]).length).toBe(0);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});
