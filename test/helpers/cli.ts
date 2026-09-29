import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main } from '../../src/cli/main.js';
import type { CliIO } from '../../src/cli/io.js';
import { ROOT } from './native.js';

export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const ELPX = join(FIXTURES, 'elpx');
export const UPSTREAM = join(FIXTURES, 'upstream');
export const V3_FIXTURE = join(UPSTREAM, 'Un contenido de ejemplo para probar estilos y catalogación.elpx');

/** Captured result of an in-process CLI run. */
export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Options of an in-process CLI run (defaults: repository cwd, non-interactive). */
export interface CliRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  interactive?: boolean;
  signal?: AbortSignal;
  /** Observes every stderr write as it happens (e.g. to cancel at a given stage). */
  onStderr?: (text: string) => void;
}

/** Builds a CliIO that records stdout and stderr. */
export function captureIO(options: CliRunOptions = {}): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: (t) => void out.push(t),
    stderr: (t) => {
      err.push(t);
      options.onStderr?.(t);
    },
    env: options.env ?? { ...process.env },
    cwd: options.cwd ?? ROOT,
    interactive: options.interactive ?? false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return { io, out, err };
}

/** Runs the CLI in-process through main(argv, io). */
export async function runCli(argv: string[], options: CliRunOptions = {}): Promise<CliRun> {
  const { io, out, err } = captureIO(options);
  const code = await main(argv, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** Parses stdout as exactly one JSON document (JSON.parse rejects trailing text). */
export function singleJson<T = Record<string, unknown>>(stdout: string): T {
  expectOneDocument(stdout);
  return JSON.parse(stdout) as T;
}

/** Throws unless the text is one JSON object followed by a single newline. */
function expectOneDocument(stdout: string): void {
  if (!stdout.startsWith('{') || !stdout.endsWith('}\n')) throw new Error(`stdout is not a single JSON document:\n${stdout.slice(0, 500)}`);
}

/** Creates a temporary directory (real path, so comparisons with realpath work). */
export async function tempDir(prefix = 'elpx-cli-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Removes a directory tree. */
export async function removeDir(dir: string | undefined): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true });
}

/** Writes an executable /bin/sh script and returns its path. */
export async function writeScript(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Shell snippet answering -version and -encoders like an ffmpeg with libx264. */
export const FAKE_FFMPEG_IDENTITY = `case "$*" in
  *-version*) echo "ffmpeg version 9.9-fake Copyright (c) test"; exit 0;;
  *-encoders*) printf ' V....D libx264              H.264\\n A....D aac                  AAC\\n'; exit 0;;
esac`;

/** Writes a fake ffmpeg that passes detection but fails every encode. */
export function writeFailingFfmpeg(dir: string): Promise<string> {
  return writeScript(join(dir, 'ffmpeg'), `${FAKE_FFMPEG_IDENTITY}\necho "fake ffmpeg: encoding failed" >&2\nexit 1`);
}

/** SHA-256 of a file, to prove inputs are left byte-identical. */
export async function fileSha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
