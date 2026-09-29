import type { Limits } from '../limits.js';
import type { JobContext, QpdfResult } from './engine.js';
import type { Preset } from './video-policy.js';

/**
 * PDF policy shared by both engines, which run the same qpdf compiled to
 * WebAssembly (in a worker in the browser, in a child process in the CLI).
 * qpdf rewrites the file without re-rendering it: text, fonts, links,
 * bookmarks, forms and tags are kept. The lossless pass generates object
 * streams and recompresses Flate streams at the highest level; the image
 * pass also lets qpdf convert images that are not JPEG yet into JPEG when
 * that makes each image smaller (existing JPEGs are never re-encoded).
 * Encrypted and signed PDFs are never rewritten (a signature would break),
 * and PDF/A-1 files keep their structure (object streams are not allowed).
 */

export interface PdfProfile {
  /** Also convert images to JPEG (lossy). */
  readonly images: boolean;
}

export const PDF_PROFILES: Readonly<Record<Preset, PdfProfile>> = Object.freeze({
  conservative: { images: false },
  balanced: { images: true },
  aggressive: { images: true },
});

export interface PdfOptions {
  readonly enabled: boolean;
  readonly preset: Preset;
  readonly images: boolean;
  readonly minSavingsPercent: number;
  readonly minSavingsBytes: number;
}

/** What an engine reports about its PDF support. */
export interface PdfCapabilities {
  readonly available: boolean;
  readonly reason?: string;
  /** e.g. "qpdf 12.2.0 (WebAssembly)". */
  readonly engine?: string;
}

/** Facts about a PDF, from qpdf's JSON and a scan of its bytes. */
export interface PdfInfo {
  readonly pages: number;
  readonly encrypted: boolean;
  /** Has a signature field (rewriting would invalidate it). */
  readonly signed: boolean;
  /** Declares PDF/A-1 conformance (no object streams allowed). */
  readonly pdfA1: boolean;
  readonly linearized: boolean;
}

export type PdfSkipReason = 'pdf-disabled' | 'engine-unavailable' | 'not-inspected' | 'encrypted' | 'signed' | 'exceeds-size-limit';

/** A decided PDF job. */
export interface PdfJob {
  /** Try the image pass first (then the lossless pass if it does not pay off). */
  readonly images: boolean;
  readonly objectStreams: 'generate' | 'preserve';
  readonly linearize: boolean;
  readonly expected: { readonly pages: number };
  readonly conversions: readonly string[];
}

export type PdfDecision =
  { readonly action: 'optimize'; readonly job: PdfJob } | { readonly action: 'skip'; readonly reason: PdfSkipReason; readonly detail: string };

/** Paths used inside qpdf's virtual file system. */
export const PDF_INPUT = '/in.pdf';
export const PDF_OUTPUT = '/out.pdf';

/** qpdf arguments that print the JSON inspect reads (to stdout). */
export const PDF_INSPECT_ARGS: readonly string[] = ['--json=2', '--json-key=encrypt', '--json-key=acroform', '--json-key=pages', PDF_INPUT];

/** Decides whether and how a PDF is rewritten. */
export function decidePdf(input: { readonly size: number; readonly info?: PdfInfo }, options: PdfOptions, caps: PdfCapabilities, limits: Limits): PdfDecision {
  const skip = (reason: PdfSkipReason, detail: string): PdfDecision => ({ action: 'skip', reason, detail });
  if (!options.enabled) return skip('pdf-disabled', 'PDF optimization is disabled');
  if (!caps.available) return skip('engine-unavailable', caps.reason ?? 'No PDF engine');
  if (input.size > limits.maxPdfBytes) return skip('exceeds-size-limit', `File is larger than ${limits.maxPdfBytes} bytes`);
  const info = input.info;
  if (!info) return skip('not-inspected', 'The PDF could not be inspected');
  if (info.encrypted) return skip('encrypted', 'Encrypted PDFs are kept as they are');
  if (info.signed) return skip('signed', 'Signed PDFs are kept as they are (rewriting would invalidate the signature)');
  const conversions = ['PDF streams recompressed and packed into object streams (lossless)'];
  if (options.images) conversions.push('images that are not JPEG converted to JPEG where that makes them smaller (lossy)');
  if (info.pdfA1) conversions.push('PDF/A-1 structure preserved (no object streams)');
  return {
    action: 'optimize',
    job: {
      images: options.images,
      objectStreams: info.pdfA1 ? 'preserve' : 'generate',
      linearize: info.linearized,
      expected: { pages: info.pages },
      conversions,
    },
  };
}

/** qpdf arguments for one pass of a job ('images' only when the job allows it). */
export function buildQpdfArgs(job: PdfJob, pass: 'images' | 'lossless'): string[] {
  const args = [`--object-streams=${job.objectStreams}`, '--compress-streams=y', '--recompress-flate', '--compression-level=9'];
  // --jpeg-quality is deliberately not used: with it, qpdf also re-encodes images that are already JPEG.
  if (pass === 'images' && job.images) args.push('--optimize-images');
  if (job.linearize) args.push('--linearize');
  args.push(PDF_INPUT, PDF_OUTPUT);
  return args;
}

/** Declares PDF/A-1 in its XMP metadata (uncompressed in PDF/A-1 files). */
export function isPdfA1(bytes: Uint8Array): boolean {
  const key = [...'pdfaid:part'].map((c) => c.charCodeAt(0));
  for (let i = bytes.indexOf(key[0]!); i >= 0 && i <= bytes.length - key.length; i = bytes.indexOf(key[0]!, i + 1)) {
    if (!key.every((k, j) => bytes[i + j] === k)) continue;
    let tail = '';
    for (let j = i + key.length; j < Math.min(bytes.length, i + key.length + 16); j++) tail += String.fromCharCode(bytes[j]!);
    if (/^\s*(?:=\s*["']\s*1\s*["']|>\s*1\s*<)/.test(tail)) return true;
  }
  return false;
}

/** Reads the facts qpdf's JSON gives (see PDF_INSPECT_ARGS). */
export function parsePdfInspection(json: string, bytes: Uint8Array, linearized: boolean): PdfInfo {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('qpdf did not produce readable JSON');
  }
  const d = doc as { pages?: unknown; encrypt?: { encrypted?: unknown }; acroform?: { fields?: unknown } };
  if (!Array.isArray(d.pages)) throw new Error('qpdf JSON has no page list');
  const fields = Array.isArray(d.acroform?.fields) ? (d.acroform.fields as { fieldtype?: unknown }[]) : [];
  return {
    pages: d.pages.length,
    encrypted: d.encrypt?.encrypted === true,
    signed: fields.some((f) => f.fieldtype === '/Sig'),
    pdfA1: isPdfA1(bytes),
    linearized,
  };
}

/** Checks a candidate's facts against the job; returns problems. */
export function validatePdfCandidate(job: PdfJob, candidate: PdfInfo): string[] {
  const problems: string[] = [];
  if (candidate.pages !== job.expected.pages) problems.push(`${candidate.pages} pages instead of ${job.expected.pages}`);
  if (candidate.encrypted) problems.push('the new file is encrypted');
  if (job.linearize && !candidate.linearized) problems.push('the new file is not linearized');
  return problems;
}

/** The subset of an engine used for PDFs. */
export interface QpdfRunner {
  runQpdf(args: readonly string[], input: Uint8Array, ctx: JobContext): Promise<QpdfResult>;
}

/** Inspects a PDF: pages, encryption, signatures, PDF/A-1 and linearization. */
export async function inspectPdf(engine: QpdfRunner, bytes: Uint8Array, ctx: JobContext): Promise<PdfInfo> {
  const json = await engine.runQpdf(PDF_INSPECT_ARGS, bytes, ctx);
  if (json.code !== 0) throw new Error(`qpdf could not read the PDF: ${firstLine(json.stderr) || `exit ${json.code}`}`);
  // qpdf has no --is-linearized: --check-linearization exits 0 for both and says "… is not linearized" for a regular file.
  const lin = await engine.runQpdf(['--check-linearization', PDF_INPUT], bytes, ctx);
  const linearized = lin.code === 0 && !lin.stdout.includes('is not linearized');
  return parsePdfInspection(json.stdout, bytes, linearized);
}

/** Runs qpdf --check: only a clean result (exit 0, no warnings) passes. */
export async function checkPdf(engine: QpdfRunner, bytes: Uint8Array, ctx: JobContext): Promise<void> {
  const r = await engine.runQpdf(['--check', PDF_INPUT], bytes, ctx);
  if (r.code !== 0) throw new Error(`qpdf --check ${r.code === 3 ? 'reported warnings' : 'failed'}: ${firstLine(r.stderr) || firstLine(r.stdout)}`);
}

/** Rewrites a PDF with one pass of a job; qpdf warnings (exit 3) count as failure. */
export async function rewritePdf(engine: QpdfRunner, bytes: Uint8Array, job: PdfJob, pass: 'images' | 'lossless', ctx: JobContext): Promise<Uint8Array> {
  const r = await engine.runQpdf(buildQpdfArgs(job, pass), bytes, ctx);
  if (r.code !== 0 || !r.output) {
    throw new Error(`qpdf ${r.code === 3 ? 'reported warnings' : 'failed'}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  }
  return r.output;
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300);
}
