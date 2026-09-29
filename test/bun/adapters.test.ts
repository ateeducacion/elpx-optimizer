/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AtomicFileSink } from '../../src/adapters/node/file-sink.js';
import { FileByteSource } from '../../src/adapters/node/file-source.js';
import { NativeMediaEngine } from '../../src/adapters/node/native-media-engine.js';
import { runProcess } from '../../src/adapters/node/process.js';
import { NodeResourceStore } from '../../src/adapters/node/resource-store.js';
import { CancelledError } from '../../src/core/errors.js';
import { MemoryByteSource } from '../../src/core/io/byte-source.js';
import { NATIVE_LIMITS } from '../../src/core/limits.js';
import { PDF_INPUT, PDF_OUTPUT, checkPdf, inspectPdf } from '../../src/core/media/pdf-policy.js';
import { openZip } from '../../src/core/zip/reader.js';
import { craftZip } from '../helpers/zip-craft.js';
import { craftPdf } from '../helpers/pdf-craft.js';
import { removeDir, tempDir } from '../helpers/cli.js';
import { MEDIA, nativeVideoAvailable } from '../helpers/native.js';

/** Smoke tests of the native adapters under the Bun runtime (`bun test test/bun`). */

setDefaultTimeout(60_000);
const video = nativeVideoAvailable();
let dir: string;

beforeAll(async () => {
  dir = await tempDir('elpx-bun-adapters-');
});
afterAll(async () => {
  await removeDir(dir);
});

/** True while a process with this pid exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runProcess under Bun', () => {
  it('captures output, lines and the exit code', async () => {
    const lines: string[] = [];
    const r = await runProcess('/bin/sh', ['-c', 'echo one; echo two; echo err >&2; exit 3'], { onStdoutLine: (l) => lines.push(l) });
    expect(r.code).toBe(3);
    expect(lines).toEqual(['one', 'two']);
    expect(r.stderr).toBe('err\n');
  });

  it('kills the whole process group on cancel', async () => {
    const controller = new AbortController();
    let grandchild = 0;
    const pending = runProcess('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], {
      signal: controller.signal,
      onStdoutLine: (line) => {
        grandchild = Number(line);
        controller.abort();
      },
    });
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(false);
  });

  it('enforces time limits', async () => {
    await expect(runProcess('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 100 })).rejects.toThrow(/exceeded the time limit/);
  });
});

describe('file adapters under Bun', () => {
  it('writes atomically and reads back with positional reads', async () => {
    const final = join(dir, 'out file ñ.elpx');
    const sink = await AtomicFileSink.create(final);
    await sink.write(new TextEncoder().encode('0123456789'));
    await sink.commit(false);
    expect(await readdir(dir)).toEqual(['out file ñ.elpx']);
    const source = await FileByteSource.open(final);
    expect(new TextDecoder().decode(await source.read(2, 3))).toBe('234');
    await source.close();
    const again = await AtomicFileSink.create(final);
    await expect(again.commit(false)).rejects.toMatchObject({ code: 'output-exists' });
  });

  it('extracts ZIP entries into the private store', async () => {
    const store = await NodeResourceStore.create({ tempRoot: dir });
    try {
      const archive = await openZip(
        new MemoryByteSource(craftZip([{ name: 'content/resources/a.png', data: 'pixels'.repeat(100), method: 8 }])),
        NATIVE_LIMITS,
      );
      const resource = await store.fromEntry(archive, archive.entries[0]!, 'png');
      expect(await readFile(resource.path, 'utf8')).toBe('pixels'.repeat(100));
    } finally {
      await store.disposeAll();
    }
  });
});

describe('native media engine under Bun', () => {
  let store: NodeResourceStore;
  beforeAll(async () => {
    store = await NodeResourceStore.create({ tempRoot: dir });
  });
  afterAll(async () => {
    await store.disposeAll();
  });

  it('loads sharp and encodes an image losslessly', async () => {
    const engine = new NativeMediaEngine(store, { tools: { ffmpeg: '/nonexistent/ffmpeg' } });
    const info = await engine.info();
    expect(info.image.available).toBe(true);
    const png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } })
        .png()
        .toBuffer(),
    );
    const job = {
      format: 'png',
      mode: 'lossless',
      quality: undefined,
      resize: undefined,
      metadata: { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true },
      expected: { width: 8, height: 8, hasAlpha: true },
      conversions: [],
    } as const;
    const out = await engine.encodeImage(png, job, { resourcePath: 'a.png', timeoutMs: 30_000 });
    expect(await engine.verifyImage(png, out, job, { resourcePath: 'a.png', timeoutMs: 30_000 })).toMatchObject({ ok: true, identicalPixels: true });
  });

  it.skipIf(!video)('detects ffmpeg and probes a video', async () => {
    const engine = new NativeMediaEngine(store);
    const info = await engine.info();
    expect(info.video.available).toBe(true);
    const resource = await store.fromBytes(new Uint8Array(await readFile(join(MEDIA, 'efficient.mp4'))), 'mp4');
    const probe = await engine.probe(resource, { resourcePath: 'efficient.mp4', timeoutMs: 60_000 });
    expect(probe.streams.some((s) => s.type === 'video')).toBe(true);
  });

  it('runs qpdf (WebAssembly) through the runner with Bun', async () => {
    const engine = new NativeMediaEngine(store, { tools: { ffmpeg: '/nonexistent/ffmpeg' } });
    expect((await engine.info()).pdf).toMatchObject({ available: true, engine: expect.stringMatching(/^qpdf \d+\.\d+\.\d+ \(WebAssembly\)$/) });
    const ctx = { resourcePath: 'a.pdf', timeoutMs: 60_000 };
    const pdf = craftPdf({ pages: 2, image: { width: 100, height: 100 } });
    expect(await inspectPdf(engine, pdf, ctx)).toEqual({ pages: 2, encrypted: false, signed: false, pdfA1: false, linearized: false });
    const r = await engine.runQpdf(['--object-streams=generate', '--optimize-images', PDF_INPUT, PDF_OUTPUT], pdf, ctx);
    expect(r.code).toBe(0);
    expect(r.output!.length).toBeLessThan(pdf.length);
    await checkPdf(engine, r.output!, ctx);
  });
});
