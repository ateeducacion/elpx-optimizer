#!/usr/bin/env bun
/**
 * Independent compatibility check (make compat): optimizes a set of
 * fixtures with our CLI and verifies each result with eXeLearning's own
 * importer/exporters at the pinned SHA (test/compat/upstream-roundtrip.ts).
 * Requires scripts/fetch-upstream.sh to have been run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const upstream = join(root, '.cache', 'upstream', 'exelearning');
const harness = join(upstream, '.elpx-harness', 'roundtrip.ts');
if (!existsSync(harness)) {
  console.error('Upstream checkout missing: run scripts/fetch-upstream.sh first');
  process.exit(2);
}
const out = process.env['ELPX_COMPAT_OUT'] ?? join(root, 'test-results', 'compat');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const cli = process.env['ELPX_OPTIMIZER_CLI'] ?? join(root, 'src', 'cli', 'bin.ts');
const DEFAULT = ['--remove-unused', 'safe', '--deduplicate', 'exact'];
const cases: { fixture: string; flags: string[]; label?: string }[] = [
  ...[
    'test/fixtures/elpx/course-video.elpx',
    'test/fixtures/elpx/efficient.elpx',
    'test/fixtures/elpx/broken-refs.elpx',
    'test/fixtures/upstream/un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx',
    'test/fixtures/upstream/Un contenido de ejemplo para probar estilos y catalogación.elpx',
    'test/fixtures/upstream/download-elpx-link.elpx',
    'test/fixtures/upstream/pdf-noext-iframe.elpx',
    'test/fixtures/upstream/missing-asset-refs.elpx',
    'test/fixtures/upstream/damaged-trueorfalse-json.elpx',
    'test/fixtures/upstream/stale-text-template-refs.elpx',
    'test/fixtures/upstream/encoding_test.elp',
  ].map((fixture) => ({ fixture, flags: DEFAULT })),
  // eXeLearning 3 editor folders moved to content/resources/.
  {
    fixture: 'test/fixtures/upstream/Un contenido de ejemplo para probar estilos y catalogación.elpx',
    flags: [...DEFAULT, '--flatten', 'legacy'],
    label: 'flatten',
  },
  { fixture: 'test/fixtures/elpx/legacy-folders.elpx', flags: [...DEFAULT, '--flatten', 'legacy'], label: 'flatten' },
  // Audio converted to MP3 (renamed, references and declared types updated).
  { fixture: 'test/fixtures/elpx/audio-course.elpx', flags: DEFAULT, label: 'audio' },
  // References to missing files taken out.
  { fixture: 'test/fixtures/elpx/broken-refs.elpx', flags: [...DEFAULT, '--missing-references', 'remove'], label: 'unlink' },
  { fixture: 'test/fixtures/upstream/missing-asset-refs.elpx', flags: [...DEFAULT, '--missing-references', 'remove'], label: 'unlink' },
  { fixture: 'test/fixtures/upstream/stale-text-template-refs.elpx', flags: [...DEFAULT, '--missing-references', 'remove'], label: 'unlink' },
];
const rows: { fixture: string; status: string; saved: number; ok: boolean; detail: string }[] = [];
for (const { fixture: f, flags, label } of cases) {
  const input = join(root, f);
  const name = `${basename(f).replace(/\.(elpx?|zip)$/i, '')}${label ? `.${label}` : ''}`;
  const output = join(out, `${name}_optimized.elpx`);
  const reportPath = join(out, `${name}.report.json`);
  const opt = spawnSync(
    'bun',
    [
      cli,
      'optimize',
      input,
      '--preset',
      'balanced',
      ...flags,
      '--video-x264-preset',
      'veryfast',
      '--output',
      output,
      '--report',
      reportPath,
      '--json',
      '--quiet',
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (opt.status !== 0 && opt.status !== 4) {
    rows.push({ fixture: `${f}${label ? ` [${label}]` : ''}`, status: `cli exit ${opt.status}`, saved: 0, ok: false, detail: opt.stderr.slice(0, 300) });
    continue;
  }
  const report = JSON.parse(opt.stdout) as {
    status: string;
    sizes: { saved: number };
    operations: { op: string; path: string; status: string; detail?: string }[];
  };
  // Moved files: map each new path back to the original one for the content-hash comparison.
  const renames = Object.fromEntries(
    report.operations.filter((o) => o.op === 'move-resource' && o.status === 'applied').map((o) => [/moved to (.+?);/.exec(o.detail ?? '')![1]!, o.path]),
  );
  const renamesPath = join(out, `${name}.renames.json`);
  writeFileSync(renamesPath, JSON.stringify(renames));
  const extra = [`--renames=${renamesPath}`, ...(label === 'unlink' ? ['--content-changes'] : [])];
  const check = spawnSync('bun', [harness, input, output, `--report=${join(out, `${name}.compat.json`)}`, ...extra], { cwd: upstream, encoding: 'utf8' });
  const compat = existsSync(join(out, `${name}.compat.json`))
    ? (JSON.parse(readFileSync(join(out, `${name}.compat.json`), 'utf8')) as Record<string, unknown>)
    : undefined;
  const moved = Object.keys(renames).length;
  const unlinked = report.operations.filter((o) => o.op === 'remove-missing-reference' && o.status === 'applied').length;
  const detail = compat
    ? [
        ...['structureDiffs', 'metaDiffs', 'newMissing', 'newUnresolved', 'newPlaceholders', 'reimportDiffs'].map(
          (k) => `${k}:${(compat[k] as unknown[]).length}`,
        ),
        ...(() => {
          const left = compat['placeholdersLeftByUpstream'] as { before: number; after: number };
          return left.before + left.after > 0 ? [`upstreamUnconverted:${left.before}→${left.after}`] : [];
        })(),
        ...(moved ? [`moved:${moved}`] : []),
        ...(unlinked ? [`unlinked:${unlinked}`, `contentDiffs:${String(compat['contentDiffs'])}`] : []),
      ].join(' ')
    : check.stderr.slice(0, 300);
  rows.push({ fixture: `${f}${label ? ` [${label}]` : ''}`, status: report.status, saved: report.sizes.saved, ok: check.status === 0, detail });
}
for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${basename(r.fixture)} — ${r.status}, saved ${r.saved} bytes — ${r.detail}`);
const failed = rows.filter((r) => !r.ok);
console.log(`${rows.length - failed.length}/${rows.length} packages compatible with eXeLearning ${basename(upstream)} (reports in test-results/compat)`);
process.exit(failed.length === 0 ? 0 : 1);
