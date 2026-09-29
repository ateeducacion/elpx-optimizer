/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable } from '../../src/adapters/node/tools.js';
import { TOOL_VERSION } from '../../src/core/version.js';
import { ELPX, fileSha256, removeDir, runCli, singleJson, tempDir, UPSTREAM, writeFailingFfmpeg, writeScript } from '../helpers/cli.js';
import { nativeVideoAvailable, ROOT } from '../helpers/native.js';

/** Smoke tests of the CLI under the Bun runtime, in-process through main() and as a process. */

setDefaultTimeout(120_000);
const video = nativeVideoAvailable();
const COURSE = join(ELPX, 'course-video.elpx');
let dir: string;

beforeAll(async () => {
  dir = await tempDir('elpx-bun-cli-');
});
afterAll(async () => {
  await removeDir(dir);
});

describe('CLI in-process under Bun', () => {
  it('prints the version and the help', async () => {
    expect((await runCli(['--version'])).stdout).toContain(`elpx-optimizer ${TOOL_VERSION}`);
    expect((await runCli([])).code).toBe(2);
    expect((await runCli(['optimize', '--bogus'])).code).toBe(2);
  });

  it('inspects and validates with the documented exit codes', async () => {
    const inspect = await runCli(['inspect', COURSE, '--json']);
    expect(inspect.code).toBe(0);
    expect(inspect.stderr).toBe('');
    expect(singleJson<{ ok: boolean }>(inspect.stdout).ok).toBe(true);
    expect((await runCli(['validate', join(ELPX, 'broken-refs.elpx')])).code).toBe(4);
    expect((await runCli(['inspect', join(UPSTREAM, 'verdaderofalso.elp')])).code).toBe(3);
  });

  it('plans a dry run', async () => {
    const r = await runCli(['optimize', COURSE, '--dry-run', '--json', '--remove-unused', 'safe']);
    expect(r.code).toBe(0);
    expect(singleJson<{ schema: string }>(r.stdout).schema).toBe('elpx-optimizer/dry-run');
  });

  it.skipIf(!video)('optimizes a project with spaces in its path and validates the result', async () => {
    const work = join(dir, 'mi carpeta');
    await mkdir(work, { recursive: true });
    await copyFile(COURSE, join(work, 'curso ñ.elpx'));
    const r = await runCli(['optimize', 'curso ñ.elpx', '--json'], { cwd: work });
    expect(r.code).toBe(0);
    expect(singleJson<{ status: string }>(r.stdout).status).toBe('optimized');
    expect((await runCli(['validate', join(work, 'curso ñ_optimized.elpx')])).code).toBe(0);
    expect(await fileSha256(join(work, 'curso ñ.elpx'))).toBe(await fileSha256(COURSE));
  });

  it.skipIf(!video)('exits 4 when the video fails and 130 when cancelled', async () => {
    const work = join(dir, 'failures');
    await mkdir(work, { recursive: true });
    const failing = await writeFailingFfmpeg(work);
    const partial = await runCli(['optimize', COURSE, '--output', join(work, 'partial.elpx'), '--ffmpeg', failing, '--json']);
    expect(partial.code).toBe(4);
    const real = await findExecutable('ffmpeg', process.env['ELPX_OPTIMIZER_FFMPEG']);
    const pidFile = join(work, 'ffmpeg.pid');
    const slow = await writeScript(
      join(work, 'slow-ffmpeg'),
      `case "$*" in *-progress*) echo $$ > "${pidFile}"; exec "${real}" -re "$@";; esac\nexec "${real}" "$@"`,
    );
    const controller = new AbortController();
    const cancelled = await runCli(['optimize', COURSE, '--output', join(work, 'cancelled.elpx'), '--ffmpeg', slow], {
      signal: controller.signal,
      onStderr: (t) => {
        const m = /^Transcoding .* (\d+\.\d)\/\d+\.\d s\n$/.exec(t);
        if (m && Number(m[1]) > 0) controller.abort();
      },
    });
    expect(cancelled.code).toBe(130);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await readdir(work)).sort()).toEqual(['ffmpeg', 'ffmpeg.pid', 'partial.elpx', 'slow-ffmpeg']);
  });

  it('serves the static app until cancelled', async () => {
    const web = join(dir, 'web');
    await mkdir(web, { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html>');
    await writeFile(join(web, 'core.wasm'), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    const controller = new AbortController();
    let resolveUrl: (url: string) => void = () => undefined;
    const printed = new Promise<string>((resolve) => (resolveUrl = resolve));
    const running = runCli(['serve', '--root', web, '--port', '0', '--isolation'], {
      signal: controller.signal,
      onStderr: (t) => {
        const m = /Open (\S+)/.exec(t);
        if (m) resolveUrl(m[1]!);
      },
    });
    const url = await printed;
    const index = await fetch(url);
    expect(index.status).toBe(200);
    expect(index.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect((await fetch(new URL('core.wasm', url))).headers.get('content-type')).toBe('application/wasm');
    expect((await fetch(url, { method: 'POST', body: 'x' })).status).toBe(405);
    controller.abort();
    expect((await running).code).toBe(0);
  });
});

describe('CLI process under Bun', () => {
  it('runs src/cli/bin.ts', async () => {
    const proc = Bun.spawn([process.execPath, join(ROOT, 'src', 'cli', 'bin.ts'), 'inspect', COURSE, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(singleJson<{ schema: string }>(stdout).schema).toBe('elpx-optimizer/analysis');
    expect(JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version).toBe(TOOL_VERSION);
  });
});
