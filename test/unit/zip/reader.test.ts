import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { NATIVE_LIMITS, resolveLimits } from '../../../src/core/limits.js';
import { openZip, readEntry, readEntryBytes, findExtraField, hasZipSignature, readU16, readU32, readU64 } from '../../../src/core/zip/reader.js';
import { crc32 } from '../../../src/core/io/crc32.js';
import { ElpxError } from '../../../src/core/errors.js';
import { craftZip } from '../../helpers/zip-craft.js';
import { centralHeaderOffset, insertAt, patch, readEocd, withZip64End, zip64Extra, type Zip64EndOptions } from '../../helpers/zip64-craft.js';

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Deterministic incompressible bytes. */
function pseudoRandom(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}
const open = (bytes: Uint8Array, limits = NATIVE_LIMITS) => openZip(new MemoryByteSource(bytes), limits);

async function expectCode(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ElpxError);
  expect((err as ElpxError).code).toBe(code);
  if (message) expect((err as ElpxError).message).toMatch(message);
}

describe('openZip', () => {
  it('reads stored and deflated entries and verifies CRC', async () => {
    const zip = craftZip([
      { name: 'content.xml', data: '<ode/>', method: 8 },
      { name: 'content/resources/a b.txt', data: 'hello' },
      { name: 'dir/', data: '' },
    ]);
    const archive = await open(zip);
    expect(archive.entries.map((e) => e.name)).toEqual(['content.xml', 'content/resources/a b.txt', 'dir/']);
    expect(archive.entries[2]!.isDirectory).toBe(true);
    expect(text(await readEntryBytes(archive, archive.byName.get('content.xml')!, 1000))).toBe('<ode/>');
    expect(text(await readEntryBytes(archive, archive.entries[1]!, 1000))).toBe('hello');
    expect(archive.zip64).toBe(false);
    expect(archive.warnings).toEqual([]);
  });

  it('interoperates with archives produced by Python zipfile, including forced ZIP64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elpx-zip-'));
    try {
      const script = `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('content.xml', '<ode>' + 'x' * 5000 + '</ode>')
    with z.open('content/resources/v\u00eddeo.mp4', 'w', force_zip64=True) as f:
        f.write(b'\\x00\\x01' * 3000)
    z.writestr(zipfile.ZipInfo('stored.bin'), b'abc', compress_type=zipfile.ZIP_STORED)
`;
      const out = join(dir, 'py.zip');
      execFileSync('python3', ['-c', script, out]);
      const archive = await open(new Uint8Array(readFileSync(out)));
      expect(archive.entries.map((e) => e.name)).toEqual(['content.xml', 'content/resources/vídeo.mp4', 'stored.bin']);
      const video = archive.byName.get('content/resources/vídeo.mp4')!;
      // Python writes the ZIP64 sizes in the local header only for small forced entries.
      expect(video.compressedSize).toBeGreaterThan(0);
      const bytes = await readEntryBytes(archive, video, 10_000);
      expect(bytes.length).toBe(6000);
      expect(text(await readEntryBytes(archive, archive.byName.get('stored.bin')!, 10))).toBe('abc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an empty archive', async () => {
    const archive = await open(craftZip([]));
    expect(archive.entries).toHaveLength(0);
  });

  it('rejects non-ZIP input and tiny files', async () => {
    await expectCode(open(new TextEncoder().encode('<?xml version="1.0"?><ode></ode>')), 'not-a-zip');
    await expectCode(open(new Uint8Array([0x50, 0x4b])), 'not-a-zip');
  });

  it('rejects truncated archives and trailing data', async () => {
    const zip = craftZip([{ name: 'a.txt', data: 'a' }]);
    await expectCode(open(zip.subarray(0, zip.length - 5)), 'zip-structure', /not found/);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'a' }], { trailing: new Uint8Array(10) })), 'zip-structure', /does not match/);
  });

  it('rejects prefixed archives and inconsistent central directory offsets', async () => {
    const plain = craftZip([{ name: 'a', data: 'a' }]);
    const prefixed = new Uint8Array(plain.length + 8);
    prefixed.set(new TextEncoder().encode('PK\u0003\u0004junk'), 0);
    prefixed.set(plain, 8);
    await expectCode(open(prefixed), 'zip-structure', /inconsistent/);
    await expectCode(open(craftZip([{ name: 'a', data: 'a' }], { eocd: { cdSize: 10 } })), 'zip-structure');
    await expectCode(open(craftZip([{ name: 'a', data: 'a' }], { eocd: { count: 2 } })), 'zip-structure');
  });

  it.each([
    ['../evil.txt', /traversal/],
    ['a/../../evil.txt', /traversal/],
    ['/etc/passwd', /absolute/],
    ['C:/windows/evil', /drive/],
    ['a\\..\\b', /backslash/],
    ['a//b', /empty path segment/],
    ['./a', /traversal/],
    ['bad\u0001name', /control/],
  ])('rejects unsafe name %j', async (name, reason) => {
    await expectCode(open(craftZip([{ name, data: 'x' }])), 'zip-security', reason);
  });

  it('rejects symlinks, encryption and unsupported methods', async () => {
    await expectCode(open(craftZip([{ name: 'link', data: '/etc/passwd', central: { external: (0o120777 << 16) >>> 0 } }])), 'zip-security', /symbolic link/);
    await expectCode(open(craftZip([{ name: 'a', data: 'x', flags: 0x0801 }])), 'zip-unsupported', /encrypted/);
    await expectCode(open(craftZip([{ name: 'a', data: 'x', central: { method: 12 }, local: { method: 12 } }])), 'zip-unsupported', /method 12/);
  });

  it('rejects duplicates, normalization collisions and file/directory conflicts', async () => {
    await expectCode(
      open(
        craftZip([
          { name: 'a.txt', data: '1' },
          { name: 'a.txt', data: '2' },
        ]),
      ),
      'zip-security',
      /Duplicate/,
    );
    await expectCode(
      open(
        craftZip([
          { name: 'caf\u00e9.png', data: '1' },
          { name: 'cafe\u0301.png', data: '2' },
        ]),
      ),
      'zip-security',
      /normalization/,
    );
    await expectCode(
      open(
        craftZip([
          { name: 'a', data: '1' },
          { name: 'a/b', data: '2' },
        ]),
      ),
      'zip-security',
      /both a file and a directory/,
    );
  });

  it('warns about case-only collisions and guessed name encodings', async () => {
    const latin1 = new Uint8Array([0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // "fé.txt" in Latin-1, invalid UTF-8
    const utf8 = new TextEncoder().encode('ñ.txt');
    const archive = await open(
      craftZip([
        { name: 'A.png', data: '1' },
        { name: 'a.png', data: '2' },
        { name: latin1, data: '3', flags: 0 },
        { name: utf8, data: '4', flags: 0 },
      ]),
    );
    const codes = archive.warnings.map((w) => w.code);
    expect(codes).toContain('zip-case-collision');
    expect(codes.filter((c) => c === 'zip-name-encoding')).toHaveLength(2);
    expect(archive.entries[2]!.name).toBe('f\u0398.txt');
    expect(archive.entries[2]!.nameEncoding).toBe('cp437');
    expect(archive.entries[3]!.name).toBe('ñ.txt');
  });

  it('rejects local/central header mismatches', async () => {
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', local: { name: new TextEncoder().encode('b.txt') } }])), 'zip-security', /names differ/);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', local: { usize: 99 } }])), 'zip-security', /sizes or CRC differ/);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', local: { method: 8 } }])), 'zip-security', /methods differ/);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', local: { flags: 0x0808 } }])), 'zip-security', /flags differ/);
  });

  it('rejects overlapping entries (overlap ZIP bomb)', async () => {
    const zip = craftZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'b.txt', data: 'hello', central: { offset: 0, name: new TextEncoder().encode('b.txt') } },
    ]);
    // b.txt points to a's local header whose name differs -> detected as mismatch or overlap
    await expectCode(open(zip), 'zip-security');
  });

  it('detects a fake small declared size (ZIP bomb) while inflating', async () => {
    const big = new Uint8Array(2_000_000);
    const payload = new Uint8Array(deflateRawSync(big));
    const zip = craftZip([{ name: 'bomb.bin', method: 8, payload, central: { usize: 100 }, local: { usize: 100 } }]);
    const archive = await open(zip);
    await expectCode(readEntryBytes(archive, archive.entries[0]!, 10_000_000), 'zip-integrity', /beyond its declared size/);
  });

  it('rejects suspicious compression ratios and size limits before inflating', async () => {
    const zeros = new Uint8Array(5_000_000);
    await expectCode(
      open(craftZip([{ name: 'z.bin', data: zeros, method: 8 }]), resolveLimits(NATIVE_LIMITS, { maxCompressionRatio: 100 })),
      'zip-limit',
      /compression ratio/,
    );
    const noisy = pseudoRandom(2_000_000);
    const zip = craftZip([{ name: 'z.bin', data: noisy, method: 8 }]);
    await expectCode(open(zip, resolveLimits(NATIVE_LIMITS, { maxEntryUncompressedBytes: 1000 })), 'zip-limit', /larger than the limit/);
    await expectCode(open(zip, resolveLimits(NATIVE_LIMITS, { maxTotalUncompressedBytes: 1000 })), 'zip-limit', /Declared uncompressed/);
    await expectCode(open(zip, resolveLimits(NATIVE_LIMITS, { maxEntries: 0.5 })), 'zip-limit', /Too many entries/);
    await expectCode(open(zip, resolveLimits(NATIVE_LIMITS, { maxArchiveBytes: 100 })), 'zip-limit');
    await expectCode(open(craftZip([{ name: 'a/b/c/d', data: 'x' }]), resolveLimits(NATIVE_LIMITS, { maxPathDepth: 3 })), 'zip-security', /too deep/);
    await expectCode(open(craftZip([{ name: 'abcdef', data: 'x' }]), resolveLimits(NATIVE_LIMITS, { maxNameBytes: 3 })), 'zip-limit');
  });

  it('detects CRC mismatch and truncated deflate data', async () => {
    const archive = await open(craftZip([{ name: 'a.txt', data: 'hello', central: { crc: 1 }, local: { crc: 1 } }]));
    await expectCode(readEntryBytes(archive, archive.entries[0]!, 100), 'zip-integrity', /CRC/);
    const payload = new Uint8Array(deflateRawSync(new TextEncoder().encode('hello world hello world')));
    const truncated = payload.subarray(0, 4);
    const a2 = await open(craftZip([{ name: 'b.txt', method: 8, payload: truncated, central: { usize: 23 }, local: { usize: 23 } }]));
    await expectCode(readEntryBytes(a2, a2.entries[0]!, 100), 'zip-integrity');
    const a3 = await open(craftZip([{ name: 'c.txt', method: 8, payload: new Uint8Array([0xff, 0xff, 0xff]), central: { usize: 3 }, local: { usize: 3 } }]));
    await expectCode(readEntryBytes(a3, a3.entries[0]!, 100), 'zip-integrity');
  });

  it('detects entries shorter than declared', async () => {
    const archive = await open(craftZip([{ name: 'a.txt', data: 'hi', method: 8, central: { usize: 3 }, local: { usize: 3 } }]));
    await expectCode(readEntryBytes(archive, archive.entries[0]!, 100), 'zip-integrity', /shorter/);
  });

  it('validates data descriptors', async () => {
    const ok = await open(craftZip([{ name: 'a.txt', data: 'hello', method: 8, flags: 0x0808, descriptor: {} }]));
    expect(text(await readEntryBytes(ok, ok.entries[0]!, 100))).toBe('hello');
    const noSig = await open(craftZip([{ name: 'a.txt', data: 'hello', flags: 0x0808, descriptor: { signature: false } }]));
    expect(noSig.entries[0]!.endOffset).toBe(noSig.entries[0]!.dataOffset + 5 + 12);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'hello', flags: 0x0808, descriptor: { crc: 5 } }])), 'zip-security', /descriptor/);
  });

  it('enforces readEntryBytes limits and cancellation', async () => {
    const archive = await open(craftZip([{ name: 'a.txt', data: 'hello' }]));
    await expectCode(readEntryBytes(archive, archive.entries[0]!, 2), 'limit-exceeded');
    const controller = new AbortController();
    controller.abort();
    await expectCode(readEntryBytes(archive, archive.entries[0]!, 100, { signal: controller.signal }), 'cancelled');
  });

  it('streams large entries in bounded chunks', async () => {
    const data = pseudoRandom(3 * 1024 * 1024);
    const archive = await open(craftZip([{ name: 'v.mp4', data, method: 8 }]));
    let total = 0;
    let max = 0;
    for await (const chunk of readEntry(archive, archive.entries[0]!, { chunkSize: 64 * 1024 })) {
      total += chunk.length;
      max = Math.max(max, chunk.length);
    }
    expect(total).toBe(data.length);
    expect(max).toBeLessThanOrEqual(1024 * 1024);
  });

  it('parses extra fields defensively', () => {
    const extra = new Uint8Array([0x01, 0x00, 0x08, 0x00, 1, 0, 0, 0, 0, 0, 0, 0, 0x99, 0x99, 0x20, 0x00]);
    expect(findExtraField(extra, 1)).toEqual(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]));
    expect(findExtraField(extra, 0x9999)).toBeUndefined();
    expect(() => readU64(new Uint8Array([0, 0, 0, 0, 0, 0, 0x40, 0]), 0)).toThrow(/64-bit/);
  });

  it('warns about archive comments and unaccounted bytes', async () => {
    const archive = await open(craftZip([{ name: 'a', data: 'x' }], { comment: 'hi' }));
    expect(archive.comment).toBe('hi');
    expect(archive.warnings.map((w) => w.code)).toContain('zip-archive-comment');
    // central directory offset pointing after a gap of junk bytes
    const base = craftZip([{ name: 'a', data: 'x' }]);
    const localLen = 30 + 1 + 1;
    const withGap = new Uint8Array(base.length + 4);
    withGap.set(base.subarray(0, localLen), 0);
    withGap.set([9, 9, 9, 9], localLen);
    withGap.set(base.subarray(localLen), localLen + 4);
    const dv = new DataView(withGap.buffer);
    dv.setUint32(withGap.length - 22 + 16, localLen + 4, true);
    const gapped = await open(withGap);
    expect(gapped.warnings.map((w) => w.code)).toContain('zip-unaccounted-bytes');
  });

  it('writes files that other tools can read (smoke check with unzip -t when available)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elpx-zip-'));
    try {
      const file = join(dir, 'a.zip');
      writeFileSync(file, craftZip([{ name: 'x.txt', data: 'x', method: 8 }]));
      const out = execFileSync('python3', ['-c', 'import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).testzip())', file]).toString().trim();
      expect(out).toBe('None');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Concatenates byte arrays (test-local helper). */
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Builds a data descriptor with an optional signature and 32- or 64-bit sizes. */
function descriptor(crc: number, csize: number, usize: number, opts: { signature: boolean; wide: boolean }): Uint8Array {
  const size = (opts.signature ? 4 : 0) + 4 + (opts.wide ? 16 : 8);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let p = 0;
  if (opts.signature) {
    v.setUint32(0, 0x08074b50, true);
    p = 4;
  }
  v.setUint32(p, crc, true);
  p += 4;
  if (opts.wide) {
    v.setUint32(p, csize, true);
    v.setUint32(p + 8, usize, true);
  } else {
    v.setUint32(p, csize, true);
    v.setUint32(p + 4, usize, true);
  }
  return out;
}

describe('openZip: ZIP64 end records', () => {
  const base = (): Uint8Array =>
    craftZip([
      { name: 'content.xml', data: '<ode>' + 'x'.repeat(50) + '</ode>', method: 8 },
      { name: 'b.txt', data: 'bbb' },
    ]);

  it('follows the ZIP64 record when the classic fields hold sentinels', async () => {
    const archive = await open(withZip64End(base()));
    expect(archive.zip64).toBe(true);
    expect(archive.entries.map((e) => e.name)).toEqual(['content.xml', 'b.txt']);
    expect(text(await readEntryBytes(archive, archive.entries[1]!, 10))).toBe('bbb');
    expect(archive.centralDirectoryOffset).toBe(readEocd(base()).cdOffset);
  });

  it('accepts classic values that agree with the ZIP64 record and an extensible data sector', async () => {
    const zip = base();
    const e = readEocd(zip);
    const agreeing = await open(withZip64End(zip, { classic: { entriesOnDisk: e.total, total: e.total, cdSize: e.cdSize, cdOffset: e.cdOffset } }));
    expect(agreeing.zip64).toBe(true);
    const extended = await open(withZip64End(zip, { recordExtra: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }));
    expect(extended.entries).toHaveLength(2);
  });

  it.each([
    ['locator on another disk', { locator: { disk: 1 } }, 'zip-unsupported', /Multi-volume/],
    ['locator with several disks', { locator: { totalDisks: 2 } }, 'zip-unsupported', /Multi-volume/],
    ['locator offset past the end', { locator: { offset: 1_000_000 } }, 'zip-structure', /offset is invalid/],
    ['locator pointing at a local header', { locator: { offset: 0 } }, 'zip-structure', /ZIP64 end of central directory not found/],
    ['wrong record signature', { record: { signature: 0x12345678 } }, 'zip-structure', /not found/],
    ['wrong record size', { record: { recordSize: 60 } }, 'zip-structure', /unexpected size/],
    ['record on another disk', { record: { disk: 1 } }, 'zip-unsupported', /Multi-volume/],
    ['central directory on another disk', { record: { cdDisk: 2 } }, 'zip-unsupported', /Multi-volume/],
    ['entries split across disks', { record: { entriesOnDisk: 1 } }, 'zip-unsupported', /Multi-volume/],
    ['central directory not adjacent to the record', { record: { cdSize: 10 } }, 'zip-structure', /position is inconsistent/],
    ['classic entry count disagrees', { classic: { total: 7 } }, 'zip-structure', /disagree/],
    ['classic size disagrees', { classic: { cdSize: 3 } }, 'zip-structure', /disagree/],
    ['classic offset disagrees', { classic: { cdOffset: 4 } }, 'zip-structure', /disagree/],
    ['more entries than the directory can hold', { record: { total: 9, entriesOnDisk: 9 } }, 'zip-structure', /inconsistent with the entry count/],
  ] as const)('rejects %s', async (_label, options, code, message) => {
    await expectCode(open(withZip64End(base(), options as Zip64EndOptions)), code, message);
  });

  it('rejects a ZIP64 record without locator when the classic fields hold sentinels', async () => {
    await expectCode(open(craftZip([{ name: 'a', data: 'x' }], { eocd: { count: 0xffff } })), 'zip-structure', /locator missing/);
    const zip = craftZip([{ name: 'a', data: 'x' }]);
    await expectCode(open(patch(zip, readEocd(zip).offset + 12, 0xffffffff, 4)), 'zip-structure', /locator missing/);
    await expectCode(open(patch(zip, readEocd(zip).offset + 16, 0xffffffff, 4)), 'zip-structure', /locator missing/);
  });

  it('rejects multi-volume classic archives', async () => {
    const zip = craftZip([{ name: 'a', data: 'x' }]);
    const eocd = readEocd(zip).offset;
    await expectCode(open(patch(zip, eocd + 4, 1, 2)), 'zip-unsupported', /split/);
    await expectCode(open(patch(zip, eocd + 6, 1, 2)), 'zip-unsupported', /split/);
    await expectCode(open(patch(zip, eocd + 8, 0, 2)), 'zip-unsupported', /split/);
  });

  it('reports a truncated archive too small for an end record', async () => {
    await expectCode(open(new Uint8Array(21)), 'not-a-zip', /too small/);
    expect(hasZipSignature(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(hasZipSignature(new Uint8Array([0x50, 0x4b, 0x03]))).toBe(false);
  });
});

describe('openZip: central directory headers', () => {
  it('rejects a missing central header signature and truncated headers', async () => {
    const zip = craftZip([{ name: 'a.txt', data: 'x' }]);
    const ch = centralHeaderOffset(zip);
    await expectCode(open(patch(zip, ch, 0x12345678, 4)), 'zip-structure', /header 0 is missing or truncated/);
    await expectCode(open(patch(zip, ch + 32, 500, 2)), 'zip-structure', /header 0 is truncated/);
  });

  it('rejects bytes left over in the central directory', async () => {
    const zip = craftZip([{ name: 'a.txt', data: 'x' }]);
    const eocd = readEocd(zip);
    const padded = insertAt(zip, eocd.offset, new Uint8Array([0, 0, 0, 0]));
    await expectCode(open(patch(padded, eocd.offset + 4 + 12, eocd.cdSize + 4, 4)), 'zip-structure', /trailing or missing bytes/);
  });

  it('rejects inconsistent directory entries and stored sizes', async () => {
    const unixDir = (0o040755 << 16) >>> 0;
    await expectCode(open(craftZip([{ name: 'dir', data: '', central: { external: unixDir } }])), 'zip-structure', /does not end with "\/"/);
    await expectCode(open(craftZip([{ name: 'dir/', data: 'x' }])), 'zip-structure', /Directory entry "dir\/" has data/);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'hello', central: { usize: 6 } }])), 'zip-structure', /different compressed and uncompressed sizes/);
    const dir = await open(
      craftZip([
        { name: 'dir/', data: '', central: { external: unixDir } },
        { name: 'dir/a', data: 'x' },
      ]),
    );
    expect(dir.entries[0]!.isDirectory).toBe(true);
    // A DOS-made entry with the directory mode bits is a plain file.
    const dos = await open(craftZip([{ name: 'file', data: 'x', central: { external: unixDir, madeBy: 0x0014 } }]));
    expect(dos.entries[0]!.isDirectory).toBe(false);
  });

  it('reads ZIP64 extended information from the central header', async () => {
    const data = 'hello zip64';
    const zip = craftZip([
      { name: 'pad.txt', data: 'p' },
      { name: 'a.txt', data, central: { usize: 0xffffffff, csize: 0xffffffff, offset: 0xffffffff, extra: zip64Extra([data.length, data.length, 38]) } },
    ]);
    const archive = await open(zip);
    const entry = archive.byName.get('a.txt')!;
    expect(entry.zip64).toBe(true);
    expect(entry.uncompressedSize).toBe(data.length);
    expect(entry.localHeaderOffset).toBe(38);
    expect(text(await readEntryBytes(archive, entry, 100))).toBe(data);
  });

  it('validates the ZIP64 disk number and missing ZIP64 information', async () => {
    const withDisk = (disk: number | undefined): Uint8Array => {
      const zip = craftZip([{ name: 'a.txt', data: 'x', central: { extra: disk === undefined ? zip64Extra([]) : zip64Extra([], disk) } }]);
      return patch(zip, centralHeaderOffset(zip) + 34, 0xffff, 2);
    };
    expect((await open(withDisk(0))).entries[0]!.zip64).toBe(true);
    await expectCode(open(withDisk(1)), 'zip-unsupported', /split/);
    await expectCode(open(withDisk(undefined)), 'zip-structure', /truncated ZIP64 field/);
    await expectCode(
      open(craftZip([{ name: 'a.txt', data: 'x', central: { usize: 0xffffffff, extra: zip64Extra([]) } }])),
      'zip-structure',
      /truncated ZIP64 field/,
    );
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', central: { usize: 0xffffffff } }])), 'zip-structure', /needs ZIP64 information/);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', central: { csize: 0xffffffff } }])), 'zip-structure', /needs ZIP64 information/);
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', central: { offset: 0xffffffff } }])), 'zip-structure', /needs ZIP64 information/);
    const plain = craftZip([{ name: 'a.txt', data: 'x' }]);
    await expectCode(open(patch(plain, centralHeaderOffset(plain) + 34, 1, 2)), 'zip-unsupported', /split/);
  });

  it('rejects strong encryption and masked headers', async () => {
    await expectCode(open(craftZip([{ name: 'a', data: 'x', flags: 0x0840 }])), 'zip-unsupported', /encrypted/);
    await expectCode(open(craftZip([{ name: 'a', data: 'x', flags: 0x2800 }])), 'zip-unsupported', /encrypted/);
  });
});

describe('openZip: local headers', () => {
  it('rejects local headers outside the data area, missing or truncated', async () => {
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', central: { offset: 5000 } }])), 'zip-structure', /points outside the data area/);
    await expectCode(
      open(
        craftZip([
          { name: 'a.txt', data: 'x' },
          { name: 'b.txt', data: 'y', central: { offset: 1 } },
        ]),
      ),
      'zip-structure',
      /Local header of "b.txt" is missing/,
    );
    const zip = craftZip([{ name: 'a.txt', data: 'x' }]);
    await expectCode(open(patch(zip, 28, 0xffff, 2)), 'zip-structure', /Local header of "a.txt" is truncated/);
  });

  it('rejects encryption declared only in the local header', async () => {
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'x', local: { flags: 0x0801 } }])), 'zip-unsupported', /encrypted/);
  });

  it('reads ZIP64 sizes from the local extra field', async () => {
    const data = 'local zip64';
    const archive = await open(
      craftZip([{ name: 'a.txt', data, local: { csize: 0xffffffff, usize: 0xffffffff, extra: zip64Extra([data.length, data.length]) } }]),
    );
    expect(archive.entries[0]!.dataOffset).toBe(30 + 5 + 20);
    expect(text(await readEntryBytes(archive, archive.entries[0]!, 100))).toBe(data);
    await expectCode(open(craftZip([{ name: 'a.txt', data, local: { csize: 0xffffffff, usize: 0xffffffff } }])), 'zip-structure', /Local ZIP64 sizes missing/);
    await expectCode(
      open(craftZip([{ name: 'a.txt', data, local: { usize: 0xffffffff, extra: zip64Extra([data.length]) } }])),
      'zip-structure',
      /Local ZIP64 sizes missing/,
    );
    await expectCode(
      open(craftZip([{ name: 'a.txt', data, local: { csize: 0xffffffff, usize: 0xffffffff, extra: zip64Extra([data.length, 1]) } }])),
      'zip-security',
      /sizes or CRC differ/,
    );
  });

  it('rejects entry data that runs into the central directory', async () => {
    await expectCode(
      open(craftZip([{ name: 'a.txt', data: 'x', central: { csize: 1000, usize: 1000 }, local: { csize: 1000, usize: 1000 } }])),
      'zip-structure',
      /extends past the central directory/,
    );
  });

  it('rejects a data descriptor that is cut short', async () => {
    await expectCode(open(craftZip([{ name: 'a.txt', data: 'hello', flags: 0x0808 }])), 'zip-structure', /Data descriptor of "a.txt" is truncated/);
  });

  it('reads 64-bit data descriptors of ZIP64 entries, with and without signature', async () => {
    const data = new TextEncoder().encode('hello');
    const crc = crc32(data);
    for (const signature of [true, false]) {
      const payload = cat(data, descriptor(crc, 5, 5, { signature, wide: true }));
      const archive = await open(craftZip([{ name: 'a.txt', data, flags: 0x0808, payload, central: { csize: 5, extra: zip64Extra([]) } }]));
      const entry = archive.entries[0]!;
      expect(entry.endOffset).toBe(entry.dataOffset + 5 + (signature ? 24 : 20));
      expect(archive.warnings).toEqual([]);
      expect(text(await readEntryBytes(archive, entry, 10))).toBe('hello');
    }
    // A local ZIP64 extra alone also announces 64-bit descriptor sizes.
    const payload = cat(data, descriptor(crc, 5, 5, { signature: true, wide: true }));
    const local = await open(craftZip([{ name: 'a.txt', data, flags: 0x0808, payload, central: { csize: 5 }, local: { extra: zip64Extra([0, 0]) } }]));
    expect(local.entries[0]!.endOffset).toBe(local.entries[0]!.dataOffset + 5 + 24);
  });

  it('reads 32-bit descriptors of ZIP64 entries when too few bytes remain for 64-bit sizes', async () => {
    const data = new TextEncoder().encode('hello');
    const payload = cat(data, descriptor(crc32(data), 5, 5, { signature: true, wide: false }));
    const archive = await open(craftZip([{ name: 'a.txt', data, flags: 0x0808, payload, central: { csize: 5, extra: zip64Extra([]) } }]));
    expect(archive.entries[0]!.endOffset).toBe(archive.entries[0]!.dataOffset + 5 + 16);
  });

  it('interoperates with streamed Python archives that use ZIP64 data descriptors', async () => {
    const script = `
import zipfile, sys, io
class Unseekable(io.RawIOBase):
    def __init__(self, out): self.out = out
    def writable(self): return True
    def write(self, b): self.out.write(b); return len(b)
buf = io.BytesIO()
with zipfile.ZipFile(Unseekable(buf), 'w', compression=zipfile.ZIP_DEFLATED) as z:
    with z.open('content.xml', 'w', force_zip64=True) as f:
        f.write(b'<ode>' + b'y' * 3000 + b'</ode>')
    with z.open('small.txt', 'w') as f:
        f.write(b'abc')
sys.stdout.buffer.write(buf.getvalue())
`;
    const bytes = new Uint8Array(execFileSync('python3', ['-c', script]));
    const archive = await open(bytes);
    expect(archive.entries.map((e) => e.name)).toEqual(['content.xml', 'small.txt']);
    expect(archive.entries.every((e) => (e.flags & 8) !== 0)).toBe(true);
    expect(text(await readEntryBytes(archive, archive.entries[0]!, 10_000))).toBe('<ode>' + 'y'.repeat(3000) + '</ode>');
    expect(text(await readEntryBytes(archive, archive.entries[1]!, 10))).toBe('abc');
  });

  it('rejects entries whose data overlap another entry', async () => {
    const inner = craftZip([{ name: 'b', data: 'hello' }]);
    const bLocal = inner.subarray(0, 30 + 1 + 5);
    const zip = craftZip([
      { name: 'a', data: bLocal },
      { name: 'b', data: 'hello', central: { offset: 30 + 1 } },
    ]);
    await expectCode(open(zip), 'zip-security', /Entry "b" overlaps another entry/);
  });
});

describe('readEntry edge cases', () => {
  it('rejects deflated entries without compressed data', async () => {
    const archive = await open(craftZip([{ name: 'a.txt', method: 8, payload: new Uint8Array(0), data: '' }]));
    await expectCode(readEntryBytes(archive, archive.entries[0]!, 10), 'zip-integrity', /empty deflate data/);
  });

  it('reads empty stored entries', async () => {
    const archive = await open(craftZip([{ name: 'empty.txt', data: '' }]));
    expect((await readEntryBytes(archive, archive.entries[0]!, 0)).length).toBe(0);
  });

  it('streams stored entries in chunks and verifies their CRC', async () => {
    const data = pseudoRandom(100_000, 7);
    const archive = await open(craftZip([{ name: 'a.bin', data }]));
    const sizes: number[] = [];
    for await (const c of readEntry(archive, archive.entries[0]!, { chunkSize: 40_000 })) sizes.push(c.length);
    expect(sizes).toEqual([40_000, 40_000, 20_000]);
    const bad = await open(craftZip([{ name: 'a.bin', data, central: { crc: 5 }, local: { crc: 5 } }]));
    await expectCode(readEntryBytes(bad, bad.entries[0]!, 200_000), 'zip-integrity', /CRC mismatch/);
  });

  it('reads 16- and 32-bit little-endian values', () => {
    const b = new Uint8Array([0x34, 0x12, 0x78, 0x56, 0xff, 0xff, 0xff, 0xff]);
    expect(readU16(b, 0)).toBe(0x1234);
    expect(readU32(b, 0)).toBe(0x56781234);
    expect(readU32(b, 4)).toBe(0xffffffff);
    expect(readU64(new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0]), 0)).toBe(0x100000001);
    expect(findExtraField(new Uint8Array([0x01, 0x00, 0x10, 0x00, 1, 2]), 1)).toBeUndefined();
    expect(findExtraField(new Uint8Array([0x01]), 1)).toBeUndefined();
  });
});

describe('readEntry with a misbehaving source', () => {
  it('reports compressed data cut short by short reads', async () => {
    const archive = await open(craftZip([{ name: 'a.txt', data: 'hello world '.repeat(200), method: 8 }]));
    const inner = archive.source;
    const short = { size: inner.size, read: async (o: number, l: number) => (await inner.read(o, l)).subarray(0, Math.max(0, l - 3)) };
    await expectCode(readEntryBytes({ ...archive, source: short }, archive.entries[0]!, 10_000), 'zip-integrity', /truncated compressed data/);
  });
});
