import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { optionsFromFlags, renderPlan } from '../../../src/cli/commands/optimize.js';
import { progressPrinter } from '../../../src/cli/shared.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { OptimizationPlan, PlanOperation } from '../../../src/core/plan/plan.js';
import type { OptimizationReport } from '../../../src/core/report/report.js';
import { buildElpx } from '../../helpers/core-kit.js';
import { craftPdf } from '../../helpers/pdf-craft.js';
import { captureIO, fileSha256, removeDir, runCli, singleJson, tempDir } from '../../helpers/cli.js';
import { configureLocalTools } from '../../helpers/native.js';

/** CLI support for PDFs: --no-pdf, --pdf-lossless, the plan and progress lines, and real runs with qpdf (WebAssembly). */

const R = '{{context_path}}/content/resources';
const GUIA = 'content/resources/guia.pdf';
let dir: string;
let input: string;

beforeAll(async () => {
  configureLocalTools();
  dir = await tempDir('elpx-pdf-cli-');
  input = join(dir, 'curso.elpx');
  await writeFile(
    input,
    buildElpx({
      components: [{ html: `<a href="${R}/guia.pdf">Guía</a><a href="${R}/firmado.pdf">Firmado</a>` }],
      files: { [GUIA]: craftPdf({ pages: 3, image: { width: 300, height: 200 } }), 'content/resources/firmado.pdf': craftPdf({ signatureField: true }) },
    }),
  );
});
afterAll(async () => {
  await removeDir(dir);
});

interface DryRun {
  plan: OptimizationPlan;
}

/** Dry-run JSON of the test package with extra flags. */
async function dryRun(args: string[] = []): Promise<OptimizationPlan> {
  const r = await runCli(['optimize', input, '--dry-run', '--json', '--quiet', ...args], { cwd: dir });
  expect(r.stderr).toBe('');
  expect(r.code).toBe(EXIT.SUCCESS);
  return singleJson<DryRun>(r.stdout).plan;
}

/** The PDF operations of a plan. */
function pdfOps(plan: OptimizationPlan): Extract<PlanOperation, { op: 'optimize-pdf' }>[] {
  return plan.operations.filter((o): o is Extract<PlanOperation, { op: 'optimize-pdf' }> => o.op === 'optimize-pdf');
}

describe('optimize: PDF flags', () => {
  it('maps the flags onto options.pdf, over --config', async () => {
    const io = captureIO({ cwd: dir }).io;
    expect(await optionsFromFlags({ 'no-pdf': true }, io)).toEqual({ pdf: { enabled: false } });
    expect(await optionsFromFlags({ 'pdf-lossless': true }, io)).toEqual({ pdf: { images: false } });
    await writeFile(join(dir, 'pdf.json'), JSON.stringify({ pdf: { images: true }, preset: 'aggressive' }));
    expect(await optionsFromFlags({ config: 'pdf.json', 'pdf-lossless': true, 'no-pdf': true }, io)).toEqual({
      preset: 'aggressive',
      pdf: { images: false, enabled: false },
    });
    // No PDF flag: no PDF options at all.
    expect(await optionsFromFlags({ 'no-audio': true }, io)).toEqual({ audio: { enabled: false } });
  });

  it('documents the PDF options', async () => {
    const { stdout } = await runCli(['optimize', '--help']);
    expect(stdout).toContain('--no-pdf                   Do not touch PDF files\n');
    expect(stdout).toContain('--pdf-lossless             Rewrite PDFs without converting their images to JPEG\n');
    expect(stdout).toContain('(the conservative preset already does this)\n');
  });

  it('plans PDF rewrites in dry runs: lossy by default, lossless or none on request', async () => {
    const plan = await dryRun();
    expect(plan.options.pdf).toEqual({ enabled: true, preset: 'balanced', images: true, minSavingsPercent: 5, minSavingsBytes: 1024 });
    expect(pdfOps(plan).map((o) => [o.path, o.lossy, o.job.expected.pages])).toEqual([[GUIA, true, 3]]);
    expect(plan.skipped.filter((s) => s.kind === 'pdf').map((s) => [s.path, s.reason])).toEqual([['content/resources/firmado.pdf', 'signed']]);
    expect(plan.engine.versions['qpdf']).toMatch(/^\d+\.\d+\.\d+ \(WebAssembly\)$/);
    const lossless = await dryRun(['--pdf-lossless']);
    expect(pdfOps(lossless).map((o) => [o.path, o.lossy])).toEqual([[GUIA, false]]);
    const off = await dryRun(['--no-pdf']);
    expect(pdfOps(off)).toEqual([]);
    expect(off.skipped.filter((s) => s.kind === 'pdf').map((s) => s.reason)).toEqual(['pdf-disabled', 'pdf-disabled']);
    // The text plan names the operation and the risk.
    const text = await runCli(['optimize', input, '--dry-run', '--quiet'], { cwd: dir });
    expect(text.stdout).toMatch(
      /\n {2}• optimize-pdf content\/resources\/guia\.pdf \([\d.]+ KiB\) \[lossy\]: PDF streams recompressed and packed into object streams \(lossless\); images that are not JPEG converted to JPEG where that makes them smaller \(lossy\)\n/,
    );
    expect(text.stdout).toContain('Note: Images inside PDFs may be converted to JPEG (lossy); text, fonts, links and forms are not re-rendered.\n');
  });

  it('shows the facts of each PDF in inspect', async () => {
    const r = await runCli(['inspect', input, '--json'], { cwd: dir });
    const entries = singleJson<{ entries: { path: string; pdf?: unknown }[] }>(r.stdout).entries;
    expect(entries.filter((e) => e.pdf).map((e) => [e.path, e.pdf])).toEqual([
      [GUIA, { pages: 3, encrypted: false, signed: false, pdfA1: false, linearized: false }],
      ['content/resources/firmado.pdf', { pages: 1, encrypted: false, signed: true, pdfA1: false, linearized: false }],
    ]);
  });

  it('rewrites the PDF with qpdf and reports its progress', async () => {
    const before = await fileSha256(input);
    const output = join(dir, 'out.elpx');
    const err: string[] = [];
    // Progress goes to stderr when JSON is printed to a terminal.
    const r = await runCli(['optimize', input, '-o', output, '--json'], { cwd: dir, interactive: true, onStderr: (t) => err.push(t) });
    expect(r.code).toBe(EXIT.SUCCESS);
    const report = singleJson<OptimizationReport>(r.stdout);
    expect(report.status).toBe('optimized');
    const op = report.operations.find((o) => o.op === 'optimize-pdf')!;
    expect(op).toMatchObject({ path: GUIA, status: 'applied', lossy: true, checks: ['qpdf --check without warnings', '3 pages, as in the original'] });
    expect(op.after!).toBeLessThan(op.before!);
    expect(err.join('')).toContain(`PDF [1/1] ${GUIA}\n`);
    expect(await fileSha256(input)).toBe(before);
    expect((await readFile(output)).length).toBeLessThan((await readFile(input)).length);
  });
});

describe('renderPlan: PDF operations', () => {
  it('marks lossy rewrites', () => {
    const plan = {
      input: { name: 'p.elpx', size: 10 },
      options: { preset: 'balanced' },
      engine: { engine: 'native' },
      operations: [
        { op: 'optimize-pdf', path: 'content/resources/a.pdf', size: 4096, lossy: true, conversions: ['streams recompressed', 'images to JPEG'] },
        { op: 'optimize-pdf', path: 'content/resources/b.pdf', size: 1024, lossy: false, conversions: ['streams recompressed'] },
      ] as unknown as PlanOperation[],
      skipped: [],
      estimate: { savedBytes: 0 },
      risks: [],
    } as unknown as OptimizationPlan;
    expect(renderPlan(plan)).toBe(
      [
        'Plan for p.elpx (10 B), preset balanced, engine native',
        '  • optimize-pdf content/resources/a.pdf (4.0 KiB) [lossy]: streams recompressed; images to JPEG',
        '  • optimize-pdf content/resources/b.pdf (1.0 KiB): streams recompressed',
        'Estimated saving (estimate, not measured): 0 B',
        '',
      ].join('\n'),
    );
  });
});

describe('progressPrinter: PDFs', () => {
  it('numbers PDFs and names the file', () => {
    const { io, err } = captureIO();
    const print = progressPrinter(io, false);
    print({ stage: 'pdf', resource: GUIA, item: 1, items: 2, message: 'qpdf, images pass' });
    // The second pass of the same file prints nothing new.
    print({ stage: 'pdf', resource: GUIA, item: 1, items: 2, message: 'qpdf, lossless pass' });
    print({ stage: 'package' });
    print({ stage: 'pdf' });
    expect(err).toEqual([`PDF [1/2] ${GUIA}\n`, 'Packaging\n', 'PDF \n']);
  });
});
