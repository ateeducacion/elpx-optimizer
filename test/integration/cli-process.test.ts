import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, cp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable } from '../../src/adapters/node/tools.js';
import { TOOL_VERSION } from '../../src/core/version.js';
import { ELPX, fileSha256, removeDir, singleJson, tempDir, writeScript } from '../helpers/cli.js';
import { configureLocalTools, nativeVideoAvailable, ROOT } from '../helpers/native.js';

/**
 * Runs the real processes: `bun src/cli/bin.ts`, the Node bundle
 * dist/cli/elpx-optimizer.mjs and the packaged Agent Skill copied outside the
 * repository. These are not instrumented; the in-process tests measure coverage.
 */

const video = nativeVideoAvailable();
const COURSE = join(ELPX, 'course-video.elpx');
const BUNDLE = join(ROOT, 'dist', 'cli', 'elpx-optimizer.mjs');
const BUN = findBun();
let tmp: string;

/** Path of the bun executable, if installed. */
function findBun(): string | undefined {
  try {
    return (
      execFileSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' })
        .split('\n')[0]!
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** Result of a finished process. */
interface Exited {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Spawns a process; `onStderr` may signal it while it runs. */
function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onStderr?: (text: string, pid: number) => void } = {},
): Promise<Exited> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      options.onStderr?.(stderr, child.pid!);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

beforeAll(async () => {
  configureLocalTools();
  // Fresh bundle and skill from the current sources (a few hundred milliseconds with Bun).
  if (BUN) {
    execFileSync(BUN, ['scripts/build-cli.ts'], { cwd: ROOT, stdio: 'ignore' });
    execFileSync(BUN, ['scripts/build-skill.ts'], { cwd: ROOT, stdio: 'ignore' });
  }
  tmp = await tempDir('elpx process tests ');
});
afterAll(async () => {
  await removeDir(tmp);
});

describe.runIf(BUN)('bun src/cli/bin.ts', () => {
  it('prints the version', async () => {
    const r = await exec(BUN!, ['src/cli/bin.ts', '--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^elpx-optimizer ${TOOL_VERSION.replace(/\./g, '\\.')} \\(eXeLearning format `));
  });

  it('prints exactly one JSON document and nothing on stderr with --json', async () => {
    const r = await exec(BUN!, ['src/cli/bin.ts', 'inspect', COURSE, '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(singleJson<{ schema: string }>(r.stdout).schema).toBe('elpx-optimizer/analysis');
  });

  it('exits 2 for an unknown flag and 4 for a project with errors', async () => {
    expect((await exec(BUN!, ['src/cli/bin.ts', 'inspect', COURSE, '--nope'])).code).toBe(2);
    expect((await exec(BUN!, ['src/cli/bin.ts', 'validate', join(ELPX, 'broken-refs.elpx')])).code).toBe(4);
  });
});

describe.runIf(BUN)('node dist/cli/elpx-optimizer.mjs', () => {
  const node = (args: string[], options: Parameters<typeof exec>[2] = {}): Promise<Exited> => exec(process.execPath, [BUNDLE, ...args], options);

  it('runs under Node with the documented exit codes', async () => {
    const version = await node(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain(`elpx-optimizer ${TOOL_VERSION}`);
    expect((await node([])).code).toBe(2);
    expect((await node(['frobnicate'])).code).toBe(2);
    expect((await node(['inspect', join(ROOT, 'test', 'fixtures', 'upstream', 'verdaderofalso.elp')])).code).toBe(3);
    expect((await node(['validate', join(ELPX, 'broken-refs.elpx'), '--json'])).code).toBe(4);
    expect((await node(['doctor', '--ffmpeg', '/nonexistent/ffmpeg', '--json'])).code).toBe(5);
  });

  it('inspects with one JSON document on stdout', async () => {
    const r = await node(['inspect', COURSE, '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(singleJson<{ ok: boolean }>(r.stdout).ok).toBe(true);
  });

  it('stops serving on SIGINT with exit 0', async () => {
    const web = join(tmp, 'web root');
    await mkdir(web, { recursive: true });
    await writeFile(join(web, 'index.html'), 'ok');
    let signalled = false;
    const r = await node(['serve', '--root', web, '--port', '0'], {
      onStderr: (text, pid) => {
        if (!signalled && text.includes('Open http://')) {
          signalled = true;
          process.kill(pid, 'SIGINT');
        }
      },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Cancelling (press Ctrl+C again to force)...');
  });

  it.runIf(video)('cancels an optimize on SIGINT: exit 130, ffmpeg killed, nothing delivered', async () => {
    const work = join(tmp, 'cancel run');
    await mkdir(work, { recursive: true });
    const real = await findExecutable('ffmpeg', process.env['ELPX_OPTIMIZER_FFMPEG']);
    const pidFile = join(work, 'ffmpeg.pid');
    const slow = await writeScript(
      join(work, 'slow-ffmpeg'),
      `case "$*" in *-progress*) echo $$ > "${pidFile}"; exec "${real}" -re "$@";; esac\nexec "${real}" "$@"`,
    );
    const input = join(work, 'curso.elpx');
    await copyFile(COURSE, input);
    let signalled = false;
    const r = await node(['optimize', input, '--ffmpeg', slow], {
      onStderr: (text, pid) => {
        if (!signalled && /Transcoding .* [1-9]\d*\.\d\/|Transcoding .* 0\.[1-9]\//.test(text)) {
          signalled = true;
          process.kill(pid, 'SIGINT');
        }
      },
    });
    expect(signalled).toBe(true);
    expect(r.code).toBe(130);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await readdir(work)).sort()).toEqual(['curso.elpx', 'ffmpeg.pid', 'slow-ffmpeg']);
    expect(await fileSha256(input)).toBe(await fileSha256(COURSE));
  });
});

describe.runIf(BUN)('skill wrapper process', () => {
  const wrapper = join(ROOT, 'skills', 'elpx-optimizer', 'scripts', 'run.mjs');

  it('resolves the built checkout and propagates exit codes', async () => {
    // A PATH without an installed elpx-optimizer, so the checkout bundle is chosen.
    const env = { ...process.env, ELPX_OPTIMIZER_CLI: '', PATH: '/usr/bin:/bin' };
    const which = await exec(process.execPath, [wrapper, '--which'], { cwd: tmp, env });
    expect(which.code).toBe(0);
    expect(JSON.parse(which.stdout)).toEqual({ source: 'checkout', command: process.execPath, args: [BUNDLE] });
    expect((await exec(process.execPath, [wrapper, 'validate', join(ELPX, 'broken-refs.elpx')], { cwd: tmp, env })).code).toBe(4);
  });

  it('exits 5 for an invalid ELPX_OPTIMIZER_CLI', async () => {
    const r = await exec(process.execPath, [wrapper, 'doctor'], { env: { ...process.env, ELPX_OPTIMIZER_CLI: '/nonexistent/cli.mjs' } });
    expect(r.code).toBe(5);
    expect(r.stderr).toBe('ELPX_OPTIMIZER_CLI points to "/nonexistent/cli.mjs", which is not a runnable file\n');
  });
});

describe.runIf(BUN)('packaged skill outside the repository', () => {
  let skill: string;
  let project: string;
  let elsewhere: string;
  let env: NodeJS.ProcessEnv;

  /** Runs the packaged skill's run.mjs from an unrelated working directory. */
  const runSkill = (args: string[]): Promise<Exited> => exec(process.execPath, [join(skill, 'scripts', 'run.mjs'), ...args], { cwd: elsewhere, env });

  beforeAll(async () => {
    skill = join(tmp, 'agent skills', 'elpx-optimizer');
    await cp(join(ROOT, 'dist', 'skill', 'elpx-optimizer'), skill, { recursive: true });
    // The vendored bundle imports sharp; reuse the repository's installation (no download).
    await symlink(join(ROOT, 'node_modules'), join(skill, 'vendor', 'node_modules'), 'dir');
    await mkdir(join(tmp, 'mis proyectos ñ'));
    project = join(tmp, 'mis proyectos ñ', 'curso de año.elpx');
    await copyFile(COURSE, project);
    elsewhere = join(tmp, 'otra carpeta');
    await mkdir(elsewhere);
    env = { ...process.env, ELPX_OPTIMIZER_CLI: '' };
    delete env['NODE_PATH'];
  });

  it('uses the vendored CLI', async () => {
    const r = await runSkill(['--which']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ source: 'vendor', command: process.execPath, args: [join(skill, 'vendor', 'elpx-optimizer.mjs')] });
    expect(ROOT.startsWith(tmp)).toBe(false);
  });

  it('inspects a project whose path has spaces and non-ASCII characters', async () => {
    const r = await runSkill(['inspect', project, '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const analysis = singleJson<{ ok: boolean; input: { name: string }; package: { title: string } }>(r.stdout);
    expect(analysis.ok).toBe(true);
    expect(analysis.input.name).toBe('curso de año.elpx');
    expect(analysis.package.title).toBe('Curso con vídeo');
  });

  it.runIf(video)('optimizes and validates the result', async () => {
    const output = join(tmp, 'mis proyectos ñ', 'curso de año (optimizado).elpx');
    const report = join(tmp, 'mis proyectos ñ', 'informe.json');
    const r = await runSkill(['optimize', project, '--json', '--output', output, '--report', report]);
    expect(r.code).toBe(0);
    const result = singleJson<{ status: string; sizes: { before: number; after: number }; operations: { op: string; status: string }[] }>(r.stdout);
    expect(result.status).toBe('optimized');
    expect(result.sizes.after).toBeLessThan(result.sizes.before);
    expect(result.operations.some((o) => o.op === 'recompress-image' && o.status === 'applied')).toBe(true);
    expect(result.operations.some((o) => o.op === 'transcode-video' && o.status === 'applied')).toBe(true);
    expect(JSON.parse(await readFile(report, 'utf8'))).toEqual(result);
    const validation = await runSkill(['validate', output, '--json']);
    expect(validation.code).toBe(0);
    expect(singleJson<{ verdict: string }>(validation.stdout).verdict).toBe('valid');
    expect(await fileSha256(project)).toBe(await fileSha256(COURSE));
  });
});
