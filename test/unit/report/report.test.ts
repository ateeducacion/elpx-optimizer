import { describe, expect, it } from 'vitest';
import { buildReport, formatBytes, renderReportText, type OperationResult, type OptimizationReport } from '../../../src/core/report/report.js';
import { summarizeValidation, validateArchive } from '../../../src/core/validate/validate.js';
import { buildOptimizationPlan } from '../../../src/core/plan/plan.js';
import { normalizeOptions } from '../../../src/core/plan/options.js';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { diagnostic } from '../../../src/core/diagnostics.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import { analyzeBytes, buildElpx, elpxFixture, enc, limits, media, upstream } from '../../helpers/core-kit.js';
import { engineInfo } from '../../helpers/fake-platform.js';

const R = '{{context_path}}/content/resources';

/** An analysis with a given list of extra diagnostics. */
function withDiagnostics(a: Analysis, extra: ReturnType<typeof diagnostic>[]): Analysis {
  return { ...a, result: { ...a.result, diagnostics: [...a.result.diagnostics, ...extra] } };
}

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1536, '1.5 KiB'],
    [5 * 1024 * 1024, '5.0 MiB'],
    [3 * 1024 ** 3, '3.0 GiB'],
    [2 * 1024 ** 5, '2048.0 TiB'],
    [-2048, '-2.0 KiB'],
  ])('%d → %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});

describe('buildReport', () => {
  it('compares diagnostics before and after and measures savings', async () => {
    const before = await analyzeBytes(buildElpx({ components: [{ html: `<img src="${R}/nada.png">` }] }));
    const after = withDiagnostics(await analyzeBytes(buildElpx({ components: [] })), [
      diagnostic('lenient-resolution', 'new one'),
      diagnostic('external-reference', 'info only'),
    ]);
    const plan = buildOptimizationPlan(before, normalizeOptions(), engineInfo(), limits());
    const results: OperationResult[] = [{ id: 'a', op: 'recompress-image', path: 'p', status: 'applied', before: 10, after: 5 }];
    const report = buildReport({
      status: 'optimized',
      plan,
      engineInfo: engineInfo(),
      analysis: before,
      results,
      validations: [],
      output: { name: 'o.elpx', size: before.result.input.size - 100, sha256: 'ab' },
      after,
    });
    expect(report).toMatchObject({
      schema: 'elpx-optimizer/report',
      schemaVersion: 1,
      status: 'optimized',
      engine: { engine: 'native', versions: { fake: '1.0' } },
      options: plan.options,
      planHash: plan.planHash,
    });
    expect(report.sizes).toEqual({
      before: before.result.input.size,
      after: before.result.input.size - 100,
      saved: 100,
      savedPercent: Math.round((100 / before.result.input.size) * 10000) / 100,
    });
    expect(report.diagnostics.introduced.map((d) => d.code)).toEqual(['lenient-resolution']);
    expect(report.diagnostics.resolved.map((d) => d.code)).toEqual(['missing-resource']);
    expect(report.diagnostics.before.counts).toEqual({ fatal: 0, error: 1, warning: 0, info: 0 });
    expect(report.operations).toBe(results);
  });

  it('describes runs without a plan, an engine or an output', async () => {
    const bad = await analyzeBytes(new Uint8Array(0));
    const report = buildReport({ status: 'invalid-input', plan: undefined, engineInfo: undefined, analysis: bad, results: [], validations: [], error: 'boom' });
    expect(report).toMatchObject({
      status: 'invalid-input',
      error: 'boom',
      engine: { engine: 'none', versions: {} },
      options: undefined,
      planHash: undefined,
      skipped: [],
      risks: [],
    });
    expect(report.sizes).toEqual({ before: 0, after: 0, saved: 0, savedPercent: 0 });
    expect(report.output).toBeUndefined();
    const notOk = buildReport({ status: 'failed', plan: undefined, engineInfo: undefined, analysis: bad, results: [], validations: [], after: bad });
    expect(notOk.diagnostics.introduced).toEqual([]);
  });

  it('marks applied operations as not delivered when there was no net improvement', async () => {
    const a = await analyzeBytes(buildElpx({ components: [] }));
    const report = buildReport({
      status: 'no-improvement',
      plan: undefined,
      engineInfo: undefined,
      analysis: a,
      results: [
        { id: '1', op: 'x', path: 'a', status: 'applied', detail: 'saved 3 bytes' },
        { id: '2', op: 'x', path: 'b', status: 'applied' },
        { id: '3', op: 'x', path: 'c', status: 'failed', detail: 'no' },
      ],
      validations: [],
    });
    expect(report.operations.map((o) => [o.status, o.detail])).toEqual([
      ['reverted', 'saved 3 bytes; not delivered: no net size reduction'],
      ['reverted', 'not delivered: no net size reduction'],
      ['failed', 'no'],
    ]);
  });
});

describe('renderReportText', () => {
  it('summarizes long lists unless verbose, and always lists failures', async () => {
    const a = await analyzeBytes(buildElpx({ components: [{ html: `<img src="${R}/nada.png">` }] }));
    const op = (i: number, status: OperationResult['status']): OperationResult => ({
      id: `o${i}`,
      op: 'recompress-image',
      path: `content/resources/i${i}.png`,
      status,
      before: 2048,
      after: 1024,
    });
    const ops = [...Array.from({ length: 5 }, (_, i) => op(i, 'applied')), ...Array.from({ length: 4 }, (_, i) => op(i + 10, 'failed'))];
    const rewrites = Array.from({ length: 4 }, (_, i): OperationResult => ({ id: `w${i}`, op: 'rewrite-references', path: `p${i}.html`, status: 'applied' }));
    const plan = {
      skipped: Array.from({ length: 5 }, (_, i) => ({ path: `s${i}.png`, reason: 'already-efficient', detail: 'fine' })),
      risks: [],
    } as unknown as OptimizationPlan;
    const report = buildReport({ status: 'partial', plan, engineInfo: undefined, analysis: a, results: [...ops, ...rewrites], validations: [] });
    const short = renderReportText(report);
    // Without sizes, a kind is only counted; skipped resources are grouped by reason.
    expect(short).toContain('  - 4 × rewrite-references\n');
    expect(short).toContain('Left unchanged (5):\n  - 5 × already-efficient\n');
    expect(short).toContain('Applied (9):\n  - 5 × recompress-image 10.0 KiB → 5.0 KiB\n');
    // Failures are never folded away.
    expect(short).toContain('content/resources/i13.png');
    expect(short).toContain('add --verbose to list every file');
    const full = renderReportText(report, true);
    expect(full).toContain('  - recompress-image content/resources/i0.png 2.0 KiB → 1.0 KiB');
    expect(full).not.toContain('--verbose');
  });

  it('renders every section, truncating long lists', async () => {
    const a = await analyzeBytes(buildElpx({ components: [{ html: `<img src="${R}/nada.png">` }] }));
    const ops: OperationResult[] = [
      ...Array.from({ length: 52 }, (_, i): OperationResult => ({
        id: `i${i}`,
        op: 'recompress-image',
        path: `content/resources/${i}.jpg`,
        status: 'applied',
        before: 2048,
        after: 1024,
        lossy: true,
        detail: i === 0 ? 'quality 82' : undefined,
      })),
      { id: 'v', op: 'transcode-video', path: 'v.mp4', status: 'reverted', before: 10 },
      { id: 'f', op: 'transcode-video', path: 'w.mp4', status: 'failed', detail: 'encoder crashed' },
    ];
    const base = buildReport({
      status: 'partial',
      plan: undefined,
      engineInfo: undefined,
      analysis: a,
      results: ops,
      validations: [
        { name: 'zip-written', ok: true },
        { name: 'entry-set', ok: false, detail: '3 entries' },
        { name: 'x', ok: false },
      ],
      output: { name: 'out.elpx', size: 1024, sha256: 'f'.repeat(64) },
      error: 'partial failure',
    });
    const report: OptimizationReport = {
      ...base,
      skipped: Array.from({ length: 33 }, (_, i) => ({ path: `s${i}.png`, kind: 'image' as const, reason: 'already-efficient', detail: 'fine' })),
      risks: ['Some media will be downscaled.'],
      diagnostics: { ...base.diagnostics, introduced: [diagnostic('missing-resource', 'x')] },
    };
    const text = renderReportText(report, true);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Optimized with some operations failed (originals kept for those)');
    expect(lines[1]).toBe('  partial failure');
    expect(text).toContain(`Input:  test.elpx (${formatBytes(a.result.input.size)}, sha256 ${a.result.input.sha256.slice(0, 12)}…)`);
    expect(text).toContain('Output: out.elpx (1.0 KiB, sha256 ffffffffffff…)');
    expect(text).toContain('Saved:  ');
    expect(text).toContain('Applied (52):\n  - recompress-image content/resources/0.jpg 2.0 KiB → 1.0 KiB [lossy] — quality 82\n');
    expect(text).toContain('  … 2 more\n');
    expect(text).toContain('Reverted (1):\n  - transcode-video v.mp4\n');
    expect(text).toContain('Failed (1):\n  - transcode-video w.mp4 — encoder crashed\n');
    expect(text).toContain('Left unchanged (33):\n  - s0.png: already-efficient (fine)');
    expect(text).toContain('  … 3 more\n');
    expect(text).toContain('Diagnostics in the input: 0 fatal, 1 errors, 0 warnings, 0 info\nNew diagnostics: 1\n');
    expect(text).toContain('Validations: 1/3 passed\n  ✗ entry-set: 3 entries\n  ✗ x: \n');
    expect(text.endsWith('Note: Some media will be downscaled.\n')).toBe(true);
  });

  it('renders a minimal report for each status', async () => {
    const a = await analyzeBytes(buildElpx({ components: [] }));
    for (const [status, first] of [
      ['optimized', 'Optimized'],
      ['no-improvement', 'No improvement: the original was kept (byte-for-byte copy delivered)'],
      ['failed', 'Failed: nothing was delivered'],
      ['cancelled', 'Cancelled: nothing was delivered'],
      ['invalid-input', 'Invalid input: the project could not be analyzed reliably'],
      ['dry-run', 'Dry run: nothing was changed'],
    ] as const) {
      const text = renderReportText(buildReport({ status, plan: undefined, engineInfo: undefined, analysis: a, results: [], validations: [] }));
      expect(text.split('\n')[0]).toBe(first);
      expect(text).not.toContain('Output:');
      expect(text).toContain('Validations: 0/0 passed');
    }
  });
});

describe('validation verdicts', () => {
  /** Status of every check, in order. */
  const statuses = (v: ReturnType<typeof summarizeValidation>) => Object.fromEntries(v.checks.map((c) => [c.name, c.status]));
  const NOT_RUN = 'not-run' as const;

  it('classifies packages from unusable to valid', async () => {
    const unusable = await validateArchive(new MemoryByteSource(enc.encode('plain text')), { limits: limits() });
    expect(unusable).toMatchObject({ schema: 'elpx-optimizer/validation', verdict: 'unusable', counts: { fatal: 1, error: 0, warning: 0, info: 0 } });
    expect(unusable.package).toBeUndefined();

    const broken = summarizeValidation((await analyzeBytes(elpxFixture('broken-refs.elpx'))).result);
    expect(broken.verdict).toBe('invalid');
    expect(broken.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['local-references', 'unambiguous-references']);
    expect(broken.checks.every((c) => c.status !== NOT_RUN)).toBe(true);

    const stale = summarizeValidation((await analyzeBytes(upstream('download-elpx-link.elpx'))).result);
    expect(stale.verdict).toBe('valid-with-warnings');
    expect(stale.checks.find((c) => c.name === 'download-manifest')).toMatchObject({ ok: false, status: 'failed' });

    const clean = await validateArchive(
      new MemoryByteSource(
        buildElpx({ components: [{ html: `<img src="${R}/a.png">` }], files: { 'content/resources/a.png': media('palette-efficient.png') } }),
      ),
      { limits: limits() },
    );
    expect(clean).toMatchObject({ verdict: 'valid', counts: { fatal: 0, error: 0, warning: 0, info: 0 }, package: { variant: 'v4' } });
    expect(clean.checks.every((c) => c.ok && c.status === 'passed')).toBe(true);
    expect(clean.checks[0]).toEqual({ name: 'zip-structure', ok: true, status: 'passed', detail: 'Central directory, local headers, names, sizes and CRCs' });
  });

  it('reports the checks an unusable input never reached as not run', async () => {
    const { craftZip } = await import('../../helpers/zip-craft.js');
    const { odeXml } = await import('../../helpers/core-kit.js');
    const xml = odeXml({ components: [{ id: '', type: '' }] });
    const cases: [string, Uint8Array, Record<string, string>][] = [
      ['not a ZIP', enc.encode('plain text, not a zip'), { 'zip-structure': NOT_RUN, 'eXeLearning-project': 'failed', 'content-xml': NOT_RUN }],
      ['truncated ZIP', buildElpx({ components: [] }).subarray(0, 100), { 'zip-structure': 'failed', 'eXeLearning-project': NOT_RUN, 'content-xml': NOT_RUN }],
      ['legacy .elp', upstream('verdaderofalso.elp'), { 'zip-structure': 'passed', 'eXeLearning-project': 'failed', 'content-xml': NOT_RUN }],
      [
        'legacy root in content.xml',
        buildElpx({ contentXml: '<instance/>' }),
        { 'zip-structure': 'passed', 'eXeLearning-project': 'failed', 'content-xml': 'passed' },
      ],
      [
        'unreadable content.xml',
        craftZip([{ name: 'content.xml', data: xml, central: { crc: 7 }, local: { crc: 7 } }]),
        { 'zip-structure': 'failed', 'eXeLearning-project': 'passed', 'content-xml': NOT_RUN },
      ],
      [
        'malformed content.xml',
        buildElpx({ contentXml: '<ode><broken></ode>' }),
        { 'zip-structure': 'passed', 'eXeLearning-project': 'passed', 'content-xml': 'failed' },
      ],
    ];
    for (const [name, bytes, expected] of cases) {
      const v = summarizeValidation((await analyzeBytes(bytes)).result);
      expect({ name, ...statuses(v) }).toEqual({
        name,
        ...expected,
        'ode-structure': NOT_RUN,
        'local-references': NOT_RUN,
        'unambiguous-references': NOT_RUN,
        'download-manifest': NOT_RUN,
      });
      expect(v.verdict).toBe('unusable');
      for (const c of v.checks) {
        expect(c.ok).toBe(c.status === 'passed');
        if (c.status === NOT_RUN) expect(c.detail).toMatch(/^Not checked: the project could not be analyzed this far \(/);
      }
    }
    // Corrupt entry data is found after content.xml was parsed: the structure checks did run.
    const entryData = summarizeValidation(
      (
        await analyzeBytes(
          craftZip([
            { name: 'content.xml', data: xml },
            { name: 'content/resources/a.png', data: 'x', central: { crc: 1 }, local: { crc: 1 } },
          ]),
        )
      ).result,
    );
    expect(statuses(entryData)).toEqual({
      'zip-structure': 'failed',
      'eXeLearning-project': 'passed',
      'content-xml': 'passed',
      'ode-structure': 'failed',
      'local-references': NOT_RUN,
      'unambiguous-references': NOT_RUN,
      'download-manifest': NOT_RUN,
    });
  });

  it('flags structural problems of an analyzable package', async () => {
    const structure = summarizeValidation((await analyzeBytes(buildElpx({ components: [{ id: '', type: '' }] }))).result);
    expect(structure).toMatchObject({ verdict: 'invalid' });
    expect(structure.checks.filter((c) => !c.ok).map((c) => [c.name, c.status])).toEqual([['ode-structure', 'failed']]);
  });
});
