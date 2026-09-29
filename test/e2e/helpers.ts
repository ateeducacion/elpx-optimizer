import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Request } from '@playwright/test';
import { FileByteSource } from '../../src/adapters/node/file-source.js';
import { analyzeArchive } from '../../src/core/analyze/analyze.js';
import { NATIVE_LIMITS } from '../../src/core/limits.js';
import { openZip, readEntryBytes } from '../../src/core/zip/reader.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E_FIXTURES = join(ROOT, 'test-results', 'e2e-fixtures');
export const FIXTURES = join(ROOT, 'test', 'fixtures');

/** Paths of every file in dist/web (the only resources the page may request). */
export function staticFiles(): Set<string> {
  const base = join(ROOT, 'dist', 'web');
  const out = new Set<string>(['']);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.add(relative(base, p).split('\\').join('/'));
    }
  };
  walk(base);
  return out;
}

/** Records every request the page (and its workers) makes. */
export function recordRequests(page: Page): Request[] {
  const list: Request[] = [];
  page.on('request', (r) => list.push(r));
  return list;
}

/**
 * Asserts the privacy contract: only GET requests for the app's own static
 * files (or local blob: URLs); nothing is sent anywhere.
 */
export function assertOnlyStaticRequests(requests: readonly Request[], origin: string, basePath: string): string[] {
  const allowed = staticFiles();
  const problems: string[] = [];
  for (const r of requests) {
    const url = r.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) continue;
    const u = new URL(url);
    if (u.origin !== origin) problems.push(`other origin: ${url}`);
    if (r.method() !== 'GET') problems.push(`${r.method()} ${url}`);
    if (r.postData()) problems.push(`request body sent to ${url}`);
    const rel = decodeURIComponent(u.pathname).replace(basePath, '');
    if (!allowed.has(rel) && rel !== 'index.html') problems.push(`not a static app file: ${url}`);
  }
  return problems;
}

/** Selects a file through a drag-and-drop on the drop zone (DataTransfer built in the page). */
export async function dropFile(page: Page, path: string, name: string): Promise<void> {
  const b64 = readFileSync(path).toString('base64');
  await page.evaluate(
    ({ b64: data, fileName }) => {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], fileName, { type: 'application/zip' }));
      const zone = document.querySelector('[data-testid="dropzone"]')!;
      zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { b64, fileName: name },
  );
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Reads one entry of a package with the core reader (CRC checked). */
export async function readEntry(path: string, entry: string): Promise<Uint8Array> {
  const src = await FileByteSource.open(path);
  try {
    const archive = await openZip(src, NATIVE_LIMITS);
    return await readEntryBytes(archive, archive.byName.get(entry)!, 1 << 30);
  } finally {
    await src.close();
  }
}

/** Full analysis of a downloaded package. */
export async function analyzeFile(path: string) {
  const src = await FileByteSource.open(path);
  try {
    return (await analyzeArchive(src, { limits: NATIVE_LIMITS })).result;
  } finally {
    await src.close();
  }
}

function ffprobeBin(): string {
  const local = join(ROOT, '.tools', 'bin', 'ffprobe');
  return process.env['ELPX_OPTIMIZER_FFPROBE'] ?? (existsSync(local) ? local : 'ffprobe');
}

/** Independent inspection with NATIVE ffprobe and a full NATIVE decode of a video. */
export function nativeVideoCheck(bytes: Uint8Array): {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; profile?: string }[];
  duration: number;
  decodeErrors: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'elpx-e2e-'));
  try {
    const file = join(dir, 'video.mp4');
    writeFileSync(file, bytes);
    const json = JSON.parse(execFileSync(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as {
      streams: never[];
      format: { duration: string };
    };
    let decodeErrors = '';
    try {
      execFileSync(process.env['ELPX_OPTIMIZER_FFMPEG'] ?? 'ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      decodeErrors = String((error as { stderr?: Buffer }).stderr ?? error);
    }
    return { streams: json.streams, duration: Number(json.format.duration), decodeErrors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
