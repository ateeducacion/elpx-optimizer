import { describe, expect, it } from 'vitest';
import { buildOptimizationPlan, type OptimizationPlan, type PlanOperation } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import type { EngineInfo } from '../../../src/core/media/engine.js';
import type { Limits } from '../../../src/core/limits.js';
import { analyzeBytes, buildElpx, limits } from '../../helpers/core-kit.js';
import { MemoryStore, engineInfo } from '../../helpers/fake-platform.js';
import { PDF_CAPS, PdfEngine, fakePdf } from '../../helpers/fake-pdf.js';

/** Planning of PDF rewrites: jobs, lossy and lossless passes, PDF/A-1, every skip, the estimate and the risks. */

const R = '{{context_path}}/content/resources';
const LOSSY_RISK = 'Images inside PDFs may be converted to JPEG (lossy); text, fonts, links and forms are not re-rendered.';

const bytes = buildElpx({
  components: [{ html: ['guia.pdf', 'firmado.pdf', 'cifrado.pdf', 'pdfa.pdf', 'roto.pdf', 'enorme.pdf'].map((f) => `<a href="${R}/${f}">${f}</a>`).join('') }],
  files: {
    'content/resources/guia.pdf': fakePdf(10_000, { pages: 3 }),
    'content/resources/firmado.pdf': fakePdf(4000, { pages: 1, signed: true }),
    'content/resources/cifrado.pdf': fakePdf(4000, { pages: 2, encrypted: true }),
    'content/resources/pdfa.pdf': fakePdf(20_000, { pages: 1, pdfA1: true, linearized: true }),
    'content/resources/roto.pdf': '%PDF-1.4\n% truncated\n',
    'content/resources/enorme.pdf': fakePdf(30_000, { pages: 40 }),
    // Not a user asset: never planned.
    'theme/manual.pdf': fakePdf(3000, { pages: 1 }),
  },
});

const LIMITS = limits({ maxPdfBytes: 25_000 });

/** Analyzes with the fake qpdf (PDFs above 25 000 bytes are not inspected). */
function analyze(input: Uint8Array = bytes): Promise<Analysis> {
  const store = new MemoryStore();
  return analyzeBytes(input, { media: { engine: new PdfEngine(store), store }, limits: LIMITS });
}

/** Plans with the given options and engine (PDF-capable by default). */
function plan(analysis: Analysis, options: OptionsInput = {}, engine: EngineInfo = engineInfo({ pdf: PDF_CAPS }), l: Limits = LIMITS): OptimizationPlan {
  return buildOptimizationPlan(analysis, normalizeOptions(options), engine, l);
}

type PdfOp = Extract<PlanOperation, { op: 'optimize-pdf' }>;

/** PDF operations. */
function pdfOps(p: OptimizationPlan): PdfOp[] {
  return p.operations.filter((o): o is PdfOp => o.op === 'optimize-pdf');
}

/** PDF skips as [path, reason, detail]. */
function pdfSkips(p: OptimizationPlan): [string, string, string][] {
  return p.skipped.filter((s) => s.kind === 'pdf').map((s) => [s.path.slice(s.path.lastIndexOf('/') + 1), s.reason, s.detail]);
}

describe('buildOptimizationPlan: PDFs', () => {
  it('rewrites readable PDFs, converting their images by default, and keeps PDF/A-1 and linearization', async () => {
    const p = plan(await analyze());
    expect(pdfOps(p)).toEqual([
      {
        id: 'pdf:content/resources/guia.pdf',
        op: 'optimize-pdf',
        path: 'content/resources/guia.pdf',
        size: 10_000,
        lossy: true,
        conversions: [
          'PDF streams recompressed and packed into object streams (lossless)',
          'images that are not JPEG converted to JPEG where that makes them smaller (lossy)',
        ],
        job: {
          images: true,
          objectStreams: 'generate',
          linearize: false,
          expected: { pages: 3 },
          conversions: [
            'PDF streams recompressed and packed into object streams (lossless)',
            'images that are not JPEG converted to JPEG where that makes them smaller (lossy)',
          ],
        },
        estimatedBytes: 8000,
      },
      {
        id: 'pdf:content/resources/pdfa.pdf',
        op: 'optimize-pdf',
        path: 'content/resources/pdfa.pdf',
        size: 20_000,
        lossy: true,
        conversions: [
          'PDF streams recompressed and packed into object streams (lossless)',
          'images that are not JPEG converted to JPEG where that makes them smaller (lossy)',
          'PDF/A-1 structure preserved (no object streams)',
        ],
        job: expect.objectContaining({ images: true, objectStreams: 'preserve', linearize: true, expected: { pages: 1 } }) as unknown,
        estimatedBytes: 16_000,
      },
    ]);
    // Skips are listed by path.
    expect(pdfSkips(p)).toEqual([
      ['cifrado.pdf', 'encrypted', 'Encrypted PDFs are kept as they are'],
      ['enorme.pdf', 'exceeds-size-limit', 'File is larger than 25000 bytes'],
      ['firmado.pdf', 'signed', 'Signed PDFs are kept as they are (rewriting would invalidate the signature)'],
      ['roto.pdf', 'not-inspected', 'The PDF could not be inspected'],
    ]);
    // 20% of each lossy job; rewriting a PDF never changes the file list.
    expect(p.estimate.savedBytes).toBe(2000 + 4000);
    expect(p.risks).toEqual([LOSSY_RISK]);
    expect(p.operations.map((o) => o.op)).toEqual(['optimize-pdf', 'optimize-pdf']);
  });

  it('plans lossless rewrites when images are kept (option or conservative preset)', async () => {
    const analysis = await analyze();
    for (const options of [{ pdf: { images: false } }, { preset: 'conservative' as const }]) {
      const p = plan(analysis, options);
      expect(pdfOps(p).map((o) => [o.path, o.lossy, o.job.images, o.estimatedBytes])).toEqual([
        ['content/resources/guia.pdf', false, false, 9500],
        ['content/resources/pdfa.pdf', false, false, 19_000],
      ]);
      expect(pdfOps(p)[0]!.conversions).toEqual(['PDF streams recompressed and packed into object streams (lossless)']);
      // 5% of each lossless job, and no lossy-PDF risk.
      expect(p.estimate.savedBytes).toBe(500 + 1000);
      expect(p.risks).not.toContain(LOSSY_RISK);
    }
  });

  it('skips every PDF when PDFs are disabled or the engine cannot process them', async () => {
    const analysis = await analyze();
    const names = ['cifrado.pdf', 'enorme.pdf', 'firmado.pdf', 'guia.pdf', 'pdfa.pdf', 'roto.pdf'];
    const all = (reason: string, detail: string): [string, string, string][] => names.map((n) => [n, reason, detail]);
    expect(pdfSkips(plan(analysis, { pdf: { enabled: false } }))).toEqual(all('pdf-disabled', 'PDF optimization is disabled'));
    expect(pdfSkips(plan(analysis, {}, engineInfo()))).toEqual(all('engine-unavailable', 'This engine does not process PDFs'));
    expect(pdfSkips(plan(analysis, {}, engineInfo({ pdf: { available: false, reason: 'qpdf (WebAssembly) could not be started: no output' } })))).toEqual(
      all('engine-unavailable', 'qpdf (WebAssembly) could not be started: no output'),
    );
    for (const p of [plan(analysis, { pdf: { enabled: false } }), plan(analysis, {}, engineInfo())]) {
      expect(pdfOps(p)).toEqual([]);
      expect(p.estimate.savedBytes).toBe(0);
      expect(p.risks).toEqual([]);
    }
  });

  it('keeps excluded, removed and merged PDFs out of the rewrites', async () => {
    const input = buildElpx({
      components: [{ html: `<a href="${R}/guia.pdf">a</a><a href="${R}/copia.pdf">b</a><a href="${R}/otra.pdf">c</a>` }],
      files: {
        'content/resources/guia.pdf': fakePdf(10_000, { pages: 3 }),
        'content/resources/copia.pdf': fakePdf(10_000, { pages: 3 }),
        'content/resources/otra.pdf': fakePdf(8000, { pages: 2 }),
        'content/resources/huerfano.pdf': fakePdf(6000, { pages: 1 }),
      },
    });
    const p = plan(await analyze(input), { exclude: ['content/resources/otra.pdf'], removeUnused: 'safe', deduplicate: 'exact' });
    // copia.pdf is merged into guia.pdf, huerfano.pdf is removed as unused, otra.pdf is excluded.
    expect(pdfOps(p).map((o) => o.path)).toEqual(['content/resources/guia.pdf']);
    expect(pdfSkips(p)).toEqual([['otra.pdf', 'excluded', 'Kept as original by request']]);
    expect(p.operations.map((o) => o.id)).toEqual(
      expect.arrayContaining(['remove:content/resources/huerfano.pdf', 'dedup:content/resources/guia.pdf', 'pdf:content/resources/guia.pdf']),
    );
  });

  it('treats an analysis without PDF facts as not inspected', async () => {
    const { pdfs: _pdfs, ...rest } = await analyze();
    const p = plan(rest);
    expect(pdfOps(p)).toEqual([]);
    expect(new Set(pdfSkips(p).map(([, reason]) => reason))).toEqual(new Set(['not-inspected', 'exceeds-size-limit']));
  });
});
