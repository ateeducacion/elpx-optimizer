import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NativeMediaEngine, qpdfRunnerPath } from '../../../src/adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../../src/adapters/node/resource-store.js';
import { QPDF_VERSION } from '../../../src/adapters/browser/qpdf-version.js';
import { CancelledError, ElpxError } from '../../../src/core/errors.js';
import type { EngineInfo } from '../../../src/core/media/engine.js';
import { PDF_INPUT, PDF_OUTPUT, buildQpdfArgs, checkPdf, decidePdf, inspectPdf, rewritePdf, type PdfJob } from '../../../src/core/media/pdf-policy.js';
import { normalizeOptions } from '../../../src/core/plan/options.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import { craftPdf } from '../../helpers/pdf-craft.js';
import { removeDir, tempDir } from '../../helpers/cli.js';

/** The native engine's qpdf: finding and starting the runner, and real qpdf (WebAssembly) runs in a child process. */

let dir: string;
let store: NodeResourceStore;
let engine: NativeMediaEngine;

const ctx = { resourcePath: 'content/resources/guia.pdf', timeoutMs: 60_000 };
/** Tools that do not exist, so detection does not depend on ffmpeg. */
const tools = { ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' };

/** Writes a stand-in runner (plain JavaScript run by the same Node) and returns its path. */
async function fakeRunner(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

/** Error thrown by a promise. */
async function failure(promise: Promise<unknown>): Promise<ElpxError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ElpxError);
  return error as ElpxError;
}

/** PDF files left in a store's directory. */
async function leftovers(s: NodeResourceStore): Promise<string[]> {
  return (await readdir(s.dir)).filter((f) => f.endsWith('.pdf'));
}

/** The planned job for a real PDF, as the core would build it. */
async function jobFor(bytes: Uint8Array, images = true): Promise<PdfJob> {
  const info = await inspectPdf(engine, bytes, ctx);
  const decision = decidePdf({ size: bytes.length, info }, { ...normalizeOptions().pdf, images }, (await engine.info()).pdf!, NATIVE_LIMITS);
  if (decision.action !== 'optimize') throw new Error(`skipped: ${decision.detail}`);
  return decision.job;
}

beforeAll(async () => {
  dir = await tempDir('elpx-pdf-engine-');
  store = await NodeResourceStore.create({ tempRoot: dir });
  engine = new NativeMediaEngine(store, { tools });
});
afterAll(async () => {
  await store.disposeAll();
  await removeDir(dir);
});

describe('qpdfRunnerPath', () => {
  it('prefers the bundled runner, then the source one, next to the given module', async () => {
    const folder = join(dir, 'bundle');
    await mkdir(folder);
    const base = pathToFileURL(join(folder, 'elpx-optimizer.mjs'));
    expect(qpdfRunnerPath(base)).toBeUndefined();
    await writeFile(join(folder, 'qpdf-runner.ts'), '');
    expect(qpdfRunnerPath(base)).toBe(join(folder, 'qpdf-runner.ts'));
    await writeFile(join(folder, 'qpdf-runner.mjs'), '');
    expect(qpdfRunnerPath(base.href)).toBe(join(folder, 'qpdf-runner.mjs'));
    // From source, the runner next to the engine module.
    expect(qpdfRunnerPath()).toBe(fileURLToPath(new URL('../../../src/adapters/node/qpdf-runner.ts', import.meta.url)));
  });
});

describe('NativeMediaEngine: PDF detection', () => {
  it('starts the runner and reports the qpdf version', async () => {
    const info = await engine.info();
    expect(info.pdf).toEqual({ available: true, engine: `qpdf ${QPDF_VERSION} (WebAssembly)` });
    expect(info.versions['qpdf']).toBe(`${QPDF_VERSION} (WebAssembly)`);
  });

  it('reports a missing runner and refuses PDF work', async () => {
    const none = new NativeMediaEngine(store, { tools, qpdfRunner: null });
    const info = await none.info();
    expect(info.pdf).toEqual({ available: false, reason: 'the qpdf runner is not installed next to the CLI' });
    expect(info.versions['qpdf']).toBeUndefined();
    const error = await failure(none.runQpdf(['--check', PDF_INPUT], craftPdf(), ctx));
    expect(error.code).toBe('media-engine-unavailable');
    expect(error.message).toBe('the qpdf runner is not installed next to the CLI');
  });

  it('refuses PDF work whenever the engine does not report a usable qpdf', async () => {
    /** An engine whose info() reports other PDF capabilities than it detected. */
    class Claiming extends NativeMediaEngine {
      constructor(
        private readonly claim: EngineInfo['pdf'],
        qpdfRunner?: string | null,
      ) {
        super(store, { tools, ...(qpdfRunner !== undefined ? { qpdfRunner } : {}) });
      }
      override async info(): Promise<EngineInfo> {
        const { pdf: _detected, ...rest } = await super.info();
        return this.claim ? { ...rest, pdf: this.claim } : rest;
      }
    }
    for (const e of [new Claiming({ available: false }), new Claiming(undefined), new Claiming({ available: true }, null)]) {
      const error = await failure(e.runQpdf(['--check', PDF_INPUT], craftPdf(), ctx));
      expect([error.code, error.message]).toEqual(['media-engine-unavailable', 'qpdf is not available']);
    }
  });

  it('reports a runner that fails to start or does not name a version', async () => {
    const crashing = await fakeRunner('crash.mjs', `process.stderr.write("\\nError: Cannot find package '@neslinesli93/qpdf-wasm'\\n"); process.exit(1);`);
    expect((await new NativeMediaEngine(store, { tools, qpdfRunner: crashing }).info()).pdf).toEqual({
      available: false,
      reason: "qpdf (WebAssembly) could not be started: Error: Cannot find package '@neslinesli93/qpdf-wasm'",
    });
    const silent = await fakeRunner('silent.mjs', '');
    const quiet = new NativeMediaEngine(store, { tools, qpdfRunner: silent });
    expect((await quiet.info()).pdf).toEqual({ available: false, reason: 'qpdf (WebAssembly) could not be started: no output' });
    expect((await failure(quiet.runQpdf(['--check', PDF_INPUT], craftPdf(), ctx))).message).toBe('qpdf (WebAssembly) could not be started: no output');
    // A runner that cannot even be spawned (its working directory is gone).
    const gone = await NodeResourceStore.create({ tempRoot: dir });
    await rm(gone.dir, { recursive: true });
    expect((await new NativeMediaEngine(gone, { tools }).info()).pdf).toEqual({
      available: false,
      reason: 'qpdf (WebAssembly) could not be started: no output',
    });
  });
});

describe('NativeMediaEngine: qpdf runs', () => {
  it('inspects, checks and rewrites a PDF, removing its temporary files', async () => {
    const original = craftPdf({ pages: 3, image: { width: 200, height: 150 } });
    const info = await inspectPdf(engine, original, ctx);
    expect(info).toEqual({ pages: 3, encrypted: false, signed: false, pdfA1: false, linearized: false });
    const check = await engine.runQpdf(['--check', PDF_INPUT], original, ctx);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain('No syntax or stream encoding errors found');
    // Inspection runs write nothing at PDF_OUTPUT.
    expect(check.output).toBeUndefined();
    const job = await jobFor(original);
    const lossy = await rewritePdf(engine, original, job, 'images', ctx);
    const lossless = await rewritePdf(engine, original, job, 'lossless', ctx);
    expect(new TextDecoder().decode(lossy.subarray(0, 5))).toBe('%PDF-');
    // The raw image becomes a JPEG in the image pass; the lossless pass only deflates it.
    expect(lossy.length).toBeLessThan(lossless.length);
    expect(lossless.length).toBeLessThan(original.length);
    for (const candidate of [lossy, lossless]) {
      await checkPdf(engine, candidate, ctx);
      expect((await inspectPdf(engine, candidate, ctx)).pages).toBe(3);
    }
    expect(await leftovers(store)).toEqual([]);
  });

  it('reads signatures, PDF/A-1, encryption and linearization as qpdf sees them', async () => {
    expect((await inspectPdf(engine, craftPdf({ signatureField: true }), ctx)).signed).toBe(true);
    const pdfa = craftPdf({ pdfA1: true, image: { width: 50, height: 50 } });
    expect((await inspectPdf(engine, pdfa, ctx)).pdfA1).toBe(true);
    // PDF/A-1 keeps its structure: no object streams, and the XMP metadata stays readable.
    const job = await jobFor(pdfa, false);
    expect(buildQpdfArgs(job, 'lossless')[0]).toBe('--object-streams=preserve');
    const kept = await rewritePdf(engine, pdfa, job, 'lossless', ctx);
    expect((await inspectPdf(engine, kept, ctx)).pdfA1).toBe(true);
    // Linearized with qpdf itself: detected, kept linearized by the rewrite.
    const linearized = (await engine.runQpdf(['--linearize', PDF_INPUT, PDF_OUTPUT], craftPdf({ pages: 2, image: { width: 100, height: 100 } }), ctx)).output!;
    expect((await inspectPdf(engine, linearized, ctx)).linearized).toBe(true);
    const lin = await jobFor(linearized);
    expect(lin.linearize).toBe(true);
    const relinearized = await rewritePdf(engine, linearized, lin, 'images', ctx);
    expect(await inspectPdf(engine, relinearized, ctx)).toEqual({ pages: 2, encrypted: false, signed: false, pdfA1: false, linearized: true });
    // Encrypted with qpdf itself: with an empty user password qpdf reads it (and the plan skips it); with one, it cannot.
    const open = (await engine.runQpdf(['--encrypt', '', 'owner', '256', '--', PDF_INPUT, PDF_OUTPUT], craftPdf(), ctx)).output!;
    expect((await inspectPdf(engine, open, ctx)).encrypted).toBe(true);
    const locked = (await engine.runQpdf(['--encrypt', 'user', 'owner', '256', '--', PDF_INPUT, PDF_OUTPUT], craftPdf(), ctx)).output!;
    await expect(inspectPdf(engine, locked, ctx)).rejects.toThrow(/^qpdf could not read the PDF: .*invalid password$/);
  });

  it('reports what qpdf reports for files it cannot read or that have problems', async () => {
    await expect(inspectPdf(engine, new TextEncoder().encode('%PDF-1.4\n% truncated\n'), ctx)).rejects.toThrow(
      /^qpdf could not read the PDF: .*can't find startxref$/,
    );
    // A content stream that ends inside a token: readable, but --check warns (exit 3).
    const broken = craftPdf();
    broken.set(new TextEncoder().encode('>'), Buffer.from(broken).indexOf('recompression)') + 13);
    expect((await inspectPdf(engine, broken, ctx)).pages).toBe(1);
    await expect(checkPdf(engine, broken, ctx)).rejects.toThrow(/^qpdf --check reported warnings: WARNING: .*EOF while reading token$/);
    // qpdf itself rejects arguments the policy never builds.
    const bad = await engine.runQpdf(['--no-such-option', PDF_INPUT], craftPdf(), ctx);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unrecognized argument --no-such-option');
    expect(await leftovers(store)).toEqual([]);
  });

  it('enforces the time limit and cancellation, and cleans up', async () => {
    const pdf = craftPdf();
    const slow = await failure(engine.runQpdf(['--check', PDF_INPUT], pdf, { ...ctx, timeoutMs: 1 }));
    expect(slow.code).toBe('media-failed');
    expect(slow.message).toMatch(/exceeded the time limit$/);
    const controller = new AbortController();
    controller.abort();
    await expect(engine.runQpdf(['--check', PDF_INPUT], pdf, { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(await leftovers(store)).toEqual([]);
  });

  it('turns a runner killed by a signal into exit 2 and returns what it wrote', async () => {
    const killer = await fakeRunner(
      'killer.mjs',
      `import { writeFileSync } from 'node:fs';
const [output, ...args] = process.argv.slice(3);
if (args.includes('--version')) console.log('qpdf-runner version 12.2.0');
else if (args.includes('--write')) { writeFileSync(output, '%PDF-fake'); process.stderr.write('wrote\\n'); process.exitCode = 3; }
else process.kill(process.pid, 'SIGKILL');`,
    );
    const e = new NativeMediaEngine(store, { tools, qpdfRunner: killer });
    expect((await e.info()).pdf).toEqual({ available: true, engine: 'qpdf 12.2.0 (WebAssembly)' });
    expect(await e.runQpdf(['--check', PDF_INPUT], craftPdf(), ctx)).toEqual({ code: 2, stdout: '', stderr: '' });
    expect(await e.runQpdf(['--write'], craftPdf(), ctx)).toEqual({ code: 3, stdout: '', stderr: 'wrote\n', output: new TextEncoder().encode('%PDF-fake') });
    expect(await leftovers(store)).toEqual([]);
  });

  it('needs room for the input and two copies before running', async () => {
    const pdf = craftPdf({ pages: 4 });
    let free = pdf.length * 3 - 1;
    const tight = await NodeResourceStore.create({ tempRoot: dir, reserveBytes: 0, freeSpace: () => Promise.resolve(free) });
    try {
      const e = new NativeMediaEngine(tight, { tools });
      const error = await failure(e.runQpdf(['--check', PDF_INPUT], pdf, ctx));
      expect(error.code).toBe('io');
      expect(error.message).toBe(`Insufficient disk space in the temporary directory (${free} bytes free, ${pdf.length * 3} needed)`);
      expect(await leftovers(tight)).toEqual([]);
      free++;
      expect((await e.runQpdf(['--check', PDF_INPUT], pdf, ctx)).code).toBe(0);
    } finally {
      await tight.disposeAll();
    }
  });
});
