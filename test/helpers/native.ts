import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MEDIA = join(ROOT, 'test', 'fixtures', 'media');

/** Points the native engine at a project-local ffprobe when the system has none. */
export function configureLocalTools(): void {
  const local = join(ROOT, '.tools', 'bin', 'ffprobe');
  if (!process.env['ELPX_OPTIMIZER_FFPROBE'] && existsSync(local)) process.env['ELPX_OPTIMIZER_FFPROBE'] = local;
}

/** True when ffmpeg and ffprobe can be executed (tests needing them are skipped otherwise, and CI requires them). */
export function nativeVideoAvailable(): boolean {
  configureLocalTools();
  try {
    execFileSync(process.env['ELPX_OPTIMIZER_FFMPEG'] ?? 'ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync(process.env['ELPX_OPTIMIZER_FFPROBE'] ?? 'ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
