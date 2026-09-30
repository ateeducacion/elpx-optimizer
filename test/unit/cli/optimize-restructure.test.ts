import { APP_DEFAULTS } from '../../../src/core/plan/options.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { optionsFromFlags, renderPlan } from '../../../src/cli/commands/optimize.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { OptimizationPlan, PlanOperation } from '../../../src/core/plan/plan.js';
import { analyzeBytes } from '../../helpers/core-kit.js';
import { captureIO, ELPX, removeDir, runCli, singleJson, tempDir } from '../../helpers/cli.js';
import { configureLocalTools } from '../../helpers/native.js';

/** CLI support for flattening eXeLearning 3 folders and taking out references to missing files. */

const LEGACY = join(ELPX, 'legacy-folders.elpx');
const A = 'content/resources/20240101120000AAAAAA';
let dir: string;

beforeAll(async () => {
  configureLocalTools();
  dir = await tempDir('elpx-restructure-');
});
afterAll(async () => {
  await removeDir(dir);
});

interface DryRun {
  status: string;
  plan: OptimizationPlan;
}

/** The other clean-ups are on by default: these tests look at flatten alone. */
const NO_CLEANUP = ['--remove-unused', 'off', '--deduplicate', 'off', '--normalize-names', 'off'];

describe('optimize --flatten / --missing-references', () => {
  it('maps the flags onto the options, over --config', async () => {
    const io = captureIO({ cwd: dir }).io;
    expect(await optionsFromFlags({ flatten: 'legacy', 'missing-references': 'remove' }, io)).toEqual({
      ...APP_DEFAULTS,
      flatten: 'legacy',
      missingReferences: 'remove',
    });
    await writeFile(join(dir, 'restructure.json'), JSON.stringify({ flatten: 'legacy', missingReferences: 'remove' }));
    expect(await optionsFromFlags({ config: 'restructure.json', flatten: 'off' }, io)).toEqual({
      ...APP_DEFAULTS,
      flatten: 'off',
      missingReferences: 'remove',
    });
  });

  it.each([
    ['--flatten', 'all', 'flatten must be "off" or "legacy"'],
    ['--missing-references', 'hide', 'missingReferences must be "keep" or "remove"'],
  ])('rejects %s %s', async (flag, value, message) => {
    const r = await runCli(['optimize', LEGACY, '--dry-run', flag, value]);
    expect(r).toMatchObject({ code: EXIT.USAGE, stderr: `Invalid options: ${message}\n` });
  });

  it('documents both options', async () => {
    const { stdout } = await runCli(['optimize', '--help']);
    expect(stdout).toContain('--flatten MODE             off (default) | legacy');
    expect(stdout).toContain('--missing-references MODE  keep (default) | remove');
  });

  it('shows moves and removed references in the plan', async () => {
    const json = await runCli(['optimize', LEGACY, '--dry-run', '--json', '--quiet', '--flatten', 'legacy', '--missing-references', 'remove', ...NO_CLEANUP], {
      cwd: dir,
    });
    expect(json.code).toBe(EXIT.SUCCESS);
    const { status, plan } = singleJson<DryRun>(json.stdout);
    expect(status).toBe('dry-run');
    expect(plan.options).toMatchObject({ flatten: 'legacy', missingReferences: 'remove' });
    expect(plan.operations.filter((o) => o.op === 'move-resource')).toHaveLength(5);
    expect(plan.operations.filter((o) => o.op === 'remove-missing-reference')).toHaveLength(3);
    const text = await runCli([
      'optimize',
      LEGACY,
      '--dry-run',
      '--quiet',
      '--verbose',
      '--flatten',
      'legacy',
      '--missing-references',
      'remove',
      ...NO_CLEANUP,
    ]);
    expect(text.code).toBe(EXIT.SUCCESS);
    expect(text.stdout).toContain(`  • move ${A}/foto.jpg → content/resources/foto.jpg (5 references rewritten)\n`);
    expect(text.stdout).toContain('  • take out 3 references to missing content/resources/fondo-perdido.png (in content.xml, index.html, search_index.js)\n');
    expect(text.stdout).toContain('Note: Files in eXeLearning 3 folders will be moved to content/resources/ and their references rewritten.\n');
    // Off by default.
    const plain = singleJson<DryRun>((await runCli(['optimize', LEGACY, '--dry-run', '--json', '--quiet'])).stdout);
    expect(plain.plan.operations.some((o) => o.op === 'move-resource' || o.op === 'remove-missing-reference')).toBe(false);
  });

  it('writes a flattened package without broken references', async () => {
    const out = join(dir, 'flattened.elpx');
    const r = await runCli([
      'optimize',
      LEGACY,
      '--output',
      out,
      '--flatten',
      'legacy',
      '--missing-references',
      'remove',
      '--no-images',
      '--no-video',
      '--json',
      '--quiet',
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(EXIT.SUCCESS);
    const report = singleJson<{ status: string; validations: { name: string; ok: boolean }[] }>(r.stdout);
    expect(report.status).toBe('optimized');
    expect(report.validations.every((v) => v.ok)).toBe(true);
    const after = await analyzeBytes(new Uint8Array(await readFile(out)));
    expect(after.result.package?.legacyFolders).toEqual({ folders: 0, files: 0 });
    expect(after.result.diagnostics.some((d) => d.code === 'missing-resource')).toBe(false);
  });
});

describe('renderPlan: restructuring operations', () => {
  it('describes moves and removed references', () => {
    const plan = {
      input: { name: 'p.elpx', size: 10 },
      options: { preset: 'balanced' },
      engine: { engine: 'native' },
      operations: [
        { op: 'move-resource', path: `${A}/a.png`, to: 'content/resources/a_2.png', references: 2 },
        { op: 'remove-missing-reference', path: 'content/resources/x.png', references: 1, entries: ['content.xml'] },
        { op: 'remove-missing-reference', path: 'asset://y.png', references: 3, entries: ['content.xml', 'index.html'] },
      ] as unknown as PlanOperation[],
      skipped: [{ path: `${A}/b.png`, reason: 'kept', detail: 'contains references to other files' }],
      estimate: { savedBytes: 0 },
      risks: [],
    } as unknown as OptimizationPlan;
    expect(renderPlan(plan)).toBe(
      [
        'Plan for p.elpx (10 B), preset balanced, engine native',
        `  • move ${A}/a.png → content/resources/a_2.png (2 references rewritten)`,
        '  • take out 1 reference to missing content/resources/x.png (in content.xml)',
        '  • take out 3 references to missing asset://y.png (in content.xml, index.html)',
        'Left unchanged (1):',
        `  - ${A}/b.png: kept (contains references to other files)`,
        'Estimated saving (estimate, not measured): 0 B',
        '',
      ].join('\n'),
    );
  });
});
