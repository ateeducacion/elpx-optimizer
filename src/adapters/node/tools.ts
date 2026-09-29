import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { runProcess } from './process.js';

/** Locations of the native tools, after resolution. */
export interface ToolPaths {
  ffmpeg: string | undefined;
  ffprobe: string | undefined;
}

/** Explicit tool locations (CLI flags); fall back to env vars and PATH. */
export interface ToolOverrides {
  ffmpeg?: string;
  ffprobe?: string;
}

/** Finds an executable in PATH (or validates an explicit path). */
export async function findExecutable(name: string, explicit?: string): Promise<string | undefined> {
  const candidates: string[] = [];
  // Explicit paths are made absolute: tools run with a private working directory.
  if (explicit) candidates.push(resolve(explicit));
  else {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      for (const ext of exts) candidates.push(join(dir, name + ext));
    }
  }
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Resolves ffmpeg and ffprobe from overrides, ELPX_OPTIMIZER_FFMPEG/FFPROBE, then PATH. */
export async function resolveTools(overrides: ToolOverrides = {}): Promise<ToolPaths> {
  return {
    ffmpeg: await findExecutable('ffmpeg', overrides.ffmpeg ?? process.env['ELPX_OPTIMIZER_FFMPEG']),
    ffprobe: await findExecutable('ffprobe', overrides.ffprobe ?? process.env['ELPX_OPTIMIZER_FFPROBE']),
  };
}

/** Returns the first line of `tool -version`, or undefined when it cannot run. */
export async function toolVersion(path: string): Promise<string | undefined> {
  try {
    const result = await runProcess(path, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
    if (result.code !== 0) return undefined;
    const first = result.stdout.split('\n')[0] ?? '';
    const m = /version\s+(\S+)/.exec(first);
    return m ? m[1] : first.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Lists encoder names supported by an ffmpeg binary. */
export async function listEncoders(ffmpeg: string): Promise<string[]> {
  try {
    const result = await runProcess(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15_000 });
    if (result.code !== 0) return [];
    const out: string[] = [];
    for (const line of result.stdout.split('\n')) {
      const m = /^\s[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
      if (m) out.push(m[1]!);
    }
    return out;
  } catch {
    return [];
  }
}
