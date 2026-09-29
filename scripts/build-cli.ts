#!/usr/bin/env bun
/**
 * Bundles the CLI into dist/cli/elpx-optimizer.mjs, runnable with Node 22+
 * or Bun. sharp stays external (native module): install it next to the
 * bundle (dist/cli/package.json declares it). The static web app is looked up
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
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const bundle = join(out, 'elpx-optimizer.mjs');
chmodSync(bundle, 0o755);
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'elpx-optimizer-cli',
      version: pkg.version,
      description: 'Command line interface of elpx-optimizer (analyze and shrink eXeLearning .elpx projects).',
      license: 'AGPL-3.0-or-later',
      type: 'module',
      bin: { 'elpx-optimizer': 'elpx-optimizer.mjs' },
      files: ['elpx-optimizer.mjs', 'LICENSE', 'README.md'],
      engines: { node: pkg.engines.node },
      dependencies: { sharp: pkg.dependencies.sharp },
    },
    null,
    2,
  )}\n`,
);
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
writeFileSync(
  join(out, 'README.md'),
  `# elpx-optimizer CLI ${pkg.version}\n\nInstall: \`npm install -g ./elpx-optimizer-cli-${pkg.version}.tgz\` (downloads sharp) or run \`node elpx-optimizer.mjs\` after \`npm install\` in this folder.\nVideo optimization needs ffmpeg and ffprobe on PATH (or --ffmpeg/--ffprobe). See https://github.com/ateeducacion/elpx-optimizer.\n`,
);
console.log(`CLI bundle written to ${bundle}`);
