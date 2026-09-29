#!/usr/bin/env node
/**
 * Agent Skill wrapper for the elpx-optimizer CLI.
 *
 * It only locates an existing CLI and forwards the arguments unchanged
 * (argument vector, no shell), so paths with spaces work and the skill never
 * implements its own compressor. Resolution order:
 *   1. ELPX_OPTIMIZER_CLI (a .mjs/.js bundle or an executable)
 *   2. vendor/elpx-optimizer.mjs bundled with the skill
 *   3. elpx-optimizer on PATH
 *   4. ../../dist/cli/elpx-optimizer.mjs when the skill sits in a built checkout
 * It works from any working directory.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Directory of the skill (parent of scripts/). */
export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Returns true when path is an existing regular file (executable when required). */
export function isFile(path, executable = false) {
  try {
    if (!statSync(path).isFile()) return false;
    if (executable) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds a command on PATH. */
export function findOnPath(name, pathValue, platform = process.platform) {
  const exts = platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate, platform !== 'win32')) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves how to run the CLI. Returns { command, args, source } where
 * command/args prefix the user arguments, or undefined when nothing is found.
 */
export function resolveCli({ env = process.env, skillDir = SKILL_DIR, runtime = process.execPath, cwd = process.cwd() } = {}) {
  const asScript = (path, source) => ({ command: runtime, args: [path], source });
  const configured = env.ELPX_OPTIMIZER_CLI;
  if (configured) {
    const path = resolve(cwd, configured);
    if (/\.(mjs|cjs|js)$/.test(path) && isFile(path)) return asScript(path, 'ELPX_OPTIMIZER_CLI');
    if (isFile(path, process.platform !== 'win32')) return { command: path, args: [], source: 'ELPX_OPTIMIZER_CLI' };
    return { error: `ELPX_OPTIMIZER_CLI points to "${configured}", which is not a runnable file` };
  }
  const vendored = join(skillDir, 'vendor', 'elpx-optimizer.mjs');
  if (isFile(vendored)) return asScript(vendored, 'vendor');
  const onPath = findOnPath('elpx-optimizer', env.PATH);
  if (onPath) return { command: onPath, args: [], source: 'PATH' };
  const checkout = resolve(skillDir, '..', '..', 'dist', 'cli', 'elpx-optimizer.mjs');
  if (isFile(checkout)) return asScript(checkout, 'checkout');
  return undefined;
}

/** Help text shown when no CLI can be found. */
export const NOT_FOUND = `elpx-optimizer CLI not found.
Install or point to it, then retry:
  - set ELPX_OPTIMIZER_CLI=/path/to/elpx-optimizer.mjs, or
  - put the bundle at ${join('vendor', 'elpx-optimizer.mjs')} inside this skill, or
  - install the CLI so that "elpx-optimizer" is on PATH, or
  - build the repository (make build) when using the skill from a checkout.
`;

/** Runs the CLI with the given arguments; resolves with its exit code. */
export function run(argv, options = {}) {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? ((t) => process.stderr.write(t));
  const stdout = options.stdout ?? ((t) => process.stdout.write(t));
  const resolved = resolveCli({
    env,
    ...(options.skillDir ? { skillDir: options.skillDir } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  if (!resolved) {
    stderr(NOT_FOUND);
    return Promise.resolve(5);
  }
  if (resolved.error) {
    stderr(`${resolved.error}\n`);
    return Promise.resolve(5);
  }
  if (argv[0] === '--which') {
    stdout(`${JSON.stringify({ source: resolved.source, command: resolved.command, args: resolved.args })}\n`);
    return Promise.resolve(0);
  }
  return new Promise((resolveExit) => {
    const child = spawn(resolved.command, [...resolved.args, ...argv], { stdio: options.stdio ?? 'inherit', env, cwd: options.cwd ?? process.cwd() });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', (error) => {
      stderr(`Cannot start the CLI: ${error.message}\n`);
      resolveExit(1);
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolveExit(code ?? (signal ? 130 : 1));
    });
  });
}

// Process entry point. It calls process.exit, so it is exercised by spawn-based tests
// (not instrumented) rather than in-process ones.
/* v8 ignore start */
if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
/* v8 ignore stop */
