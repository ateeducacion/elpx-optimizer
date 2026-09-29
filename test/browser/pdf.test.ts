import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import wasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import { BlobStore } from '../../src/adapters/browser/blob-io.js';
import { BrowserMediaEngine, type PdfWorkerLike } from '../../src/adapters/browser/browser-media-engine.js';
import { FFMPEG_ASSETS } from '../../src/adapters/browser/ffmpeg-assets.js';
import { QPDF_VERSION, runQpdfWasm, wasmFromMemory } from '../../src/adapters/browser/qpdf-wasm.js';
import { CancelledError, ElpxError } from '../../src/core/errors.js';
import { BROWSER_LIMITS } from '../../src/core/limits.js';
import type { QpdfResult } from '../../src/core/media/engine.js';
import { checkPdf, decidePdf, inspectPdf, rewritePdf } from '../../src/core/media/pdf-policy.js';
import { normalizeOptions } from '../../src/core/plan/options.js';
import { craftPdf } from '../helpers/pdf-craft.js';

const ctx = { resourcePath: 'content/resources/ficha.pdf', timeoutMs: 60_000 };
const wasm = new URL(wasmUrl, location.href).href;

describe('qpdf compiled to WebAssembly', () => {
  it('is the pinned version', async () => {
    const r = await runQpdfWasm(wasm, ['--version'], new Uint8Array());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`version ${QPDF_VERSION}`);
    expect(r.output).toBeUndefined();
  });

  it('returns the exit code and message of a failed run', async () => {
    const r = await runQpdfWasm(wasm, ['--no-such-option'], new Uint8Array());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no-such-option');
  });

  it('loads the module from memory after one download, and retries a failed download', async () => {
    const fetches: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      fetches.push(url);
      return realFetch(url, init);
    });
    try {
      const missing = wasmFromMemory(new URL('missing-qpdf.wasm', location.href).href);
      await expect(missing()).rejects.toThrow('qpdf.wasm could not be downloaded: HTTP 404');
      await expect(missing()).rejects.toThrow('HTTP 404');
      const load = wasmFromMemory(wasm);
      const url = await load();
      expect(url).toMatch(/^blob:/);
      expect(await load()).toBe(url);
      expect(fetches.filter((f) => f === wasm)).toHaveLength(1);
      expect(fetches.filter((f) => f.endsWith('missing-qpdf.wasm'))).toHaveLength(2);
      const r = await runQpdfWasm(url, ['--version'], new Uint8Array());
      expect(r.stdout).toContain(QPDF_VERSION);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps no state between runs (each run gets a fresh instance)', async () => {
    const input = craftPdf();
    const first = await runQpdfWasm(wasm, ['--check', '/in.pdf'], input);
    const second = await runQpdfWasm(wasm, ['--check', '/in.pdf'], input);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
  });
});

describe('BrowserMediaEngine PDF jobs (real qpdf worker)', () => {
  const engine = new BrowserMediaEngine({ store: new BlobStore(), assets: FFMPEG_ASSETS, threading: 'single' });

  afterAll(async () => {
    await engine.dispose();
  });

  it('reports qpdf as its PDF engine', async () => {
    expect((await engine.info()).pdf).toEqual({ available: true, engine: `qpdf ${QPDF_VERSION} (WebAssembly)` });
  });

  it('inspects pages, signature fields and PDF/A-1 metadata', async () => {
    expect(await inspectPdf(engine, craftPdf({ pages: 3 }), ctx)).toEqual({ pages: 3, encrypted: false, signed: false, pdfA1: false, linearized: false });
    expect(await inspectPdf(engine, craftPdf({ signatureField: true }), ctx)).toMatchObject({ pages: 1, signed: true });
    expect(await inspectPdf(engine, craftPdf({ pdfA1: true }), ctx)).toMatchObject({ pdfA1: true });
  });

  it('rewrites a PDF with a raw image into a much smaller one that checks clean and keeps its pages', async () => {
    const input = craftPdf({ pages: 2, image: { width: 400, height: 300 } });
    const info = await inspectPdf(engine, input, ctx);
    const decision = decidePdf({ size: input.length, info }, normalizeOptions().pdf, (await engine.info()).pdf!, BROWSER_LIMITS);
    if (decision.action !== 'optimize') throw new Error(decision.detail);
    const out = await rewritePdf(engine, input, decision.job, 'images', ctx);
    expect(out.length).toBeLessThan(input.length / 10);
    await checkPdf(engine, out, ctx);
    expect((await inspectPdf(engine, out, ctx)).pages).toBe(2);
    // The worker receives a copy: the caller's bytes are not transferred away.
    expect(input.length).toBeGreaterThan(0);
  });

  it('runs several requests through one worker', async () => {
    const results = await Promise.all([1, 2, 3].map((pages) => inspectPdf(engine, craftPdf({ pages }), ctx)));
    expect(results.map((r) => r.pages)).toEqual([1, 2, 3]);
  });

  it('answers a request it cannot run with an error message', async () => {
    const worker = new Worker(new URL('../../src/adapters/browser/pdf.worker.ts', import.meta.url), { type: 'module' });
    try {
      const reply = await new Promise<{ id: number; error?: string }>((resolve) => {
        worker.onmessage = (e: MessageEvent<{ id: number; error?: string }>) => resolve(e.data);
        worker.postMessage({ id: 7, args: ['--check', '/in.pdf'], input: 42 });
      });
      expect(reply.id).toBe(7);
      expect(reply.error).toBeTruthy();
    } finally {
      worker.terminate();
    }
  });
});

/** qpdf worker double: records requests and answers only when told to. */
class FakePdfWorker implements PdfWorkerLike {
  readonly posted: { id: number; args: readonly string[]; input: Uint8Array; transfer?: Transferable[] }[] = [];
  terminated = false;
  onmessage: PdfWorkerLike['onmessage'] = null;
  onerror: PdfWorkerLike['onerror'] = null;

  postMessage(message: { id: number; args: readonly string[]; input: Uint8Array }, transfer?: Transferable[]): void {
    this.posted.push({ ...message, ...(transfer ? { transfer } : {}) });
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: { id: number; result?: QpdfResult; error?: string }): void {
    this.onmessage?.({ data });
  }
}

describe('BrowserMediaEngine PDF jobs (injected worker)', () => {
  function fakeEngine(): { engine: BrowserMediaEngine; workers: FakePdfWorker[] } {
    const workers: FakePdfWorker[] = [];
    const engine = new BrowserMediaEngine({
      store: new BlobStore(),
      assets: FFMPEG_ASSETS,
      threading: 'single',
      createPdfWorker: () => {
        const w = new FakePdfWorker();
        workers.push(w);
        return w;
      },
    });
    return { engine, workers };
  }

  const ok: QpdfResult = { code: 0, stdout: 'ok', stderr: '' };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('matches answers to requests by id, sends a copy of the input and reuses the worker', async () => {
    const { engine, workers } = fakeEngine();
    const input = new Uint8Array([1, 2, 3]);
    const a = engine.runQpdf(['--version'], input, ctx);
    const b = engine.runQpdf(['--check', '/in.pdf'], input, ctx);
    const [w] = workers;
    expect(workers).toHaveLength(1);
    expect(w!.posted.map((p) => p.args)).toEqual([['--version'], ['--check', '/in.pdf']]);
    expect(w!.posted[0]!.input).toEqual(input);
    expect(w!.posted[0]!.input).not.toBe(input);
    expect(w!.posted[0]!.transfer).toEqual([w!.posted[0]!.input.buffer]);
    w!.reply({ id: 999, result: ok });
    w!.reply({ id: w!.posted[1]!.id, result: { ...ok, stdout: 'second' } });
    w!.reply({ id: w!.posted[0]!.id, result: ok });
    await expect(a).resolves.toEqual(ok);
    await expect(b).resolves.toMatchObject({ stdout: 'second' });
    expect(input).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reports an error answer as media-failed', async () => {
    const { engine, workers } = fakeEngine();
    const a = engine.runQpdf(['--version'], new Uint8Array(), ctx);
    const b = engine.runQpdf(['--version'], new Uint8Array(), ctx);
    workers[0]!.reply({ id: workers[0]!.posted[0]!.id, error: 'boom' });
    workers[0]!.reply({ id: workers[0]!.posted[1]!.id });
    await expect(a).rejects.toThrow(new ElpxError('media-failed', 'qpdf could not run: boom'));
    await expect(b).rejects.toThrow('qpdf could not run: unknown error');
  });

  it('fails every pending run when the worker crashes, and starts a new worker next time', async () => {
    const { engine, workers } = fakeEngine();
    const a = engine.runQpdf(['--version'], new Uint8Array(), ctx);
    const b = engine.runQpdf(['--version'], new Uint8Array(), ctx);
    workers[0]!.onerror!({ message: 'out of memory' });
    await expect(a).rejects.toThrow('qpdf worker failed: out of memory');
    await expect(b).rejects.toThrow('qpdf worker failed: out of memory');
    expect(workers[0]!.terminated).toBe(true);
    const c = engine.runQpdf(['--version'], new Uint8Array(), ctx);
    expect(workers).toHaveLength(2);
    workers[1]!.onerror!({});
    await expect(c).rejects.toThrow('qpdf worker failed: unknown error');
  });

  it('terminates the worker when a run exceeds its time limit', async () => {
    vi.useFakeTimers();
    const { engine, workers } = fakeEngine();
    const run = engine.runQpdf(['--version'], new Uint8Array(), { ...ctx, timeoutMs: 1000 });
    const failed = expect(run).rejects.toThrow('qpdf exceeded the time limit in the browser');
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(workers[0]!.terminated).toBe(true);
  });

  it('terminates the worker on cancellation, and does not start one for a cancelled run', async () => {
    const { engine, workers } = fakeEngine();
    const controller = new AbortController();
    const run = engine.runQpdf(['--version'], new Uint8Array(), { ...ctx, signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0]!.terminated).toBe(true);
    await expect(engine.runQpdf(['--version'], new Uint8Array(), { ...ctx, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(workers).toHaveLength(1);
  });

  it('stops the worker on dispose, cancelling pending runs', async () => {
    const { engine, workers } = fakeEngine();
    const run = engine.runQpdf(['--version'], new Uint8Array(), ctx);
    await engine.dispose();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('reports PDFs as unavailable without WebAssembly or workers', async () => {
    const { engine } = fakeEngine();
    vi.stubGlobal('Worker', undefined);
    expect((await engine.info()).pdf).toEqual({ available: false, reason: 'WebAssembly or Web Workers are not available' });
  });
});
