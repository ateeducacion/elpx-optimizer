import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_VERSION } from '../../../src/core/version.js';
import { removeDir, tempDir } from '../../helpers/cli.js';

/**
 * bin.ts is the process entry: it reads process.argv, installs SIGINT/SIGTERM
 * handlers and sets process.exitCode. Each test imports a fresh copy with a
 * controlled argv, captures the real stdout/stderr and restores everything.
 */

type Listener = (...args: unknown[]) => void;
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
let savedArgv: string[];
let savedListeners: Record<string, Listener[]>;
let out: string[];
let err: string[];

beforeEach(() => {
  vi.resetModules();
  savedArgv = process.argv;
  savedListeners = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s) as Listener[]]));
  process.exitCode = undefined;
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => out.push(String(chunk)) > 0);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => err.push(String(chunk)) > 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.argv = savedArgv;
  process.exitCode = undefined;
  for (const s of SIGNALS) for (const l of process.listeners(s)) if (!savedListeners[s]!.includes(l as Listener)) process.off(s, l);
});

/** Imports bin.ts with the given arguments; returns the signal handlers it installed. */
async function startBin(args: string[]): Promise<Record<(typeof SIGNALS)[number], Listener>> {
  process.argv = [process.argv[0]!, 'elpx-optimizer', ...args];
  await import('../../../src/cli/bin.ts');
  const added = (s: string): Listener => (process.listeners(s as 'SIGINT') as Listener[]).find((l) => !savedListeners[s]!.includes(l))!;
  return { SIGINT: added('SIGINT'), SIGTERM: added('SIGTERM') };
}

/** Waits until bin.ts has set process.exitCode. */
async function exitCode(): Promise<number> {
  await vi.waitFor(
    () => {
      if (process.exitCode === undefined) throw new Error('still running');
    },
    { timeout: 30_000, interval: 10 },
  );
  return Number(process.exitCode);
}

describe('bin.ts', () => {
  it('runs the CLI with process.argv and sets the exit code', async () => {
    const handlers = await startBin(['--version']);
    expect(await exitCode()).toBe(0);
    expect(out.join('')).toContain(`elpx-optimizer ${TOOL_VERSION}`);
    expect(typeof handlers.SIGINT).toBe('function');
    expect(handlers.SIGTERM).toBe(handlers.SIGINT);
  });

  it('propagates usage errors', async () => {
    await startBin(['frobnicate']);
    expect(await exitCode()).toBe(2);
    expect(err.join('')).toContain('Unknown command "frobnicate"');
  });

  it('exits 130 when interrupted during a failing command', async () => {
    const handlers = await startBin(['serve', '--root', '/nonexistent/web-root', '--port', '0']);
    handlers.SIGINT();
    expect(await exitCode()).toBe(130);
    expect(err.join('')).toContain('\nCancelling (press Ctrl+C again to force)...\n');
  });

  it('stops a server gracefully on the first signal and forces exit on the second', async () => {
    const dir = await tempDir('elpx-bin-');
    try {
      await mkdir(join(dir, 'web'));
      await writeFile(join(dir, 'web', 'index.html'), 'ok');
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const handlers = await startBin(['serve', '--root', join(dir, 'web'), '--port', '0']);
      await vi.waitFor(() => expect(err.join('')).toContain('Open http://127.0.0.1:'), { timeout: 10_000 });
      handlers.SIGTERM();
      expect(await exitCode()).toBe(0);
      expect(exit).not.toHaveBeenCalled();
      handlers.SIGINT();
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      await removeDir(dir);
    }
  });
});
