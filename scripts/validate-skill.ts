#!/usr/bin/env bun
/**
 * Validates skills/elpx-optimizer against the Agent Skills specification.
 * Uses the official validator (`agentskills validate`, from the PyPI package
 * skills-ref) when available, and always runs the built-in checks below.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = process.argv[2] ?? join(import.meta.dir, '..', 'skills', 'elpx-optimizer');
const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
const errors: string[] = [];
const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
if (!m) errors.push('SKILL.md must start with YAML frontmatter');
const front = m?.[1] ?? '';
const field = (k: string): string | undefined => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim();
const name = field('name');
if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) errors.push('invalid name');
if (name !== basename(dir)) errors.push('name must match the directory name');
const description = field('description');
if (!description || description.length > 1024) errors.push('description missing or longer than 1024 characters');
const compatibility = field('compatibility');
if (compatibility && compatibility.length > 500) errors.push('compatibility longer than 500 characters');
if (text.split('\n').length > 500) errors.push('SKILL.md should stay under 500 lines');
for (const ref of text.matchAll(/\]\(([^)]+)\)/g)) {
  const target = ref[1]!;
  if (!/^https?:/.test(target) && !existsSync(join(dir, target))) errors.push(`missing referenced file ${target}`);
}
for (const f of ['scripts/run.mjs', 'references/cli.md', 'references/safety.md', 'LICENSE']) if (!existsSync(join(dir, f))) errors.push(`missing ${f}`);

const official = [process.env['AGENTSKILLS_BIN'], join(import.meta.dir, '..', '.cache', 'skills-ref-venv', 'bin', 'agentskills'), 'agentskills'].filter(
  Boolean,
) as string[];
let ran = false;
for (const bin of official) {
  const r = spawnSync(bin, ['validate', dir], { encoding: 'utf8' });
  if (r.error) continue;
  ran = true;
  process.stdout.write(r.stdout + r.stderr);
  if (r.status !== 0) errors.push('official validator failed');
  break;
}
if (!ran) console.log('Official validator (agentskills from PyPI "skills-ref") not found; built-in checks only.');
if (errors.length > 0) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(`✓ ${dir} follows the Agent Skills specification`);
