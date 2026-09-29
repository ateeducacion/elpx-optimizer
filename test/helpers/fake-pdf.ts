/**
 * Scriptable qpdf for the core tests. A fake PDF carries its facts (pages,
 * encryption, signature, PDF/A-1, linearization) in its first comment line,
 * and PdfEngine answers the inspection, check and rewrite runs of the shared
 * PDF policy from them, like qpdf would. Real PDFs (test/helpers/pdf-craft.ts)
 * and the real qpdf are exercised by the native tests.
 */
import type { JobContext, QpdfResult } from '../../src/core/media/engine.js';
import type { PdfCapabilities } from '../../src/core/media/pdf-policy.js';
import { FakeEngine, MemoryStore, engineInfo } from './fake-platform.js';

/** What a fake PDF says about itself. */
export interface FakePdfFacts {
  readonly pages: number;
  readonly encrypted?: boolean;
  readonly signed?: boolean;
  readonly pdfA1?: boolean;
  readonly linearized?: boolean;
}

/** PDF capabilities of an engine running qpdf. */
export const PDF_CAPS: PdfCapabilities = { available: true, engine: 'qpdf 12.2.0 (WebAssembly)' };

const MARK = '%PDF-1.7\n%facts ';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes that sniff as PDF, carry `facts` (and PDF/A-1 XMP when declared) and are padded to `size`. */
export function fakePdf(size: number, facts: FakePdfFacts = { pages: 1 }, fill = 0x20): Uint8Array {
  const head = enc.encode(`${MARK}${JSON.stringify(facts)}\n${facts.pdfA1 ? '<rdf:Description pdfaid:part="1"/>\n' : ''}`);
  const out = new Uint8Array(Math.max(size, head.length)).fill(fill);
  out.set(head, 0);
  return out;
}

/** The facts of a fake PDF (undefined for anything else, which the fake qpdf cannot read). */
export function fakePdfFacts(bytes: Uint8Array): FakePdfFacts | undefined {
  const text = dec.decode(bytes.subarray(0, 256));
  if (!text.startsWith(MARK)) return undefined;
  return JSON.parse(text.slice(MARK.length, text.indexOf('\n', MARK.length))) as FakePdfFacts;
}

export type QpdfPass = 'images' | 'lossless';

/** Answer of a rewrite pass: the new file (exit 0) or a whole qpdf result. */
export type FakeRewrite = (pass: QpdfPass, input: Uint8Array, facts: FakePdfFacts) => Uint8Array | QpdfResult;

/** Default rewrite: same facts, 40% of the size for the image pass and 80% for the lossless pass. */
export const shrink: FakeRewrite = (pass, input, facts) => fakePdf(Math.round(input.length * (pass === 'images' ? 0.4 : 0.8)), facts);

/** qpdf's answer to the runs the PDF policy makes (inspection, linearization, check, rewrite). */
export function fakeQpdf(args: readonly string[], input: Uint8Array, rewrite: FakeRewrite = shrink): QpdfResult {
  const facts = fakePdfFacts(input);
  if (!facts) return { code: 2, stdout: '', stderr: "qpdf: /in.pdf: can't find startxref\n" };
  switch (args[0]) {
    case '--json=2':
      return {
        code: 0,
        stdout: JSON.stringify({
          version: 2,
          pages: Array.from({ length: facts.pages }, (_, i) => ({ object: `${i + 4} 0 R` })),
          encrypt: { encrypted: facts.encrypted === true },
          acroform: { fields: facts.signed ? [{ fieldtype: '/Sig' }] : [] },
        }),
        stderr: '',
      };
    case '--check-linearization':
      return { code: 0, stdout: facts.linearized ? '/in.pdf: no linearization errors\n' : '/in.pdf is not linearized\n', stderr: '' };
    case '--check':
      return { code: 0, stdout: 'checking /in.pdf\nNo syntax or stream encoding errors found\n', stderr: '' };
    default: {
      const r = rewrite(args.includes('--optimize-images') ? 'images' : 'lossless', input, facts);
      return r instanceof Uint8Array ? { code: 0, stdout: '', stderr: '', output: r } : r;
    }
  }
}

/** A fake engine that runs the fake qpdf; `rewrite` or the whole `qpdf` run can be replaced per test. */
export class PdfEngine extends FakeEngine {
  /** Arguments of every qpdf run, in order. */
  readonly qpdfRuns: string[][] = [];
  rewrite: FakeRewrite = shrink;
  qpdf?: (args: readonly string[], input: Uint8Array, ctx: JobContext) => Promise<QpdfResult>;

  constructor(store = new MemoryStore()) {
    super(store);
    this.infoValue = engineInfo({ pdf: PDF_CAPS });
  }

  runQpdf(args: readonly string[], input: Uint8Array, ctx: JobContext): Promise<QpdfResult> {
    this.qpdfRuns.push([...args]);
    return this.qpdf ? this.qpdf(args, input, ctx) : Promise.resolve(fakeQpdf(args, input, this.rewrite));
  }
}

/** The command of each qpdf run (the pass of a rewrite), for asserting sequences. */
export function qpdfCommands(engine: PdfEngine): string[] {
  return engine.qpdfRuns.map((a) => (a[0]!.startsWith('--object-streams') ? (a.includes('--optimize-images') ? 'rewrite:images' : 'rewrite:lossless') : a[0]!));
}
