import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { optimizeArchive, type OptimizeOutcome } from '../../../src/core/optimize/optimize.js';
import { buildOptimizationPlan, type OptimizationPlan } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import { CancelledError, ElpxError } from '../../../src/core/errors.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import type { ProgressEvent } from '../../../src/core/media/engine.js';
import type { Limits } from '../../../src/core/limits.js';
import { analyzeBytes, buildElpx, dec, limits } from '../../helpers/core-kit.js';
import { FakeEngine, MemoryStore, fakePlatform } from '../../helpers/fake-platform.js';
import { PdfEngine, fakePdf, fakePdfFacts, fakeQpdf, qpdfCommands, shrink, type FakeRewrite } from '../../helpers/fake-pdf.js';

/** PDF rewriting in optimizeArchive with the fake qpdf: the image pass, the lossless fallback, validation, failures and cancellation. */

const R = '{{context_path}}/content/resources';
const GUIA = 'content/resources/guia.pdf';

interface PdfRun {
  analysis: Analysis;
  plan: OptimizationPlan;
  outcome: OptimizeOutcome;
  engine: PdfEngine;
  /** Delivered entries (empty when nothing was delivered). */
  files: Map<string, Uint8Array>;
  events: ProgressEvent[];
}

/** A package linking the given PDFs from one page. */
function pdfPackage(files: Record<string, Uint8Array>, extra: { manifest?: boolean } = {}): Uint8Array {
  return buildElpx({
    components: [
      {
        html: Object.keys(files)
          .map((p) => `<a href="${R}/${p.slice('content/resources/'.length)}">PDF</a>`)
          .join(''),
      },
    ],
    files,
    ...extra,
  });
}

/** Analyzes, plans and optimizes with the fake qpdf; `setup` configures the engine after the analysis. */
async function run(
  bytes: Uint8Array,
  options: OptionsInput = {},
  setup: (engine: PdfEngine) => void = () => undefined,
  extra: { signal?: AbortSignal; platformLimits?: Limits; onProgress?: (e: ProgressEvent) => void } = {},
): Promise<PdfRun> {
  const engine = new PdfEngine(new MemoryStore());
  const analysis = await analyzeBytes(bytes, { media: { engine, store: engine.store } });
  setup(engine);
  engine.qpdfRuns.length = 0;
  const plan = buildOptimizationPlan(analysis, normalizeOptions(options), await engine.info(), limits());
  const platform = fakePlatform({ engine, store: engine.store, ...(extra.platformLimits ? { limits: extra.platformLimits } : {}) });
  const events: ProgressEvent[] = [];
  const outcome = await optimizeArchive(new MemoryByteSource(bytes), analysis, plan, platform, {
    outputName: 'out.elpx',
    onProgress: (e) => {
      events.push(e);
      extra.onProgress?.(e);
    },
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  const files = new Map<string, Uint8Array>();
  if (outcome.output) {
    const zip = await openZip(outcome.output, platform.limits);
    for (const e of zip.entries) files.set(e.name, await readEntryBytes(zip, e, 1 << 26));
  }
  return { analysis, plan, outcome, engine, files, events };
}

/** PDF results as [path, status, detail]. */
function pdfResults(r: PdfRun): [string, string, string | undefined][] {
  return r.outcome.report.operations.filter((o) => o.op === 'optimize-pdf').map((o) => [o.path, o.status, o.detail]);
}

/** A rewrite answering each pass with its own function (the default shrink otherwise). */
function perPass(passes: Partial<Record<'images' | 'lossless', FakeRewrite>>): FakeRewrite {
  return (pass, input, facts) => (passes[pass] ?? shrink)(pass, input, facts);
}

const guia = (): Uint8Array => pdfPackage({ [GUIA]: fakePdf(10_000, { pages: 3 }) });

describe('optimizeArchive: PDFs', () => {
  it('keeps the image pass when it is valid and smaller, checking and inspecting the new file', async () => {
    const r = await run(guia());
    expect(pdfResults(r)).toEqual([[GUIA, 'applied', undefined]]);
    const op = r.outcome.report.operations.find((o) => o.op === 'optimize-pdf')!;
    expect(op).toMatchObject({ lossy: true, before: 10_000, after: 4000, checks: ['qpdf --check without warnings', '3 pages, as in the original'] });
    expect(op.conversions).toEqual([
      'PDF streams recompressed and packed into object streams (lossless)',
      'images that are not JPEG converted to JPEG where that makes them smaller (lossy)',
    ]);
    expect(r.outcome.report.status).toBe('optimized');
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
    // Rewrite, --check, then the inspection of the candidate; the lossless pass is not needed.
    expect(qpdfCommands(r.engine)).toEqual(['rewrite:images', '--check', '--json=2', '--check-linearization']);
    expect(r.files.get(GUIA)).toEqual(fakePdf(4000, { pages: 3 }));
    expect(r.engine.store.extensions).toContain('pdf');
    expect(r.events.filter((e) => e.stage === 'pdf')).toEqual([{ stage: 'pdf', resource: GUIA, item: 1, items: 1, message: 'qpdf, images pass' }]);
  });

  it('falls back to the lossless pass and says why the image pass was not kept', async () => {
    // The image pass comes out larger; the lossless one saves enough.
    const larger = await run(guia(), {}, (e) => (e.rewrite = perPass({ images: (_p, input, facts) => fakePdf(input.length + 2000, facts) })));
    expect(pdfResults(larger)).toEqual([[GUIA, 'applied', 'lossless pass kept (images pass not smaller enough (10000 → 12000 bytes))']]);
    expect(larger.outcome.report.operations.find((o) => o.op === 'optimize-pdf')).toMatchObject({ lossy: false, after: 8000 });
    expect(larger.files.get(GUIA)).toEqual(fakePdf(8000, { pages: 3 }));
    expect(qpdfCommands(larger.engine)).toEqual([
      'rewrite:images',
      '--check',
      '--json=2',
      '--check-linearization',
      'rewrite:lossless',
      '--check',
      '--json=2',
      '--check-linearization',
    ]);
    expect(larger.events.filter((e) => e.stage === 'pdf').map((e) => e.message)).toEqual(['qpdf, images pass', 'qpdf, lossless pass']);
    // qpdf warnings during the image pass.
    const warned = await run(
      guia(),
      {},
      (e) =>
        (e.rewrite = perPass({
          images: () => ({ code: 3, stdout: '', stderr: 'WARNING: /in.pdf (object 7 0): unknown token\n', output: new Uint8Array(10) }),
        })),
    );
    expect(pdfResults(warned)).toEqual([
      [GUIA, 'applied', 'lossless pass kept (images pass: qpdf reported warnings: WARNING: /in.pdf (object 7 0): unknown token)'],
    ]);
    // A candidate that loses a page is rejected.
    const lost = await run(guia(), {}, (e) => (e.rewrite = perPass({ images: (_p, input) => fakePdf(input.length / 4, { pages: 2 }) })));
    expect(pdfResults(lost)).toEqual([[GUIA, 'applied', 'lossless pass kept (images pass rejected: 2 pages instead of 3)']]);
  });

  it('keeps the original when no pass gives a valid, smaller file', async () => {
    const r = await run(
      guia(),
      {},
      (e) =>
        (e.rewrite = perPass({
          images: () => ({ code: 2, stdout: '', stderr: 'qpdf: /in.pdf: out of memory\n' }),
          lossless: (_p, input) => fakePdf(input.length / 2, { pages: 3, encrypted: true }),
        })),
    );
    expect(pdfResults(r)).toEqual([
      [GUIA, 'reverted', 'images pass: qpdf failed: qpdf: /in.pdf: out of memory; lossless pass rejected: the new file is encrypted'],
    ]);
    expect(r.outcome.report.operations.find((o) => o.op === 'optimize-pdf')).toMatchObject({ lossy: false, status: 'reverted' });
    expect(r.outcome.report.status).toBe('no-improvement');
    expect(r.files.get(GUIA)).toEqual(fakePdf(10_000, { pages: 3 }));
    // A candidate that fails qpdf --check, and one that saves too little.
    const checked = await run(guia(), {}, (e) => {
      e.qpdf = (args, input) =>
        Promise.resolve(
          args[0] === '--check'
            ? { code: 3, stdout: 'checking /in.pdf\n', stderr: 'WARNING: page object 5 0 stream 4 0: EOF while reading token\n' }
            : fakeQpdf(args, input),
        );
    });
    expect(pdfResults(checked)).toEqual([
      [
        GUIA,
        'reverted',
        'images pass: qpdf --check reported warnings: WARNING: page object 5 0 stream 4 0: EOF while reading token; lossless pass: qpdf --check reported warnings: WARNING: page object 5 0 stream 4 0: EOF while reading token',
      ],
    ]);
    const small = await run(guia(), { pdf: { images: false } }, (e) => (e.rewrite = (_p, i, facts) => fakePdf(i.length - 100, facts)));
    expect(pdfResults(small)).toEqual([[GUIA, 'reverted', 'lossless pass not smaller enough (10000 → 9900 bytes)']]);
    // A lossless job runs only the lossless pass.
    expect(qpdfCommands(small.engine)).toEqual(['rewrite:lossless', '--check', '--json=2', '--check-linearization']);
  });

  it('keeps the PDF/A-1 structure and requires a linearized result for a linearized original', async () => {
    const bytes = pdfPackage({ 'content/resources/pdfa.pdf': fakePdf(20_000, { pages: 1, pdfA1: true, linearized: true }) });
    const r = await run(bytes);
    expect(pdfResults(r)).toEqual([['content/resources/pdfa.pdf', 'applied', undefined]]);
    const rewrite = r.engine.qpdfRuns[0]!;
    expect(rewrite).toContain('--object-streams=preserve');
    expect(rewrite).toContain('--linearize');
    expect(fakePdfFacts(r.files.get('content/resources/pdfa.pdf')!)).toEqual({ pages: 1, pdfA1: true, linearized: true });
    // Candidates that lost the linearization are rejected.
    const flat = await run(bytes, {}, (e) => (e.rewrite = (_pass, input) => fakePdf(input.length / 2, { pages: 1, pdfA1: true })));
    expect(pdfResults(flat)).toEqual([
      [
        'content/resources/pdfa.pdf',
        'reverted',
        'images pass rejected: the new file is not linearized; lossless pass rejected: the new file is not linearized',
      ],
    ]);
  });

  it('numbers PDFs and keeps renamed and listed files consistent', async () => {
    const bytes = pdfPackage(
      { 'content/resources/Guía Final.pdf': fakePdf(10_000, { pages: 3 }), 'content/resources/otra.pdf': fakePdf(8000, { pages: 2 }) },
      { manifest: true },
    );
    const r = await run(bytes, { normalizeNames: 'slug' });
    expect(pdfResults(r).map(([path, status]) => [path, status])).toEqual([
      ['content/resources/Guía Final.pdf', 'applied'],
      ['content/resources/otra.pdf', 'applied'],
    ]);
    expect(r.events.filter((e) => e.stage === 'pdf').map((e) => [e.resource, e.item, e.items])).toEqual([
      ['content/resources/Guía Final.pdf', 1, 2],
      ['content/resources/otra.pdf', 2, 2],
    ]);
    // The rewritten file is delivered under its new name, and the references and the manifest follow it.
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
    expect(r.files.get('content/resources/guia-final.pdf')).toEqual(fakePdf(4000, { pages: 3 }));
    expect(r.files.has('content/resources/Guía Final.pdf')).toBe(false);
    expect(dec.decode(r.files.get('libs/elpx-manifest.js')!)).toContain('content/resources/guia-final.pdf');
    expect(dec.decode(r.files.get('content.xml')!)).toContain(`${R}/guia-final.pdf`);
  });

  it('fails the operation when the engine cannot run qpdf or the file cannot be read', async () => {
    const plain = await run(guia(), {}, (e) => {
      (e as { runQpdf?: unknown }).runQpdf = undefined;
    });
    expect(pdfResults(plain)).toEqual([[GUIA, 'failed', 'This engine does not process PDFs']]);
    expect(plain.outcome.report.status).toBe('no-improvement');
    // The stored PDF is damaged after the analysis read it (its CRC no longer matches).
    const bytes = guia();
    const damaged = await run(bytes, {}, () => {
      const at = Buffer.from(bytes).indexOf('%facts ') + 500;
      bytes[at] = bytes[at]! ^ 0xff;
    });
    expect(pdfResults(damaged)).toEqual([[GUIA, 'failed', 'CRC mismatch in entry "content/resources/guia.pdf"']]);
    expect(damaged.engine.qpdfRuns).toEqual([]);
    // Unexpected errors from qpdf are kept per pass.
    const odd = await run(guia(), {}, (e) => (e.qpdf = () => Promise.reject(new TypeError('boom'))));
    expect(pdfResults(odd)).toEqual([[GUIA, 'reverted', 'images pass: boom; lossless pass: boom']]);
  });

  it('passes the time limit and the cancel signal to qpdf', async () => {
    const seen: [number, boolean][] = [];
    const controller = new AbortController();
    await run(
      guia(),
      { pdf: { images: false } },
      (e) =>
        (e.qpdf = (args, input, ctx) => {
          seen.push([ctx.timeoutMs, ctx.signal === controller.signal]);
          return Promise.resolve(fakeQpdf(args, input));
        }),
      { signal: controller.signal, platformLimits: limits({ videoTimeoutMs: 1234 }) },
    );
    expect(seen).toEqual([
      [1234, true],
      [1234, true],
      [1234, true],
      [1234, true],
    ]);
  });

  it('stops when cancelled during a pass or between passes', async () => {
    for (const error of [new CancelledError(), new ElpxError('cancelled', 'Stopped by the worker')]) {
      const r = await run(guia(), {}, (e) => (e.qpdf = () => Promise.reject(error)));
      expect(r.outcome.report).toMatchObject({ status: 'cancelled', error: 'Cancelled by the user; nothing was delivered' });
      expect(r.outcome.output).toBeUndefined();
    }
    // Aborted while the image pass runs (its result is unusable): the lossless pass is not started.
    const controller = new AbortController();
    const between = await run(
      guia(),
      {},
      (e) =>
        (e.rewrite = perPass({
          images: () => {
            controller.abort();
            return { code: 2, stdout: '', stderr: 'qpdf: interrupted\n' };
          },
        })),
      { signal: controller.signal },
    );
    expect(between.outcome.report.status).toBe('cancelled');
    expect(qpdfCommands(between.engine)).toEqual(['rewrite:images']);
    expect([...between.engine.store.live].every((x) => x.disposed)).toBe(true);
    // Aborted before the PDFs start.
    const early = new AbortController();
    const before = await run(guia(), {}, undefined, { signal: early.signal, onProgress: (e) => e.stage === 'pdf' || early.abort() });
    expect(before.outcome.report.status).toBe('cancelled');
  });

  it('never runs qpdf on the output when the engine has no PDF support', async () => {
    const r = await run(guia(), {}, (e) => (e.infoValue = { ...e.infoValue, pdf: { available: false, reason: 'no runner' } }));
    expect(r.plan.skipped.filter((s) => s.kind === 'pdf').map((s) => s.reason)).toEqual(['engine-unavailable']);
    expect(r.engine.qpdfRuns).toEqual([]);
    expect(r.outcome.report.operations).toEqual([]);
    // A plain fake engine never grows a runQpdf.
    expect('runQpdf' in new FakeEngine(new MemoryStore())).toBe(false);
  });
});
