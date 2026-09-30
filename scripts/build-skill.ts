#!/usr/bin/env bun
/**
 * Assembles the distributable skill in dist/skill/elpx-optimizer with the CLI
 * bundle in vendor/ (sharp must be installed there with npm if image
 * optimization is wanted; ffmpeg/ffprobe come from the system).
 * Requires `bun scripts/build-cli.ts` first.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const bundle = join(root, 'dist', 'cli', 'elpx-optimizer.mjs');
if (!existsSync(bundle)) {
  console.error('dist/cli/elpx-optimizer.mjs is missing; run "bun scripts/build-cli.ts" first');
  process.exit(1);
}
const target = join(root, 'dist', 'skill', 'elpx-optimizer');
rmSync(join(root, 'dist', 'skill'), { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(root, 'skills', 'elpx-optimizer'), target, { recursive: true });
mkdirSync(join(target, 'vendor'), { recursive: true });
cpSync(bundle, join(target, 'vendor', 'elpx-optimizer.mjs'));
cpSync(join(root, 'dist', 'cli', 'qpdf-runner.mjs'), join(target, 'vendor', 'qpdf-runner.mjs'));
const pkg = JSON.parse(readFileSync(join(root, 'dist', 'cli', 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
writeFileSync(
  join(target, 'vendor', 'package.json'),
  `${JSON.stringify({ name: 'elpx-optimizer-skill-vendor', private: true, version: pkg.version, type: 'module', dependencies: pkg.dependencies }, null, 2)}\n`,
);
writeFileSync(
  join(target, 'vendor', 'README.md'),
  '# Bundled CLI\n\n`elpx-optimizer.mjs` is the CLI used by `scripts/run.mjs` (`qpdf-runner.mjs` rewrites PDFs). For image and PDF optimization run `npm install` in this folder (installs sharp, OxiPNG and qpdf-wasm). Video and audio need ffmpeg and ffprobe on PATH.\n',
);
console.log(`Skill written to ${target}`);
