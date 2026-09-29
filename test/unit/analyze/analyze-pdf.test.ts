import { describe, expect, it } from 'vitest';
import { CancelledError, ElpxError } from '../../../src/core/errors.js';
import type { ProgressEvent } from '../../../src/core/media/engine.js';
import { analyzeBytes, buildElpx, diags, entry, limits } from '../../helpers/core-kit.js';
import { FakeEngine, MemoryStore, engineInfo } from '../../helpers/fake-platform.js';
import { PDF_CAPS, PdfEngine, fakePdf, fakeQpdf, qpdfCommands } from '../../helpers/fake-pdf.js';

/** Inspection of PDFs with qpdf during the analysis: which files are inspected, what their summaries say and how failures are reported. */

const R = '{{context_path}}/content/resources';

const bytes = buildElpx({
  components: [
    { html: ['guia.pdf', 'firmado.pdf', 'cifrado.pdf', 'pdfa.pdf', 'roto.pdf', 'enorme.pdf', 'falso.pdf'].map((f) => `<a href="${R}/${f}">${f}</a>`).join('') },
  ],
  files: {
    'content/resources/guia.pdf': fakePdf(5000, { pages: 3 }),
    'content/resources/firmado.pdf': fakePdf(4000, { pages: 1, signed: true }),
    'content/resources/cifrado.pdf': fakePdf(4000, { pages: 2, encrypted: true }),
    'content/resources/pdfa.pdf': fakePdf(4000, { pages: 1, pdfA1: true, linearized: true }),
    // Starts like a PDF, but qpdf cannot read it.
    'content/resources/roto.pdf': '%PDF-1.4\n% truncated\n',
    'content/resources/enorme.pdf': fakePdf(9000, { pages: 40 }),
    // Named .pdf, but not a PDF.
    'content/resources/falso.pdf': 'plain text',
    // Runtime files are never inspected.
    'theme/manual.pdf': fakePdf(3000, { pages: 1 }),
  },
});

/** How many files qpdf was asked to inspect (the JSON is the first run for every file). */
function inspected(engine: PdfEngine): number {
  return qpdfCommands(engine).filter((c) => c === '--json=2').length;
}

describe('analyzeArchive: PDFs', () => {
  it('inspects the PDFs among user assets with qpdf and records their facts', async () => {
    const store = new MemoryStore();
    const engine = new PdfEngine(store);
    const events: ProgressEvent[] = [];
    const a = await analyzeBytes(bytes, { media: { engine, store }, limits: limits({ maxPdfBytes: 8000 }), onProgress: (e) => events.push(e) });
    expect(a.pdfs).toEqual(
      new Map([
        ['content/resources/cifrado.pdf', { pages: 2, encrypted: true, signed: false, pdfA1: false, linearized: false }],
        ['content/resources/firmado.pdf', { pages: 1, encrypted: false, signed: true, pdfA1: false, linearized: false }],
        ['content/resources/guia.pdf', { pages: 3, encrypted: false, signed: false, pdfA1: false, linearized: false }],
        ['content/resources/pdfa.pdf', { pages: 1, encrypted: false, signed: false, pdfA1: true, linearized: true }],
      ]),
    );
    expect(entry(a, 'content/resources/guia.pdf')).toMatchObject({ kind: 'document', format: 'pdf', pdf: { pages: 3, encrypted: false } });
    expect(entry(a, 'content/resources/pdfa.pdf').pdf).toEqual({ pages: 1, encrypted: false, signed: false, pdfA1: true, linearized: true });
    // Above the size limit, not a PDF, unreadable or not a user asset: no facts.
    for (const p of ['content/resources/enorme.pdf', 'content/resources/falso.pdf', 'content/resources/roto.pdf', 'theme/manual.pdf'])
      expect(entry(a, p).pdf).toBeUndefined();
    // Each readable file: its JSON, then its linearization; the unreadable one stops at the JSON.
    expect(inspected(engine)).toBe(5);
    expect(qpdfCommands(engine).filter((c) => c === '--check-linearization')).toHaveLength(4);
    expect(diags(a, 'media-probe-failed').map((d) => [d.resource, d.message])).toEqual([
      ['content/resources/roto.pdf', "content/resources/roto.pdf: qpdf could not read the PDF: qpdf: /in.pdf: can't find startxref"],
    ]);
    // In archive order.
    const probes = events.filter((e) => e.stage === 'probe').map((e) => [e.resource, e.item, e.items]);
    expect(probes).toEqual([
      ['content/resources/guia.pdf', 1, 5],
      ['content/resources/firmado.pdf', 2, 5],
      ['content/resources/cifrado.pdf', 3, 5],
      ['content/resources/pdfa.pdf', 4, 5],
      ['content/resources/roto.pdf', 5, 5],
    ]);
    // The serialized analysis carries the facts; the engine is not named (no videos or audio were probed).
    expect(a.result.media).toEqual({ probed: false });
  });

  it('passes the cancel signal and reports any other qpdf failure per file', async () => {
    const store = new MemoryStore();
    const engine = new PdfEngine(store);
    const seen: (string | boolean)[] = [];
    engine.qpdf = (args, input, ctx) => {
      seen.push(ctx.resourcePath, ctx.signal !== undefined);
      if (ctx.resourcePath.endsWith('guia.pdf')) return Promise.reject(new ElpxError('media-failed', 'qpdf-runner exceeded the time limit'));
      return Promise.resolve(fakeQpdf(args, input));
    };
    const controller = new AbortController();
    const a = await analyzeBytes(
      buildElpx({
        components: [{ html: `<a href="${R}/guia.pdf">a</a><a href="${R}/otro.pdf">b</a>` }],
        files: { 'content/resources/guia.pdf': fakePdf(3000, { pages: 3 }), 'content/resources/otro.pdf': fakePdf(3000, { pages: 7 }) },
      }),
      { media: { engine, store }, signal: controller.signal },
    );
    expect([...a.pdfs!.keys()]).toEqual(['content/resources/otro.pdf']);
    expect(diags(a, 'media-probe-failed').map((d) => d.message)).toEqual(['content/resources/guia.pdf: qpdf-runner exceeded the time limit']);
    expect(seen).toEqual(['content/resources/guia.pdf', true, 'content/resources/otro.pdf', true, 'content/resources/otro.pdf', true]);
  });

  it('inspects nothing without an engine that runs qpdf and says it can', async () => {
    // No media engine at all.
    expect((await analyzeBytes(bytes)).pdfs).toEqual(new Map());
    // An engine without runQpdf, even one claiming PDF support.
    const store = new MemoryStore();
    const plain = new FakeEngine(store);
    plain.infoValue = engineInfo({ pdf: PDF_CAPS });
    const a = await analyzeBytes(bytes, { media: { engine: plain, store } });
    expect(a.pdfs).toEqual(new Map());
    expect(entry(a, 'content/resources/guia.pdf').pdf).toBeUndefined();
    expect(diags(a, 'media-probe-failed')).toEqual([]);
    // Engines with runQpdf whose PDF support is missing or unavailable.
    for (const pdf of [undefined, { available: false, reason: 'the qpdf runner is not installed next to the CLI' }]) {
      const engine = new PdfEngine(store);
      engine.infoValue = engineInfo(pdf ? { pdf } : {});
      expect((await analyzeBytes(bytes, { media: { engine, store } })).pdfs).toEqual(new Map());
      expect(engine.qpdfRuns).toEqual([]);
    }
    // A package without PDFs never runs qpdf.
    const engine = new PdfEngine(store);
    const none = await analyzeBytes(buildElpx({ components: [{ html: '<p>Hola</p>' }] }), { media: { engine, store } });
    expect(none.pdfs).toEqual(new Map());
    expect(engine.qpdfRuns).toEqual([]);
  });

  it('stops when cancelled, whether qpdf or the signal reports it', async () => {
    const store = new MemoryStore();
    const engine = new PdfEngine(store);
    engine.qpdf = () => Promise.reject(new CancelledError());
    await expect(analyzeBytes(bytes, { media: { engine, store } })).rejects.toBeInstanceOf(CancelledError);
    // Aborted while the first file is inspected: the next one is not started.
    const controller = new AbortController();
    const aborting = new PdfEngine(store);
    aborting.qpdf = (args, input) => {
      controller.abort();
      return Promise.resolve(fakeQpdf(args, input));
    };
    await expect(analyzeBytes(bytes, { media: { engine: aborting, store }, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(inspected(aborting)).toBe(1);
  });
});
