import { describe, expect, it } from 'vitest';
import { NATIVE_LIMITS, resolveLimits } from '../../../src/core/limits.js';
import type { JobContext, QpdfResult } from '../../../src/core/media/engine.js';
import {
  PDF_INPUT,
  PDF_INSPECT_ARGS,
  PDF_OUTPUT,
  PDF_PROFILES,
  buildQpdfArgs,
  checkPdf,
  decidePdf,
  inspectPdf,
  isPdfA1,
  parsePdfInspection,
  rewritePdf,
  validatePdfCandidate,
  type PdfCapabilities,
  type PdfDecision,
  type PdfInfo,
  type PdfJob,
  type PdfOptions,
  type QpdfRunner,
} from '../../../src/core/media/pdf-policy.js';

/** The PDF policy: decisions, qpdf arguments, PDF/A-1 detection, inspection parsing, candidate checks and the qpdf helpers. */

const enc = new TextEncoder();
const options: PdfOptions = { enabled: true, preset: 'balanced', images: true, minSavingsPercent: 5, minSavingsBytes: 1024 };
const caps: PdfCapabilities = { available: true, engine: 'qpdf 12.2.0 (WebAssembly)' };
const plain: PdfInfo = { pages: 3, encrypted: false, signed: false, pdfA1: false, linearized: false };
const ctx: JobContext = { resourcePath: 'content/resources/guia.pdf', timeoutMs: 1000 };

/** Runs decidePdf with overrides. */
function decide(
  info: Partial<PdfInfo> | null = {},
  o: Partial<PdfOptions> = {},
  c: PdfCapabilities = caps,
  size = 50_000,
  limits = NATIVE_LIMITS,
): PdfDecision {
  return decidePdf({ size, ...(info ? { info: { ...plain, ...info } } : {}) }, { ...options, ...o }, c, limits);
}

/** Asserts an optimize decision and returns its job. */
function job(d: PdfDecision): PdfJob {
  if (d.action !== 'optimize') throw new Error(`expected optimize, got skip ${d.reason}: ${d.detail}`);
  return d.job;
}

/** A runner answering each qpdf run from a script (by call order); records the arguments and inputs. */
function runner(answers: QpdfResult[]): QpdfRunner & { runs: { args: readonly string[]; input: Uint8Array; ctx: JobContext }[] } {
  const runs: { args: readonly string[]; input: Uint8Array; ctx: JobContext }[] = [];
  return {
    runs,
    runQpdf(args, input, c) {
      runs.push({ args, input, ctx: c });
      const answer = answers[runs.length - 1];
      return answer ? Promise.resolve(answer) : Promise.reject(new Error('unexpected qpdf run'));
    },
  };
}

const ok = (stdout = '', output?: Uint8Array): QpdfResult => ({ code: 0, stdout, stderr: '', ...(output ? { output } : {}) });
const pagesJson = (n: number, extra: object = {}): string => JSON.stringify({ version: 2, pages: Array.from({ length: n }, () => ({})), ...extra });

describe('decidePdf', () => {
  it('optimizes a regular PDF with the image pass first, recompressing its streams', () => {
    const j = job(decide());
    expect(j).toEqual({
      images: true,
      objectStreams: 'generate',
      linearize: false,
      expected: { pages: 3 },
      conversions: [
        'PDF streams recompressed and packed into object streams (lossless)',
        'images that are not JPEG converted to JPEG where that makes them smaller (lossy)',
      ],
    });
    // Without image conversion (the conservative profile) the job is lossless.
    expect(PDF_PROFILES.conservative.images).toBe(false);
    expect(job(decide({}, { images: false }))).toMatchObject({
      images: false,
      conversions: ['PDF streams recompressed and packed into object streams (lossless)'],
    });
  });

  it('keeps the PDF/A-1 structure and the linearization of the original', () => {
    const j = job(decide({ pdfA1: true, linearized: true, pages: 1 }, { images: false }));
    expect(j).toEqual({
      images: false,
      objectStreams: 'preserve',
      linearize: true,
      expected: { pages: 1 },
      conversions: ['PDF streams recompressed and packed into object streams (lossless)', 'PDF/A-1 structure preserved (no object streams)'],
    });
  });

  it('skips for every reason, in order of precedence', () => {
    const skip = (d: PdfDecision): [string, string] => {
      if (d.action !== 'skip') throw new Error('expected a skip');
      return [d.reason, d.detail];
    };
    expect(skip(decide({ encrypted: true }, { enabled: false }))).toEqual(['pdf-disabled', 'PDF optimization is disabled']);
    expect(skip(decide({}, {}, { available: false, reason: 'the qpdf runner is not installed next to the CLI' }))).toEqual([
      'engine-unavailable',
      'the qpdf runner is not installed next to the CLI',
    ]);
    expect(skip(decide({}, {}, { available: false }))).toEqual(['engine-unavailable', 'No PDF engine']);
    // The size limit applies before the inspection (a file above it is never inspected).
    const small = resolveLimits(NATIVE_LIMITS, { maxPdfBytes: 40_000 });
    expect(skip(decide(null, {}, caps, 50_000, small))).toEqual(['exceeds-size-limit', 'File is larger than 40000 bytes']);
    expect(decide({}, {}, caps, 40_000, small).action).toBe('optimize');
    expect(skip(decide(null))).toEqual(['not-inspected', 'The PDF could not be inspected']);
    expect(skip(decide({ encrypted: true, signed: true }))).toEqual(['encrypted', 'Encrypted PDFs are kept as they are']);
    expect(skip(decide({ signed: true }))).toEqual(['signed', 'Signed PDFs are kept as they are (rewriting would invalidate the signature)']);
  });
});

describe('buildQpdfArgs', () => {
  const base = ['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9'];

  it('adds --optimize-images only to the image pass of a job that allows it', () => {
    const j = job(decide());
    expect(buildQpdfArgs(j, 'images')).toEqual([...base, '--optimize-images', PDF_INPUT, PDF_OUTPUT]);
    expect(buildQpdfArgs(j, 'lossless')).toEqual([...base, PDF_INPUT, PDF_OUTPUT]);
    expect(buildQpdfArgs({ ...j, images: false }, 'images')).toEqual([...base, PDF_INPUT, PDF_OUTPUT]);
    // Existing JPEGs must not be re-encoded: no --jpeg-quality, ever.
    expect(buildQpdfArgs(j, 'images').some((a) => a.startsWith('--jpeg-quality'))).toBe(false);
  });

  it('preserves object streams for PDF/A-1 and linearizes linearized originals', () => {
    const j = job(decide({ pdfA1: true, linearized: true }));
    expect(buildQpdfArgs(j, 'images')).toEqual([
      '--object-streams=preserve',
      '--compress-streams=y',
      '--recompress-flate',
      '--compression-level=9',
      '--optimize-images',
      '--linearize',
      PDF_INPUT,
      PDF_OUTPUT,
    ]);
    expect(buildQpdfArgs(j, 'lossless').slice(-3)).toEqual(['--linearize', PDF_INPUT, PDF_OUTPUT]);
  });

  it('inspects with qpdf JSON v2 limited to the keys the policy reads', () => {
    expect(PDF_INSPECT_ARGS).toEqual(['--json=2', '--json-key=encrypt', '--json-key=acroform', '--json-key=pages', '/in.pdf']);
    expect([PDF_INPUT, PDF_OUTPUT]).toEqual(['/in.pdf', '/out.pdf']);
  });
});

describe('isPdfA1', () => {
  const xmp = (s: string): Uint8Array => enc.encode(`%PDF-1.4\n1 0 obj\n<< /Type /Metadata >>\nstream\n${s}\nendstream\n`);

  it.each([
    ['an attribute', '<rdf:Description pdfaid:part="1" pdfaid:conformance="B"/>'],
    ['an attribute in single quotes with spaces', "<rdf:Description pdfaid:part = ' 1 '/>"],
    ['an element', '<pdfaid:part>1</pdfaid:part><pdfaid:conformance>A</pdfaid:conformance>'],
    ['an element with spaces', '<pdfaid:part> 1 </pdfaid:part>'],
    ['a later declaration after a non-matching one', 'pdfaid:partial pdfaid:part="1"'],
  ])('finds PDF/A-1 declared in %s', (_name, text) => {
    expect(isPdfA1(xmp(text))).toBe(true);
  });

  it.each([
    ['PDF/A-2', '<rdf:Description pdfaid:part="2"/>'],
    ['PDF/A-3 as an element', '<pdfaid:part>3</pdfaid:part>'],
    ['part 10', 'pdfaid:part="10"'],
    ['an element starting with 1', '<pdfaid:part>12</pdfaid:part>'],
    ['a namespace declaration only', 'xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"'],
    ['a truncated key', 'pdfaid:par'],
    ['no metadata at all', ''],
  ])('does not take %s for PDF/A-1', (_name, text) => {
    expect(isPdfA1(xmp(text))).toBe(false);
  });

  it('handles keys at the very end of the bytes and empty input', () => {
    expect(isPdfA1(enc.encode('pdfaid:part'))).toBe(false);
    expect(isPdfA1(enc.encode('xx pdfaid:part="1"'))).toBe(true);
    expect(isPdfA1(enc.encode('pdfaid:part>1<'))).toBe(true);
    expect(isPdfA1(new Uint8Array(0))).toBe(false);
    // Only the 16 bytes after the key are read.
    expect(isPdfA1(enc.encode(`pdfaid:part=${' '.repeat(16)}"1"`))).toBe(false);
  });
});

describe('parsePdfInspection', () => {
  it('reads pages, encryption and signature fields, and takes PDF/A-1 and linearization from elsewhere', () => {
    const json = JSON.stringify({
      version: 2,
      pages: [{}, {}],
      encrypt: { encrypted: true },
      acroform: { fields: [{ fieldtype: '/Tx' }, { fieldtype: '/Sig' }] },
    });
    expect(parsePdfInspection(json, enc.encode('pdfaid:part="1"'), true)).toEqual({ pages: 2, encrypted: true, signed: true, pdfA1: true, linearized: true });
  });

  it('treats missing or malformed sections as absent', () => {
    const none = { pages: 1, encrypted: false, signed: false, pdfA1: false, linearized: false };
    expect(parsePdfInspection(pagesJson(1), new Uint8Array(0), false)).toEqual(none);
    expect(parsePdfInspection(pagesJson(1, { encrypt: { encrypted: 'yes' }, acroform: { fields: 'none' } }), new Uint8Array(0), false)).toEqual(none);
    expect(parsePdfInspection(pagesJson(1, { acroform: {} }), new Uint8Array(0), false)).toEqual(none);
    expect(parsePdfInspection(pagesJson(1, { acroform: { fields: [{ fieldtype: '/Btn' }, {}] } }), new Uint8Array(0), false).signed).toBe(false);
    expect(parsePdfInspection(pagesJson(0), new Uint8Array(0), false).pages).toBe(0);
  });

  it('rejects output that is not qpdf JSON with a page list', () => {
    expect(() => parsePdfInspection('qpdf: /in.pdf: not a PDF', new Uint8Array(0), false)).toThrow('qpdf did not produce readable JSON');
    expect(() => parsePdfInspection('', new Uint8Array(0), false)).toThrow('qpdf did not produce readable JSON');
    expect(() => parsePdfInspection('{"version":2}', new Uint8Array(0), false)).toThrow('qpdf JSON has no page list');
    expect(() => parsePdfInspection('{"pages":{}}', new Uint8Array(0), false)).toThrow('qpdf JSON has no page list');
  });
});

describe('validatePdfCandidate', () => {
  const j = job(decide({ linearized: true }));

  it('accepts a candidate with the same pages, unencrypted and linearized as planned', () => {
    expect(validatePdfCandidate(j, { ...plain, linearized: true })).toEqual([]);
    // Linearization is only required when the original had it.
    expect(validatePdfCandidate(job(decide()), plain)).toEqual([]);
  });

  it('lists every problem', () => {
    expect(validatePdfCandidate(j, { ...plain, pages: 2, encrypted: true })).toEqual([
      '2 pages instead of 3',
      'the new file is encrypted',
      'the new file is not linearized',
    ]);
  });
});

describe('inspectPdf', () => {
  const bytes = enc.encode('%PDF-1.4 pdfaid:part="1"');

  it('reads the JSON, then the linearization, of the same input', async () => {
    const r = runner([ok(pagesJson(4)), ok('/in.pdf: no linearization errors\n')]);
    expect(await inspectPdf(r, bytes, ctx)).toEqual({ pages: 4, encrypted: false, signed: false, pdfA1: true, linearized: true });
    expect(r.runs.map((x) => x.args)).toEqual([PDF_INSPECT_ARGS, ['--check-linearization', '/in.pdf']]);
    expect(r.runs.every((x) => x.input === bytes && x.ctx === ctx)).toBe(true);
  });

  it('tells regular files from linearized ones (qpdf has no --is-linearized)', async () => {
    const lin = async (answer: QpdfResult): Promise<boolean> => (await inspectPdf(runner([ok(pagesJson(1)), answer]), bytes, ctx)).linearized;
    expect(await lin(ok('/in.pdf is not linearized\n'))).toBe(false);
    // Damaged linearization data (warnings or errors) is not taken for a linearized file.
    expect(await lin({ code: 3, stdout: '/in.pdf: linearization data is inconsistent\n', stderr: 'qpdf: operation succeeded with warnings\n' })).toBe(false);
    expect(await lin({ code: 2, stdout: '', stderr: 'qpdf: unrecognized argument\n' })).toBe(false);
  });

  it('reports why qpdf could not read the file', async () => {
    await expect(inspectPdf(runner([{ code: 2, stdout: '', stderr: "\n  qpdf: /in.pdf: can't find startxref  \nmore\n" }]), bytes, ctx)).rejects.toThrow(
      "qpdf could not read the PDF: qpdf: /in.pdf: can't find startxref",
    );
    // Warnings (exit 3) are not a clean read either; without stderr the exit code is named.
    await expect(inspectPdf(runner([{ code: 3, stdout: '{}', stderr: '' }]), bytes, ctx)).rejects.toThrow('qpdf could not read the PDF: exit 3');
    await expect(inspectPdf(runner([ok('not json'), ok('')]), bytes, ctx)).rejects.toThrow('qpdf did not produce readable JSON');
  });
});

describe('checkPdf', () => {
  it('passes only a clean check', async () => {
    const r = runner([ok('checking /in.pdf\nNo syntax or stream encoding errors found\n')]);
    await expect(checkPdf(r, enc.encode('%PDF'), ctx)).resolves.toBeUndefined();
    expect(r.runs[0]!.args).toEqual(['--check', '/in.pdf']);
  });

  it('tells warnings from failures and names the first message', async () => {
    const check = (answer: QpdfResult): Promise<void> => checkPdf(runner([answer]), new Uint8Array(0), ctx);
    await expect(check({ code: 3, stdout: 'checking /in.pdf\n', stderr: 'WARNING: page object 5 0 stream 4 0: EOF while reading token\n' })).rejects.toThrow(
      'qpdf --check reported warnings: WARNING: page object 5 0 stream 4 0: EOF while reading token',
    );
    await expect(check({ code: 2, stdout: '', stderr: 'qpdf: /in.pdf: not a PDF file\n' })).rejects.toThrow(
      'qpdf --check failed: qpdf: /in.pdf: not a PDF file',
    );
    // Without stderr, the first line of stdout; without either, nothing.
    await expect(check({ code: 2, stdout: '\nchecking /in.pdf\n', stderr: ' \n' })).rejects.toThrow('qpdf --check failed: checking /in.pdf');
    await expect(check({ code: 2, stdout: '', stderr: '' })).rejects.toThrow(/^qpdf --check failed: $/);
  });
});

describe('rewritePdf', () => {
  const j = job(decide());

  it('returns the file qpdf wrote for the pass', async () => {
    const out = enc.encode('%PDF-1.7 smaller');
    const r = runner([ok('', out)]);
    expect(await rewritePdf(r, enc.encode('%PDF'), j, 'images', ctx)).toBe(out);
    expect(r.runs[0]!.args).toEqual(buildQpdfArgs(j, 'images'));
  });

  it('fails on warnings, errors and a missing output', async () => {
    const rewrite = (answer: QpdfResult): Promise<Uint8Array> => rewritePdf(runner([answer]), new Uint8Array(0), j, 'lossless', ctx);
    const out = enc.encode('%PDF');
    await expect(
      rewrite({ code: 3, stdout: '', stderr: 'WARNING: /in.pdf: unknown token\nqpdf: operation succeeded with warnings\n', output: out }),
    ).rejects.toThrow('qpdf reported warnings: WARNING: /in.pdf: unknown token');
    await expect(rewrite({ code: 2, stdout: '', stderr: 'qpdf: /in.pdf: invalid password\n' })).rejects.toThrow('qpdf failed: qpdf: /in.pdf: invalid password');
    await expect(rewrite(ok())).rejects.toThrow('qpdf failed: exit 0');
    await expect(rewrite({ code: 2, stdout: '', stderr: '' })).rejects.toThrow('qpdf failed: exit 2');
    // Long messages are cut at 300 characters.
    const long = await rewrite({ code: 2, stdout: '', stderr: 'x'.repeat(400) }).catch((e: Error) => e.message);
    expect(long).toBe(`qpdf failed: ${'x'.repeat(300)}`);
  });
});
