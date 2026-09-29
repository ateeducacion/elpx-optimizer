import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { minimalPdf } from '../../../src/cli/commands/doctor.js';
import type * as EngineModule from '../../../src/adapters/node/native-media-engine.js';
import type { NativeEngineOptions } from '../../../src/adapters/node/native-media-engine.js';
import type { NodeResourceStore } from '../../../src/adapters/node/resource-store.js';
import type { EngineInfo } from '../../../src/core/media/engine.js';
import { PDF_INPUT } from '../../../src/core/media/pdf-policy.js';
import { captureIO, removeDir, tempDir, type CliRun } from '../../helpers/cli.js';

/**
 * doctor's PDF check (qpdf in WebAssembly reads a generated one-page PDF)
 * when the runner is missing, starts but cannot read it, or the engine
 * reports PDF support without details. The engine module is replaced with a
 * subclass configured per test, and main() is re-imported to see it.
 */

interface DoctorJson {
  ok: boolean;
  capabilities: Record<string, { available: boolean; reason?: string; engine?: string }>;
  checks: { name: string; ok: boolean; detail: string }[];
}

let dir: string;

beforeAll(async () => {
  dir = await tempDir('elpx-doctor-pdf-');
});
afterAll(async () => {
  await removeDir(dir);
});
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('../../../src/adapters/node/native-media-engine.js');
});

/** Replaces the native engine with one using `options` and, optionally, changing what info() says about PDFs. */
function mockEngine(options: NativeEngineOptions, pdf?: (info: EngineInfo) => EngineInfo['pdf']): void {
  vi.doMock('../../../src/adapters/node/native-media-engine.js', async (importOriginal) => {
    const mod = await importOriginal<typeof EngineModule>();
    class Engine extends mod.NativeMediaEngine {
      constructor(store: NodeResourceStore, base: NativeEngineOptions = {}) {
        super(store, { ...base, ...options });
      }
      override async info(): Promise<EngineInfo> {
        const info = await super.info();
        if (!pdf) return info;
        const { pdf: _pdf, ...rest } = info;
        const changed = pdf(info);
        return changed ? { ...rest, pdf: changed } : rest;
      }
    }
    return { ...mod, NativeMediaEngine: Engine };
  });
}

/** Runs doctor through a freshly imported main(), without ffmpeg (PDFs do not need it). */
async function doctor(args: string[]): Promise<CliRun> {
  const { main } = await import('../../../src/cli/main.js');
  const { io, out, err } = captureIO();
  const code = await main(['doctor', '--ffmpeg', '/nonexistent/ffmpeg', ...args], io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** The PDF check of a report. */
function pdfCheck(report: DoctorJson): { ok: boolean; detail: string } {
  const c = report.checks.find((x) => x.name === 'pdf-rewrite')!;
  return { ok: c.ok, detail: c.detail };
}

describe('doctor: PDFs', () => {
  it('uses a PDF that qpdf reads without warnings', async () => {
    const { NativeMediaEngine } = await import('../../../src/adapters/node/native-media-engine.js');
    const { NodeResourceStore } = await import('../../../src/adapters/node/resource-store.js');
    const store = await NodeResourceStore.create({ tempRoot: dir });
    try {
      const engine = new NativeMediaEngine(store, { tools: { ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' } });
      const r = await engine.runQpdf(['--check', PDF_INPUT], minimalPdf(), { resourcePath: 'smoke.pdf', timeoutMs: 30_000 });
      expect(r).toMatchObject({ code: 0, stderr: '' });
      expect(r.stdout).toContain('No syntax or stream encoding errors found');
    } finally {
      await store.disposeAll();
    }
    expect(new TextDecoder().decode(minimalPdf())).toMatch(/^%PDF-1\.4\n[\s\S]*startxref\n\d+\n%%EOF\n$/);
  });

  it('reports a missing runner', async () => {
    mockEngine({ qpdfRunner: null });
    const json = await doctor(['--json']);
    expect(json.code).toBe(EXIT.DEPENDENCY);
    const report = JSON.parse(json.stdout) as DoctorJson;
    expect(report.capabilities['pdf']).toEqual({ available: false, reason: 'the qpdf runner is not installed next to the CLI' });
    expect(pdfCheck(report)).toEqual({ ok: false, detail: 'the qpdf runner is not installed next to the CLI' });
    const text = await doctor([]);
    expect(text.stdout).toContain('✗ pdf: the qpdf runner is not installed next to the CLI\n');
  });

  it('fails the check when qpdf starts but cannot read the test PDF', async () => {
    const runner = join(dir, 'version-only.mjs');
    await writeFile(runner, `if (process.argv.includes('--version')) console.log('qpdf version 12.2.0'); else process.exitCode = 2;`);
    mockEngine({ qpdfRunner: runner });
    const report = JSON.parse((await doctor(['--json'])).stdout) as DoctorJson;
    expect(report.capabilities['pdf']).toEqual({ available: false, engine: 'qpdf 12.2.0 (WebAssembly)' });
    expect(pdfCheck(report)).toEqual({ ok: false, detail: 'qpdf smoke test failed' });
    expect((await doctor([])).stdout).toContain('✗ pdf: unavailable\n');
  });

  it('names qpdf generically when the engine does not say which one, and treats no PDF support as unavailable', async () => {
    mockEngine({}, () => ({ available: true }));
    const report = JSON.parse((await doctor(['--json'])).stdout) as DoctorJson;
    expect(report.capabilities['pdf']).toEqual({ available: true });
    expect(pdfCheck(report)).toEqual({ ok: true, detail: 'qpdf read a test PDF' });
    expect((await doctor([])).stdout).toContain('✓ pdf: qpdf\n');
    vi.resetModules();
    mockEngine({}, () => undefined);
    const none = JSON.parse((await doctor(['--json'])).stdout) as DoctorJson;
    expect(none.capabilities['pdf']).toEqual({ available: false });
    expect(pdfCheck(none)).toEqual({ ok: false, detail: 'unavailable' });
    expect((await doctor([])).stdout).toContain('✗ pdf: unavailable\n');
  });
});
