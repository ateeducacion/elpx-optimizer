import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname as pathExtname, join, resolve } from 'node:path';
import { ElpxError } from '../core/errors.js';
import { NATIVE_LIMITS, resolveLimits, type Limits } from '../core/limits.js';
import type { ProgressEvent } from '../core/media/engine.js';
import { FileByteSource } from '../adapters/node/file-source.js';
import type { CliIO } from './io.js';

/** Parses an integer flag value, or throws invalid-options. */
export function intFlag(values: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ElpxError('invalid-options', `--${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** Builds limits from flags. */
export function limitsFromFlags(values: Record<string, unknown>): Limits {
  const overrides: Partial<Limits> = {};
  const archive = intFlag(values, 'max-archive-size', 1, Number.MAX_SAFE_INTEGER);
  if (archive !== undefined) overrides.maxArchiveBytes = archive;
  const video = intFlag(values, 'max-video-size', 1, Number.MAX_SAFE_INTEGER);
  if (video !== undefined) overrides.maxVideoBytes = video;
  const timeout = intFlag(values, 'timeout-video', 1, 7 * 24 * 3600);
  if (timeout !== undefined) overrides.videoTimeoutMs = timeout * 1000;
  return resolveLimits(NATIVE_LIMITS, overrides);
}

/** Resolves and opens the single input file argument. */
export async function openInputArg(positionals: string[], io: CliIO): Promise<{ path: string; source: FileByteSource; name: string }> {
  if (positionals.length !== 1) throw new ElpxError('invalid-options', 'Expected exactly one input file');
  const path = resolve(io.cwd, positionals[0]!);
  const source = await FileByteSource.open(path);
  return { path, source, name: basename(path) };
}

/** Default output path: <dir>/<name>_optimized.elpx. */
export function defaultOutputPath(inputPath: string): string {
  const ext = pathExtname(inputPath);
  const stem = /^\.(elpx|elp|zip)$/i.test(ext) ? basename(inputPath, ext) : basename(inputPath);
  return join(dirname(inputPath), `${stem}_optimized.elpx`);
}

/** Refuses outputs that are, or link to, the input file. */
export async function assertNotInput(inputPath: string, outputPath: string): Promise<void> {
  const inReal = await realpath(inputPath);
  const outReal = await realpath(outputPath).catch(() => resolve(outputPath));
  if (inReal === outReal) throw new ElpxError('invalid-options', 'The output must not be the input file');
  const a = await stat(inputPath);
  const b = await stat(outputPath).catch(() => undefined);
  if (b && a.dev === b.dev && a.ino === b.ino) throw new ElpxError('invalid-options', 'The output is a link to the input file');
}

/** Returns a progress printer for stderr (throttled, human readable). */
export function progressPrinter(io: CliIO, quiet: boolean): (e: ProgressEvent) => void {
  if (quiet) return () => undefined;
  let last = '';
  let lastTime = 0;
  return (e) => {
    const now = Date.now();
    let line: string;
    const item = e.item !== undefined && e.items !== undefined ? ` [${e.item}/${e.items}]` : '';
    switch (e.stage) {
      case 'transcode':
        line = `Transcoding${item} ${e.resource ?? ''}${e.processedSeconds !== undefined && e.totalSeconds ? ` ${e.processedSeconds.toFixed(1)}/${e.totalSeconds.toFixed(1)} s` : ''}`;
        break;
      case 'read':
        line = 'Reading input';
        break;
      case 'analyze':
        line = `Checking entries${item}`;
        break;
      case 'probe':
        line = `Inspecting media${item} ${e.resource ?? ''}`;
        break;
      case 'encode-image':
        line = `Images${item}`;
        break;
      case 'pdf':
        line = `PDF${item} ${e.resource ?? ''}`;
        break;
      case 'package':
        line = `Packaging${item}`;
        break;
      case 'done':
        return;
      default:
        line = `${e.stage}${item}${e.resource ? ` ${e.resource}` : ''}${e.message ? `: ${e.message}` : ''}`;
    }
    const stageChanged = line.split(' ')[0] !== last.split(' ')[0];
    if (line === last || (!stageChanged && now - lastTime < 1000)) return;
    last = line;
    lastTime = now;
    io.stderr(`${line}\n`);
  };
}
