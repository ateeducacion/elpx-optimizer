import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, relative } from 'node:path';
import { findOnPath, isFile, NOT_FOUND, resolveCli, run, SKILL_DIR } from '../../../skills/elpx-optimizer/scripts/run.mjs';
import { removeDir, tempDir, writeScript } from '../../helpers/cli.js';
import { ROOT } from '../../helpers/native.js';

/** Fake CLI (a Node script) that records its arguments and working directory in FAKE_OUT. */
const FAKE_CLI = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
else if (process.env.FAKE_WAIT) setTimeout(() => undefined, 30000);
else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let dir: string;
let fakeCli: string;
let outFile: string;

/** Output captured from run(). */
interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Calls run() with captured stdout/stderr and no inherited stdio. */
async function runWrapper(argv: string[], options: Record<string, unknown> = {}): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdio: 'ignore',
    stdout: (t: string) => (stdout += t),
    stderr: (t: string) => (stderr += t),
    ...options,
  });
  return { code, stdout, stderr };
}

/** What the fake CLI recorded. */
async function recorded(): Promise<{ argv: string[]; cwd: string }> {
  return JSON.parse(await readFile(outFile, 'utf8')) as { argv: string[]; cwd: string };
}

beforeAll(async () => {
  dir = await tempDir('elpx skill wrapper ');
  fakeCli = join(dir, 'fake cli.mjs');
  outFile = join(dir, 'recorded.json');
  await writeFile(fakeCli, FAKE_CLI);
});
afterAll(async () => {
  await removeDir(dir);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.restoreAllMocks();
});

describe('isFile and findOnPath', () => {
  it('accepts regular files, executable ones when required', async () => {
    const plain = join(dir, 'plain.txt');
    await writeFile(plain, 'x');
    const exe = await writeScript(join(dir, 'exe'), 'exit 0');
    expect(isFile(plain)).toBe(true);
    expect(isFile(plain, true)).toBe(false);
    expect(isFile(exe, true)).toBe(true);
    expect(isFile(dir)).toBe(false);
    expect(isFile(join(dir, 'missing'))).toBe(false);
  });

  it('searches absolute PATH entries for an executable', async () => {
    const bin = join(dir, 'bin one');
    await mkdir(bin, { recursive: true });
    const cli = await writeScript(join(bin, 'elpx-optimizer'), 'exit 0');
    expect(findOnPath('elpx-optimizer', ['', 'relative', bin].join(delimiter), 'linux')).toBe(cli);
    expect(findOnPath('elpx-optimizer', undefined, 'linux')).toBeUndefined();
    expect(findOnPath('elpx-optimizer', dir, 'linux')).toBeUndefined();
  });

  it('tries .cmd and .exe on Windows without requiring the executable bit', async () => {
    const bin = join(dir, 'win bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'elpx-optimizer.cmd'), '@echo off');
    expect(findOnPath('elpx-optimizer', bin, 'win32')).toBe(join(bin, 'elpx-optimizer.cmd'));
    expect(findOnPath('elpx-optimizer', bin, 'linux')).toBeUndefined();
  });

  it('uses the platform of the current process by default', async () => {
    expect(findOnPath('definitely-not-installed-elpx', '/usr/bin')).toBeUndefined();
  });
});

describe('resolveCli', () => {
  it('runs a configured .mjs bundle with the current runtime, relative to cwd', () => {
    expect(resolveCli({ env: { ELPX_OPTIMIZER_CLI: 'fake cli.mjs' }, cwd: dir, runtime: '/opt/node' })).toEqual({
      command: '/opt/node',
      args: [fakeCli],
      source: 'ELPX_OPTIMIZER_CLI',
    });
  });

  it('runs a configured executable directly', async () => {
    const exe = await writeScript(join(dir, 'elpx-optimizer-bin'), 'exit 0');
    expect(resolveCli({ env: { ELPX_OPTIMIZER_CLI: exe }, cwd: '/' })).toEqual({ command: exe, args: [], source: 'ELPX_OPTIMIZER_CLI' });
  });

  it('reports a configured path that cannot run', async () => {
    const plain = join(dir, 'not-runnable');
    await writeFile(plain, 'data');
    for (const configured of [plain, join(dir, 'missing.mjs')]) {
      expect(resolveCli({ env: { ELPX_OPTIMIZER_CLI: configured } })).toEqual({
        error: `ELPX_OPTIMIZER_CLI points to "${configured}", which is not a runnable file`,
      });
    }
  });

  it('accepts any configured file as a command on Windows', async () => {
    const exe = join(dir, 'elpx-optimizer.exe');
    await writeFile(exe, 'MZ');
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    expect(resolveCli({ env: { ELPX_OPTIMIZER_CLI: exe } })).toMatchObject({ command: exe, source: 'ELPX_OPTIMIZER_CLI' });
  });

  it('prefers the vendored bundle, then PATH, then a built checkout', async () => {
    const layout = join(dir, 'layout');
    const skillDir = join(layout, 'skills', 'elpx-optimizer');
    await mkdir(join(skillDir, 'vendor'), { recursive: true });
    await mkdir(join(layout, 'dist', 'cli'), { recursive: true });
    await mkdir(join(layout, 'bin'), { recursive: true });
    const checkout = join(layout, 'dist', 'cli', 'elpx-optimizer.mjs');
    await writeFile(checkout, '');
    const onPath = await writeScript(join(layout, 'bin', 'elpx-optimizer'), 'exit 0');
    const vendored = join(skillDir, 'vendor', 'elpx-optimizer.mjs');
    const env = { PATH: join(layout, 'bin') };
    expect(resolveCli({ env, skillDir, runtime: 'node' })).toEqual({ command: onPath, args: [], source: 'PATH' });
    await writeFile(vendored, '');
    expect(resolveCli({ env, skillDir, runtime: 'node' })).toEqual({ command: 'node', args: [vendored], source: 'vendor' });
    expect(resolveCli({ env: {}, skillDir: join(layout, 'skills', 'other'), runtime: 'node' })).toEqual({
      command: 'node',
      args: [checkout],
      source: 'checkout',
    });
    expect(resolveCli({ env: {}, skillDir: join(dir, 'nowhere', 'skills', 'x') })).toBeUndefined();
  });

  it('defaults to the skill directory of the script', () => {
    expect(SKILL_DIR).toBe(join(ROOT, 'skills', 'elpx-optimizer'));
    const resolved = resolveCli({ env: {} });
    if (existsSync(join(ROOT, 'dist', 'cli', 'elpx-optimizer.mjs')))
      expect(resolved).toEqual({ command: process.execPath, args: [join(ROOT, 'dist', 'cli', 'elpx-optimizer.mjs')], source: 'checkout' });
    expect(() => resolveCli()).not.toThrow();
  });
});

describe('run', () => {
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: process.env['PATH'] ?? '',
    ELPX_OPTIMIZER_CLI: fakeCli,
    FAKE_OUT: outFile,
    ...extra,
  });

  it('forwards arguments unchanged, including spaces and shell characters', async () => {
    const args = ['inspect', '/tmp/mi curso ñ.elpx', '--json', '$(rm -rf /)', "it's", ''];
    const r = await runWrapper(args, { env: env(), cwd: dir });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await recorded()).toEqual({ argv: args, cwd: dir });
  });

  it('propagates the exit code', async () => {
    expect((await runWrapper(['validate', 'x.elpx'], { env: env({ FAKE_EXIT: '4' }) })).code).toBe(4);
    expect((await runWrapper(['doctor'], { env: env({ FAKE_EXIT: '5' }) })).code).toBe(5);
  });

  it('maps a CLI killed by a signal to 130', async () => {
    expect((await runWrapper(['optimize'], { env: env({ FAKE_SIGNAL: 'SIGTERM' }) })).code).toBe(130);
  });

  it('forwards SIGINT/SIGTERM to the CLI and removes its handlers afterwards', async () => {
    const before = process.listeners('SIGINT');
    await removeDir(outFile);
    const pending = runWrapper(['serve'], { env: env({ FAKE_WAIT: '1' }) });
    await vi.waitFor(() => expect(existsSync(outFile)).toBe(true), { timeout: 10_000 });
    const forward = process.listeners('SIGINT').find((l) => !before.includes(l))!;
    expect(process.listeners('SIGTERM')).toContain(forward);
    (forward as (signal: string) => void)('SIGINT');
    expect((await pending).code).toBe(130);
    expect(process.listeners('SIGINT')).toEqual(before);
    expect(process.listeners('SIGTERM')).not.toContain(forward);
  });

  it('runs an executable CLI with the given skill dir and runtime options', async () => {
    const exe = await writeScript(join(dir, 'sh-cli'), `printf '%s\\n' "$@" > "$FAKE_OUT"`);
    const r = await runWrapper(['inspect', 'a b.elpx'], { env: env({ ELPX_OPTIMIZER_CLI: exe }), skillDir: join(dir, 'unused'), runtime: '/unused/node' });
    expect(r.code).toBe(0);
    expect(await readFile(outFile, 'utf8')).toBe('inspect\na b.elpx\n');
  });

  it('prints the resolved CLI with --which', async () => {
    const r = await runWrapper(['--which', 'ignored'], { env: env(), runtime: '/opt/node' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ source: 'ELPX_OPTIMIZER_CLI', command: '/opt/node', args: [fakeCli] });
  });

  it('exits 5 with guidance when no CLI is found', async () => {
    const r = await runWrapper(['doctor'], { env: { PATH: '' }, skillDir: join(dir, 'nowhere', 'skills', 'x') });
    expect(r).toEqual({ code: 5, stdout: '', stderr: NOT_FOUND });
    expect(NOT_FOUND).toMatch(/ELPX_OPTIMIZER_CLI/);
    expect(NOT_FOUND).toContain(join('vendor', 'elpx-optimizer.mjs'));
  });

  it('exits 5 when ELPX_OPTIMIZER_CLI is invalid', async () => {
    const configured = relative(process.cwd(), join(dir, 'missing-cli'));
    const r = await runWrapper(['doctor'], { env: { ELPX_OPTIMIZER_CLI: configured } });
    expect(r).toEqual({ code: 5, stdout: '', stderr: `ELPX_OPTIMIZER_CLI points to "${configured}", which is not a runnable file\n` });
  });

  it('exits 1 when the CLI cannot be started', async () => {
    const broken = await writeScript(join(dir, 'broken-cli'), '');
    await writeFile(broken, '#!/nonexistent/interpreter\n');
    const r = await runWrapper(['doctor'], { env: env({ ELPX_OPTIMIZER_CLI: broken }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Cannot start the CLI: /);
  });

  it('writes to the process streams and inherits stdio by default', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const saved = process.env['ELPX_OPTIMIZER_CLI'];
    process.env['ELPX_OPTIMIZER_CLI'] = fakeCli;
    process.env['FAKE_OUT'] = outFile;
    try {
      expect(await run(['--which'])).toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain('"source":"ELPX_OPTIMIZER_CLI"');
      expect(await run(['inspect', 'x y.elpx'])).toBe(0);
      expect((await recorded()).argv).toEqual(['inspect', 'x y.elpx']);
      process.env['ELPX_OPTIMIZER_CLI'] = join(dir, 'missing-cli');
      const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(await run(['doctor'])).toBe(5);
      expect(String(errors.mock.calls[0]?.[0])).toMatch(/not a runnable file/);
    } finally {
      if (saved === undefined) delete process.env['ELPX_OPTIMIZER_CLI'];
      else process.env['ELPX_OPTIMIZER_CLI'] = saved;
      delete process.env['FAKE_OUT'];
    }
  });
});
