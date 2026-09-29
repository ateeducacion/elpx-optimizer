import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { MemoryByteSink } from '../../../src/core/io/byte-sink.js';
import { NATIVE_LIMITS, resolveLimits } from '../../../src/core/limits.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { ZipWriter, metaFromEntry, deflateAll } from '../../../src/core/zip/writer.js';
import { craftZip } from '../../helpers/zip-craft.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Runs Python's zipfile against bytes and returns the parsed JSON listing. */
function pythonList(bytes: Uint8Array): { names: string[]; test: string | null; contents: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'elpx-w-'));
  try {
    const file = join(dir, 'out.zip');
    writeFileSync(file, bytes);
    const script = `
import zipfile, sys, json, base64
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({'names': z.namelist(), 'test': z.testzip(), 'contents': {n: base64.b64encode(z.read(n)).decode() for n in z.namelist() if not n.endswith('/')}}))
`;
    const out = JSON.parse(execFileSync('python3', ['-c', script, file]).toString()) as {
      names: string[];
      test: string | null;
      contents: Record<string, string>;
    };
    for (const k of Object.keys(out.contents)) out.contents[k] = Buffer.from(out.contents[k]!, 'base64').toString('utf8');
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ZipWriter', () => {
  it('copies entries byte-for-byte and replaces others', async () => {
    const input = craftZip([
      { name: 'content.xml', data: '<ode>original</ode>', method: 8 },
      { name: 'content/resources/vídeo.mp4', data: 'VIDEO-ORIGINAL' },
      { name: 'dir/', data: '' },
      { name: 'x.txt', data: 'streamed', flags: 0x0808, method: 8, descriptor: {} },
    ]);
    const archive = await openZip(new MemoryByteSource(input), NATIVE_LIMITS);
    const sink = new MemoryByteSink();
    const writer = new ZipWriter(sink);
    await writer.copyEntry(archive, archive.entries[0]!);
    await writer.addStoredSource(metaFromEntry(archive.entries[1]!), new MemoryByteSource(enc.encode('VIDEO-SMALLER')));
    await writer.copyEntry(archive, archive.entries[2]!);
    await writer.copyEntry(archive, archive.entries[3]!);
    expect(writer.entryCount).toBe(4);
    const size = await writer.finish();
    const out = sink.toBytes();
    expect(size).toBe(out.length);
    const reopened = await openZip(new MemoryByteSource(out), NATIVE_LIMITS);
    expect(reopened.entries.map((e) => e.name)).toEqual(archive.entries.map((e) => e.name));
    expect(dec.decode(await readEntryBytes(reopened, reopened.entries[0]!, 100))).toBe('<ode>original</ode>');
    expect(dec.decode(await readEntryBytes(reopened, reopened.entries[1]!, 100))).toBe('VIDEO-SMALLER');
    expect(dec.decode(await readEntryBytes(reopened, reopened.entries[3]!, 100))).toBe('streamed');
    // Data descriptor flag is dropped because sizes are now in the local header.
    expect(reopened.entries[3]!.flags & 8).toBe(0);
    // Preserved metadata
    expect(reopened.entries[0]!.dosDate).toBe(archive.entries[0]!.dosDate);
    expect(reopened.entries[1]!.rawName).toEqual(archive.entries[1]!.rawName);
    const py = pythonList(out);
    expect(py.test).toBeNull();
    expect(py.contents['content/resources/vídeo.mp4']).toBe('VIDEO-SMALLER');
    await expect(writer.finish()).rejects.toThrow(/already finished/);
  });

  it('adds deflated and stored in-memory entries', async () => {
    const sink = new MemoryByteSink();
    const writer = new ZipWriter(sink);
    const meta = { rawName: enc.encode('a.xml'), utf8: true, dosTime: 0, dosDate: 0x5021, versionMadeBy: 0x0314, internalAttributes: 0, externalAttributes: 0 };
    await writer.addBytes(meta, enc.encode('<a>' + 'z'.repeat(1000) + '</a>'), 8, 9);
    await writer.addBytes({ ...meta, rawName: enc.encode('b.bin'), utf8: false }, enc.encode('raw'), 0);
    await writer.finish();
    const reopened = await openZip(new MemoryByteSource(sink.toBytes()), NATIVE_LIMITS);
    expect(reopened.entries[0]!.method).toBe(8);
    expect(reopened.entries[0]!.compressedSize).toBeLessThan(100);
    expect(dec.decode(await readEntryBytes(reopened, reopened.entries[1]!, 10))).toBe('raw');
    expect(pythonList(sink.toBytes()).test).toBeNull();
  });

  it('writes ZIP64 structures when forced, readable by us and by Python', async () => {
    const input = craftZip([
      { name: 'content.xml', data: '<ode/>', method: 8 },
      { name: 'b.txt', data: 'bbb' },
    ]);
    const archive = await openZip(new MemoryByteSource(input), NATIVE_LIMITS);
    const sink = new MemoryByteSink();
    const writer = new ZipWriter(sink, { forceZip64: true });
    for (const e of archive.entries) await writer.copyEntry(archive, e);
    await writer.addStoredSource({ ...metaFromEntry(archive.entries[1]!), rawName: enc.encode('c.txt') }, new MemoryByteSource(enc.encode('ccc')));
    await writer.finish();
    const out = sink.toBytes();
    const reopened = await openZip(new MemoryByteSource(out), NATIVE_LIMITS);
    expect(reopened.zip64).toBe(true);
    expect(reopened.entries.every((e) => e.zip64)).toBe(true);
    expect(dec.decode(await readEntryBytes(reopened, reopened.byName.get('c.txt')!, 10))).toBe('ccc');
    const py = pythonList(out);
    expect(py.test).toBeNull();
    expect(py.names).toEqual(['content.xml', 'b.txt', 'c.txt']);
    expect(py.contents['content.xml']).toBe('<ode/>');
  });

  it('reads a Python-generated archive with more than 65535 entries (ZIP64 end records)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elpx-w-'));
    try {
      const file = join(dir, 'many.zip');
      execFileSync('python3', [
        '-c',
        `import zipfile,sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for i in range(65540): z.writestr('f/%d' % i, b'')`,
        file,
      ]);
      const bytes = new Uint8Array(readFileSync(file));
      await expect(openZip(new MemoryByteSource(bytes), NATIVE_LIMITS)).rejects.toThrow(/Too many entries/);
      const archive = await openZip(new MemoryByteSource(bytes), resolveLimits(NATIVE_LIMITS, { maxEntries: 70_000 }));
      expect(archive.zip64).toBe(true);
      expect(archive.entries).toHaveLength(65540);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams copies through write() when the sink has no writeRange', async () => {
    const input = craftZip([{ name: 'a.bin', data: new Uint8Array(3 * 1024 * 1024).fill(7) }]);
    const archive = await openZip(new MemoryByteSource(input), NATIVE_LIMITS);
    const writes: number[] = [];
    const sink = new MemoryByteSink();
    const spy = {
      write: async (c: Uint8Array) => {
        writes.push(c.length);
        await sink.write(c);
      },
      get bytesWritten() {
        return sink.bytesWritten;
      },
    };
    const writer = new ZipWriter(spy);
    await writer.copyEntry(archive, archive.entries[0]!);
    await writer.finish();
    expect(Math.max(...writes)).toBeLessThanOrEqual(1024 * 1024);
    const reopened = await openZip(new MemoryByteSource(sink.toBytes()), NATIVE_LIMITS);
    expect((await readEntryBytes(reopened, reopened.entries[0]!, 4 * 1024 * 1024)).every((b) => b === 7)).toBe(true);
  });

  it('uses writeRange when the sink provides it', async () => {
    const input = craftZip([{ name: 'a.bin', data: 'abc' }]);
    const archive = await openZip(new MemoryByteSource(input), NATIVE_LIMITS);
    const sink = new MemoryByteSink();
    const ranges: [number, number][] = [];
    const rangeSink = {
      write: (c: Uint8Array) => sink.write(c),
      writeRange: async (src: MemoryByteSource, s: number, e: number) => {
        ranges.push([s, e]);
        await sink.write(await src.read(s, e - s));
      },
      get bytesWritten() {
        return sink.bytesWritten;
      },
    };
    const writer = new ZipWriter(rangeSink);
    await writer.copyEntry(archive, archive.entries[0]!);
    await writer.addStoredSource(metaFromEntry(archive.entries[0]!), new MemoryByteSource(enc.encode('xyz')));
    await writer.finish();
    expect(ranges).toHaveLength(2);
  });

  it('deflateAll produces raw deflate data', () => {
    const data = enc.encode('hello hello hello hello');
    const out = deflateAll(data, 6);
    expect(out.length).toBeLessThan(data.length);
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const writer = new ZipWriter(new MemoryByteSink(), { signal: controller.signal });
    await expect(
      writer.addBytes(
        { rawName: enc.encode('a'), utf8: true, dosTime: 0, dosDate: 0, versionMadeBy: 20, internalAttributes: 0, externalAttributes: 0 },
        enc.encode('x'),
        0,
      ),
    ).rejects.toThrow(/cancelled/);
  });
});

/** Sink that pretends `start` bytes were already written and records what follows. */
class OffsetSink {
  readonly parts: Uint8Array[] = [];

  constructor(public bytesWritten: number) {}

  /** Records a copy of the chunk. */
  write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk.slice());
    this.bytesWritten += chunk.length;
    return Promise.resolve();
  }

  /** Returns the recorded bytes (everything after the pretended prefix). */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Reads a little-endian 64-bit value. */
function u64(v: DataView, p: number): number {
  return v.getUint32(p, true) + v.getUint32(p + 4, true) * 0x100000000;
}

const baseMeta = { utf8: true, dosTime: 0, dosDate: 0x5021, versionMadeBy: 0x0314, internalAttributes: 0, externalAttributes: 0 };

describe('ZipWriter ZIP64 decisions', () => {
  it('switches to ZIP64 end records at 65535 entries', async () => {
    const sink = new MemoryByteSink();
    const writer = new ZipWriter(sink);
    const empty = new Uint8Array(0);
    for (let i = 0; i < 0xffff; i++) await writer.addBytes({ ...baseMeta, rawName: enc.encode(`f/${i}`) }, empty, 0);
    await writer.finish();
    const out = sink.toBytes();
    const eocd = new DataView(out.buffer, out.length - 22);
    expect(eocd.getUint16(10, true)).toBe(0xffff);
    expect(eocd.getUint32(16, true)).toBe(0xffffffff);
    const archive = await openZip(new MemoryByteSource(out), resolveLimits(NATIVE_LIMITS, { maxEntries: 70_000 }));
    expect(archive.zip64).toBe(true);
    expect(archive.entries).toHaveLength(0xffff);
    expect(archive.entries[0xfffe]!.name).toBe('f/65534');
    expect(archive.entries.some((e) => e.zip64)).toBe(false);
  });

  it('writes ZIP64 offsets only for entries beyond 4 GiB', async () => {
    const start = 5_000_000_000;
    const sink = new OffsetSink(start);
    const writer = new ZipWriter(sink);
    await writer.addBytes({ ...baseMeta, rawName: enc.encode('a.txt') }, enc.encode('hello'), 0);
    expect(await writer.finish()).toBe(start + sink.bytes().length);
    const out = sink.bytes();
    const v = new DataView(out.buffer);
    // Local header: small sizes, no ZIP64 extra.
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(28, true)).toBe(0);
    // Central header: only the offset moves into the ZIP64 extra field.
    const cd = 30 + 5 + 5;
    expect(v.getUint32(cd, true)).toBe(0x02014b50);
    expect(v.getUint16(cd + 4, true)).toBe(0x0300 | 45);
    expect(v.getUint16(cd + 6, true)).toBe(45);
    expect(v.getUint32(cd + 20, true)).toBe(5);
    expect(v.getUint32(cd + 24, true)).toBe(5);
    expect(v.getUint16(cd + 30, true)).toBe(12);
    expect(v.getUint32(cd + 42, true)).toBe(0xffffffff);
    expect(v.getUint16(cd + 46 + 5, true)).toBe(1);
    expect(v.getUint16(cd + 46 + 5 + 2, true)).toBe(8);
    expect(u64(v, cd + 46 + 5 + 4)).toBe(start);
    // ZIP64 end record and locator, then a classic EOCD full of sentinels.
    const z64 = cd + 46 + 5 + 12;
    expect(v.getUint32(z64, true)).toBe(0x06064b50);
    expect(u64(v, z64 + 32)).toBe(1);
    expect(u64(v, z64 + 40)).toBe(46 + 5 + 12);
    expect(u64(v, z64 + 48)).toBe(start + cd);
    expect(v.getUint32(z64 + 56, true)).toBe(0x07064b50);
    expect(u64(v, z64 + 56 + 8)).toBe(start + z64);
    const eocd = z64 + 56 + 20;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 8, true)).toBe(0xffff);
    expect(v.getUint32(eocd + 12, true)).toBe(0xffffffff);
    expect(out.length).toBe(eocd + 22);
  });

  it('copies declared sizes above 4 GiB with ZIP64 local and central fields', async () => {
    const input = craftZip([{ name: 'big.bin', data: new Uint8Array(4096), method: 8 }]);
    const archive = await openZip(new MemoryByteSource(input), NATIVE_LIMITS);
    const declared = { ...archive.entries[0]!, uncompressedSize: 5_000_000_000 };
    const sink = new MemoryByteSink();
    const writer = new ZipWriter(sink);
    await writer.copyEntry(archive, declared);
    await writer.finish();
    const limits = resolveLimits(NATIVE_LIMITS, { maxCompressionRatio: 1e12 });
    const reopened = await openZip(new MemoryByteSource(sink.toBytes()), limits);
    const entry = reopened.entries[0]!;
    expect(entry.zip64).toBe(true);
    expect(entry.uncompressedSize).toBe(5_000_000_000);
    expect(entry.compressedSize).toBe(archive.entries[0]!.compressedSize);
    expect(entry.versionNeeded).toBe(45);
    expect(entry.dataOffset).toBe(30 + 7 + 20);
    await expect(readEntryBytes(reopened, entry, 6_000_000_000)).rejects.toThrow(/shorter than its declared size/);
  });

  it('stores sources without the UTF-8 flag when the name did not have it', async () => {
    const sink = new MemoryByteSink();
    const writer = new ZipWriter(sink);
    await writer.addStoredSource({ ...baseMeta, utf8: false, rawName: enc.encode('plain.bin') }, new MemoryByteSource(enc.encode('data')));
    await writer.finish();
    const reopened = await openZip(new MemoryByteSource(sink.toBytes()), NATIVE_LIMITS);
    expect(reopened.entries[0]!.flags & 0x0800).toBe(0);
    expect(reopened.entries[0]!.nameEncoding).toBe('ascii');
    expect(dec.decode(await readEntryBytes(reopened, reopened.entries[0]!, 10))).toBe('data');
  });

  it('honours cancellation while streaming a stored source', async () => {
    const controller = new AbortController();
    controller.abort();
    const sink = new MemoryByteSink();
    const writer = new ZipWriter(sink, { signal: controller.signal });
    await expect(writer.addStoredSource({ ...baseMeta, rawName: enc.encode('v.mp4') }, new MemoryByteSource(new Uint8Array(10)))).rejects.toThrow(/cancelled/);
    expect(sink.bytesWritten).toBe(0);
    expect(writer.entryCount).toBe(0);
  });
});
