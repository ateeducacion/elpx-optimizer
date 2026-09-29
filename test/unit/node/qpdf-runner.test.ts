import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QPDF_VERSION } from '../../../src/adapters/browser/qpdf-version.js';
import { craftPdf } from '../../helpers/pdf-craft.js';
import { removeDir, tempDir } from '../../helpers/cli.js';

/**
 * qpdf-runner.ts is a process entry (the native engine runs it in a child
 * process): it reads process.argv, writes qpdf's output to the real
 * stdout/stderr and sets process.exitCode. Each test imports a fresh copy
 * with a controlled argv (like bin.test.ts), captures the streams and
 * restores everything; the engine tests cover it as a child process.
 */

let dir: string;
let savedArgv: string[];
let out: Buffer[];
let err: Buffer[];

beforeAll(async () => {
  dir = await tempDir('elpx-qpdf-runner-');
  writeFileSync(join(dir, 'in.pdf'), craftPdf({ pages: 2, image: { width: 120, height: 90 } }));
});
afterAll(async () => {
  await removeDir(dir);
});
beforeEach(() => {
  vi.resetModules();
  savedArgv = process.argv;
  process.exitCode = undefined;
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => out.push(Buffer.from(chunk)) > 0);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => err.push(Buffer.from(chunk)) > 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@neslinesli93/qpdf-wasm');
  process.argv = savedArgv;
  process.exitCode = undefined;
});

/** Runs the runner in-process with the given arguments; returns its exit code and output. */
async function runner(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  process.argv = [process.argv[0]!, 'qpdf-runner', ...args];
  await import('../../../src/adapters/node/qpdf-runner.ts');
  const code = Number(process.exitCode);
  process.exitCode = undefined;
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

describe('qpdf-runner', () => {
  it('reports the qpdf version without files', async () => {
    const r = await runner(['-', '-', '--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`version ${QPDF_VERSION}`);
  });

  it('places the input at /in.pdf and copies /out.pdf to the output path', async () => {
    const output = join(dir, 'out.pdf');
    const r = await runner([join(dir, 'in.pdf'), output, '--object-streams=generate', '--compress-streams=y', '/in.pdf', '/out.pdf']);
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    const bytes = readFileSync(output);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeLessThan(readFileSync(join(dir, 'in.pdf')).length);
  });

  it('prints inspection output and writes nothing when qpdf wrote no file', async () => {
    const output = join(dir, 'none.pdf');
    const r = await runner([join(dir, 'in.pdf'), output, '--check', '/in.pdf']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No syntax or stream encoding errors found');
    expect(existsSync(output)).toBe(false);
  });

  it('passes qpdf errors through with its exit code', async () => {
    // No input ("-"): /in.pdf does not exist.
    const missing = await runner(['-', '-', '--check', '/in.pdf']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('/in.pdf: No such file or directory');
    // No arguments at all: qpdf's usage error.
    vi.resetModules();
    out.length = 0;
    err.length = 0;
    const bare = await runner([]);
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain('--help');
  });

  it('turns a crash inside qpdf into an exit code', async () => {
    const crash = (thrown: unknown): void => {
      vi.doMock('@neslinesli93/qpdf-wasm', () => ({
        default: (options: { preRun: ((m: unknown) => void)[] }) => {
          const m = {
            FS: {
              // Characters written before the crash are kept; null only flushes a stream.
              init: (_input: null, output: (c: number | null) => void, error: (c: number | null) => void) => {
                output(0x6f);
                output(null);
                error(0x65);
                error(null);
              },
              writeFile: () => undefined,
              readFile: () => new Uint8Array([37, 80, 68, 70]),
            },
            callMain: () => {
              throw thrown;
            },
          };
          for (const f of options.preRun) f(m);
          return Promise.resolve(m);
        },
      }));
    };
    // An Emscripten exit status keeps its code.
    crash({ name: 'ExitStatus', status: 3 });
    const exit = await runner([join(dir, 'in.pdf'), join(dir, 'crash.pdf'), '--check', '/in.pdf']);
    expect(exit).toEqual({ code: 3, stdout: 'o', stderr: 'e' });
    expect(readFileSync(join(dir, 'crash.pdf')).toString()).toBe('%PDF');
    // Anything else (a WebAssembly trap) is exit 2 with the error on stderr.
    vi.resetModules();
    out.length = 0;
    err.length = 0;
    crash(new Error('RuntimeError: unreachable'));
    const trap = await runner(['-', '-', '--check', '/in.pdf']);
    expect(trap).toEqual({ code: 2, stdout: 'o', stderr: 'eError: RuntimeError: unreachable' });
  });
});
