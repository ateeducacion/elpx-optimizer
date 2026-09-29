import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform, type NodePlatform } from '../../src/adapters/node/platform.js';
import { MemoryByteSource } from '../../src/core/io/byte-source.js';
import { analyzeArchive } from '../../src/core/analyze/analyze.js';
import { buildOptimizationPlan } from '../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../src/core/plan/options.js';
import { optimizeArchive, type OptimizeOutcome } from '../../src/core/optimize/optimize.js';
import { validateArchive } from '../../src/core/validate/validate.js';
import { openZip, readEntryBytes } from '../../src/core/zip/reader.js';
import { NATIVE_LIMITS } from '../../src/core/limits.js';
import { PDF_INPUT, PDF_OUTPUT, checkPdf, inspectPdf } from '../../src/core/media/pdf-policy.js';
import { buildPackage, type Page } from '../helpers/elpx-builder.js';
import { craftPdf } from '../helpers/pdf-craft.js';
import { ROOT } from '../helpers/native.js';

/** PDFs end to end with the native platform: analyze → plan → optimize → validate, with qpdf (WebAssembly) in a child process. */

const work = mkdtempSync(join(tmpdir(), 'elpx-pdf-e2e-'));
const png = new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'media', 'palette-efficient.png')));
const ctx = { resourcePath: 'check.pdf', timeoutMs: 60_000 };
let platform: NodePlatform;

beforeAll(async () => {
  // A platform only for the checks of this file (each run below gets its own).
  platform = await createNodePlatform({ limits: NATIVE_LIMITS, outputPath: join(work, 'unused.elpx') });
});
afterAll(async () => {
  await platform.store.disposeAll();
  rmSync(work, { recursive: true, force: true });
});

/** A one-page project linking each PDF from its content. */
function pdfProject(pdfs: Record<string, Uint8Array>): Uint8Array {
  const html = `<p>${Object.keys(pdfs)
    .map((name) => `<a href="{{context_path}}/content/resources/${name}">${name}</a>`)
    .join(' ')}</p>`;
  const pages: Page[] = [
    { id: 'page-1', name: 'Documentos', file: 'index.html', blocks: [{ id: 'block-1', name: '', components: [{ id: 'idevice-1', type: 'text', html }] }] },
  ];
  return buildPackage(png, 'Documentos', pages, Object.fromEntries(Object.entries(pdfs).map(([name, bytes]) => [`content/resources/${name}`, bytes])), {
    download: true,
  });
}

/** Runs analyze → plan → optimize with the native platform on in-memory input. */
async function optimizeNative(
  bytes: Uint8Array,
  name: string,
  options: OptionsInput = {},
): Promise<{ outcome: OptimizeOutcome; output: Uint8Array | undefined }> {
  const p = await createNodePlatform({ limits: NATIVE_LIMITS, outputPath: join(work, name) });
  try {
    const source = new MemoryByteSource(bytes);
    const analysis = await analyzeArchive(source, { limits: NATIVE_LIMITS, inputName: name, media: { engine: p.engine, store: p.store } });
    const plan = buildOptimizationPlan(analysis, normalizeOptions(options), await p.engine.info(), NATIVE_LIMITS);
    const outcome = await optimizeArchive(source, analysis, plan, p, { outputName: name });
    const output = outcome.output ? new Uint8Array(await outcome.output.read(0, outcome.output.size)) : undefined;
    await p.lastOutput()?.discard();
    return { outcome, output };
  } finally {
    await p.store.disposeAll();
  }
}

/** An entry of an archive. */
async function entryBytes(archive: Uint8Array, name: string): Promise<Uint8Array> {
  const zip = await openZip(new MemoryByteSource(archive), NATIVE_LIMITS);
  return readEntryBytes(zip, zip.byName.get(name)!, 1 << 26);
}

describe('PDFs with the native platform', () => {
  it('rewrites a PDF with a raw image: smaller, clean for qpdf --check, same pages, and the package validates', async () => {
    const original = craftPdf({ pages: 3, image: { width: 600, height: 400 } });
    const input = pdfProject({ 'ficha.pdf': original, 'firmado.pdf': craftPdf({ signatureField: true }) });
    const { outcome, output } = await optimizeNative(input, 'ficha.elpx');
    const report = outcome.report;
    expect(report.status).toBe('optimized');
    expect(report.validations.filter((v) => !v.ok)).toEqual([]);
    const op = report.operations.find((o) => o.op === 'optimize-pdf')!;
    expect(op).toMatchObject({ path: 'content/resources/ficha.pdf', status: 'applied', lossy: true, before: original.length });
    expect(op.checks).toEqual(['qpdf --check without warnings', '3 pages, as in the original']);
    expect(op.detail).toBeUndefined();
    // The signed PDF is left alone.
    expect(report.operations.some((o) => o.path === 'content/resources/firmado.pdf')).toBe(false);
    const rewritten = await entryBytes(output!, 'content/resources/ficha.pdf');
    expect(rewritten.length).toBe(op.after);
    expect(rewritten.length).toBeLessThan(original.length / 4);
    await checkPdf(platform.engine, rewritten, ctx);
    expect(await inspectPdf(platform.engine, rewritten, ctx)).toEqual({ pages: 3, encrypted: false, signed: false, pdfA1: false, linearized: false });
    expect(await entryBytes(output!, 'content/resources/firmado.pdf')).toEqual(await entryBytes(input, 'content/resources/firmado.pdf'));
    const validation = await validateArchive(new MemoryByteSource(output!), { limits: NATIVE_LIMITS });
    expect(validation.verdict).toBe('valid');
  });

  it('keeps the lossless pass for --pdf-lossless, and a linearized PDF/A-1 stays linearized and PDF/A-1', async () => {
    const image = craftPdf({ pages: 2, image: { width: 300, height: 200 } });
    const lossless = await optimizeNative(pdfProject({ 'ficha.pdf': image }), 'lossless.elpx', { pdf: { images: false } });
    const op = lossless.outcome.report.operations.find((o) => o.op === 'optimize-pdf')!;
    expect(op).toMatchObject({ status: 'applied', lossy: false });
    expect(op.after!).toBeLessThan(op.before!);
    // Linearize a PDF/A-1 file with qpdf itself, then optimize it.
    const pdfa = (await platform.engine.runQpdf(['--linearize', PDF_INPUT, PDF_OUTPUT], craftPdf({ pdfA1: true, image: { width: 200, height: 200 } }), ctx))
      .output!;
    expect(await inspectPdf(platform.engine, pdfa, ctx)).toMatchObject({ pdfA1: true, linearized: true });
    const { outcome, output } = await optimizeNative(pdfProject({ 'pdfa.pdf': pdfa }), 'pdfa.elpx');
    const pdfaOp = outcome.report.operations.find((o) => o.op === 'optimize-pdf')!;
    expect(pdfaOp.conversions).toContain('PDF/A-1 structure preserved (no object streams)');
    expect(pdfaOp.status).toBe('applied');
    const kept = await entryBytes(output!, 'content/resources/pdfa.pdf');
    expect(await inspectPdf(platform.engine, kept, ctx)).toEqual({ pages: 1, encrypted: false, signed: false, pdfA1: true, linearized: true });
    await checkPdf(platform.engine, kept, ctx);
  });

  it('keeps the original when qpdf --check warns about the result, and never rewrites encrypted PDFs', async () => {
    // A content stream that ends inside a token: qpdf copies it, and --check warns about the copy.
    const broken = craftPdf({ image: { width: 200, height: 200 } });
    broken.set(new TextEncoder().encode('>'), Buffer.from(broken).indexOf('recompression)') + 13);
    const encrypted = (await platform.engine.runQpdf(['--encrypt', '', 'owner', '256', '--', PDF_INPUT, PDF_OUTPUT], craftPdf(), ctx)).output!;
    const input = pdfProject({ 'roto.pdf': broken, 'cifrado.pdf': encrypted });
    const { outcome, output } = await optimizeNative(input, 'roto.elpx');
    const op = outcome.report.operations.find((o) => o.op === 'optimize-pdf')!;
    expect(op.path).toBe('content/resources/roto.pdf');
    expect(op.status).toBe('reverted');
    expect(op.detail).toMatch(/^images pass: qpdf --check reported warnings: .*EOF while reading token; lossless pass: qpdf --check reported warnings: /);
    expect(outcome.report.status).toBe('no-improvement');
    expect(output).toEqual(input);
  });
});
