#!/usr/bin/env bun
/**
 * Independent compatibility check (make compat): optimizes a set of
 * fixtures with our CLI and verifies each result with eXeLearning's own
 * importer/exporters at the pinned SHA (test/compat/upstream-roundtrip.ts).
 * Requires scripts/fetch-upstream.sh to have been run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const upstream = join(root, '.cache', 'upstream', 'exelearning');
const harness = join(upstream, '.elpx-harness', 'roundtrip.ts');
if (!existsSync(harness)) {
  console.error('Upstream checkout missing: run scripts/fetch-upstream.sh first');
  process.exit(2);
}
const out = join(root, 'test-results', 'compat');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const cli = process.env['ELPX_OPTIMIZER_CLI'] ?? join(root, 'src', 'cli', 'bin.ts');
const fixtures = [
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
];
const rows: { fixture: string; status: string; saved: number; ok: boolean; detail: string }[] = [];
for (const f of fixtures) {
  const input = join(root, f);
  const name = basename(f).replace(/\.(elpx?|zip)$/i, '');
  const output = join(out, `${name}_optimized.elpx`);
  const opt = spawnSync(
    'bun',
    [
      cli,
      'optimize',
      input,
      '--preset',
      'balanced',
      '--remove-unused',
      'safe',
      '--deduplicate',
      'exact',
      '--video-x264-preset',
      'veryfast',
      '--output',
      output,
      '--report',
      join(out, `${name}.report.json`),
      '--json',
      '--quiet',
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (opt.status !== 0 && opt.status !== 4) {
    rows.push({ fixture: f, status: `cli exit ${opt.status}`, saved: 0, ok: false, detail: opt.stderr.slice(0, 300) });
    continue;
  }
  const report = JSON.parse(opt.stdout) as { status: string; sizes: { saved: number } };
  const check = spawnSync('bun', [harness, input, output, `--report=${join(out, `${name}.compat.json`)}`], { cwd: upstream, encoding: 'utf8' });
  const compat = existsSync(join(out, `${name}.compat.json`))
    ? (JSON.parse(readFileSync(join(out, `${name}.compat.json`), 'utf8')) as Record<string, unknown>)
    : undefined;
  const detail = compat
    ? ['structureDiffs', 'metaDiffs', 'newMissing', 'newUnresolved', 'reimportDiffs'].map((k) => `${k}:${(compat[k] as unknown[]).length}`).join(' ')
    : check.stderr.slice(0, 300);
  rows.push({ fixture: f, status: report.status, saved: report.sizes.saved, ok: check.status === 0, detail });
}
for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${basename(r.fixture)} — ${r.status}, saved ${r.saved} bytes — ${r.detail}`);
const failed = rows.filter((r) => !r.ok);
console.log(`${rows.length - failed.length}/${rows.length} packages compatible with eXeLearning ${basename(upstream)} (reports in test-results/compat)`);
process.exit(failed.length === 0 ? 0 : 1);
