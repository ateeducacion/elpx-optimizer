#!/usr/bin/env bun
/**
 * Bundles the CLI into dist/cli/elpx-optimizer.mjs, runnable with Node 22+
 * or Bun, and the qpdf runner into dist/cli/qpdf-runner.mjs (PDFs are
 * rewritten by qpdf compiled to WebAssembly in a child process). sharp (a
 * native module) and @neslinesli93/qpdf-wasm (it loads its .wasm file from
 * its own folder) stay external: install them next to the bundle
 * (dist/cli/package.json declares them). The static web app is looked up
 * in ../web relative to the bundle, or passed with `serve --root`.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'dist', 'cli');
mkdirSync(out, { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
  engines: Record<string, string>;
};

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'cli', 'bin.ts')],
  outdir: out,
  naming: 'elpx-optimizer.mjs',
  target: 'node',
  format: 'esm',
  external: ['sharp'],
  minify: false,
  sourcemap: 'none',
  banner: '#!/usr/bin/env node',
});
const runner = await Bun.build({
  entrypoints: [join(root, 'src', 'adapters', 'node', 'qpdf-runner.ts')],
  outdir: out,
  naming: 'qpdf-runner.mjs',
  target: 'node',
  format: 'esm',
  external: ['@neslinesli93/qpdf-wasm'],
  minify: false,
  sourcemap: 'none',
});
for (const r of [result, runner]) {
  if (!r.success) {
    for (const log of r.logs) console.error(log);
    process.exit(1);
  }
}
const bundle = join(out, 'elpx-optimizer.mjs');
chmodSync(bundle, 0o755);
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'elpx-optimizer',
      version: pkg.version,
      description: 'Command line interface of elpx-optimizer (analyze and shrink eXeLearning .elpx projects).',
      license: 'AGPL-3.0-or-later',
      keywords: ['exelearning', 'elpx', 'optimizer', 'education', 'ffmpeg', 'compression'],
      homepage: 'https://github.com/ateeducacion/elpx-optimizer',
      repository: { type: 'git', url: 'git+https://github.com/ateeducacion/elpx-optimizer.git' },
      bugs: { url: 'https://github.com/ateeducacion/elpx-optimizer/issues' },
      type: 'module',
      bin: { 'elpx-optimizer': 'elpx-optimizer.mjs' },
      files: ['elpx-optimizer.mjs', 'qpdf-runner.mjs', 'LICENSE', 'README.md'],
      engines: { node: pkg.engines.node },
      dependencies: { sharp: pkg.dependencies.sharp, '@neslinesli93/qpdf-wasm': pkg.dependencies['@neslinesli93/qpdf-wasm'] },
    },
    null,
    2,
  )}\n`,
);
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
writeFileSync(
  join(out, 'README.md'),
  `# elpx-optimizer CLI ${pkg.version}\n\nRun: \`npx elpx-optimizer optimize curso.elpx\`, or install: \`npm install -g elpx-optimizer\` (or \`./elpx-optimizer-${pkg.version}.tgz\` from a release; downloads sharp and qpdf-wasm), or run \`node elpx-optimizer.mjs\` after \`npm install\` in this folder.\nVideo and audio optimization need ffmpeg and ffprobe on PATH (or --ffmpeg/--ffprobe); PDFs use qpdf compiled to WebAssembly (no install). See https://github.com/ateeducacion/elpx-optimizer.\n`,
);
console.log(`CLI bundle written to ${bundle}`);
