import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { runProcess } from '../../../src/adapters/node/process.js';
import { CancelledError, ElpxError } from '../../../src/core/errors.js';

const NODE = process.execPath;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

/** Pretends to run on another OS for the duration of a test. */
function fakePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
}

/** True while a process with this pid exists (zombies included). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when perl is available (used to leave the process group). */
function hasPerl(): boolean {
  try {
    execFileSync('perl', ['-e', '1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('runProcess', () => {
  it('returns the exit code, captured output and complete stdout lines', async () => {
    const lines: string[] = [];
    const result = await runProcess(
      NODE,
      ['-e', 'process.stdout.write("a\\r\\nb\\n"); process.stdout.write("tail"); process.stderr.write("err"); process.exit(3)'],
      {
        onStdoutLine: (l) => lines.push(l),
      },
    );
    expect(result).toEqual({ code: 3, signal: null, stdout: 'a\r\nb\ntail', stderr: 'err' });
    expect(lines).toEqual(['a', 'b']);
  });

  it('passes arguments as a vector, never through a shell', async () => {
    const result = await runProcess(NODE, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', '$(echo x)', '"q"']);
    expect(JSON.parse(result.stdout)).toEqual(['a b', '$(echo x)', '"q"']);
  });

  it('uses a minimal environment by default and an explicit one when given', async () => {
    process.env['ELPX_TEST_SECRET'] = 'leak';
    try {
      const dump = ['-e', 'console.log(JSON.stringify(process.env))'];
      const minimal = JSON.parse((await runProcess(NODE, dump)).stdout) as Record<string, string>;
      expect(minimal['ELPX_TEST_SECRET']).toBeUndefined();
      expect(minimal['LANG']).toBe('C');
      expect(minimal['PATH']).toBe(process.env['PATH']);
      const custom = JSON.parse((await runProcess(NODE, dump, { env: { ONLY: '1' } })).stdout) as Record<string, string>;
      expect(custom['ONLY']).toBe('1');
      expect(custom['LANG']).toBeUndefined();
    } finally {
      delete process.env['ELPX_TEST_SECRET'];
    }
  });

  it('falls back to a standard PATH when the parent has none', async () => {
    const saved = process.env['PATH'];
    delete process.env['PATH'];
    try {
      const result = await runProcess(NODE, ['-e', 'console.log(process.env.PATH)']);
      expect(result.stdout.trim()).toBe('/usr/bin:/bin');
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('runs in the given working directory', async () => {
    const result = await runProcess(NODE, ['-e', 'console.log(process.cwd())'], { cwd: '/' });
    expect(result.stdout.trim()).toBe('/');
  });

  it('caps the captured output of each stream', async () => {
    const result = await runProcess(NODE, ['-e', 'process.stdout.write("x".repeat(100)); process.stderr.write("y".repeat(100))'], { maxCaptureBytes: 10 });
    expect(result.stdout).toBe('x'.repeat(10));
    expect(result.stderr).toBe('y'.repeat(10));
  });

  it('keeps discarding output once the cap is reached', async () => {
    const script =
      'process.stdout.write("x".repeat(20)); process.stderr.write("y".repeat(20)); setTimeout(() => { process.stdout.write("z"); process.stderr.write("z"); }, 50)';
    const result = await runProcess(NODE, ['-e', script], { maxCaptureBytes: 10 });
    expect(result.stdout).toBe('x'.repeat(10));
    expect(result.stderr).toBe('y'.repeat(10));
  });

  it('keeps the first reason when both a timeout and a cancel happen', async () => {
    const controller = new AbortController();
    // The child ignores SIGTERM, so it lives until SIGKILL (3 s after the first request): the
    // cancel (on "ready") and the timeout both arrive while it runs, in whichever order.
    const script = 'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => {}, 20000)';
    const pending = runProcess(NODE, ['-e', script], { timeoutMs: 1500, signal: controller.signal, onStdoutLine: () => controller.abort() });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElpxError);
    expect(['cancelled', 'media-failed']).toContain((error as ElpxError).code);
  });

  it('kills a process that exceeds its time limit', async () => {
    const started = Date.now();
    const error = await runProcess(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElpxError);
    expect((error as ElpxError).code).toBe('media-failed');
    expect((error as ElpxError).message).toMatch(/exceeded the time limit/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('rejects with CancelledError when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = runProcess(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('does not start work for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it('kills the whole process group, escalating to SIGKILL for children that ignore SIGTERM', async () => {
    const controller = new AbortController();
    let grandchild = 0;
    const script = 'trap "" TERM; sleep 30 & echo $!; wait; wait';
    const pending = runProcess('/bin/sh', ['-c', script], {
      signal: controller.signal,
      onStdoutLine: (line) => {
        grandchild = Number(line);
        controller.abort();
      },
    });
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(grandchild).toBeGreaterThan(0);
    // Its parent was killed too: until init reaps it, the grandchild is a zombie that kill(pid, 0) still finds.
    const deadline = Date.now() + 5000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(alive(grandchild)).toBe(false);
  });

  it.runIf(hasPerl())('tolerates a process group that is already gone', async () => {
    const controller = new AbortController();
    const pending = runProcess('perl', ['-e', 'use POSIX; POSIX::setsid(); $| = 1; print "ready\\n"; sleep 1'], {
      signal: controller.signal,
      onStdoutLine: () => controller.abort(),
    });
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('reports a command that cannot be started', async () => {
    const error = await runProcess('/nonexistent/elpx-tool', []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElpxError);
    expect((error as ElpxError).code).toBe('media-engine-unavailable');
    expect((error as ElpxError).message).toMatch(/^Cannot run \/nonexistent\/elpx-tool/);
  });

  it('reports a spawn that fails synchronously', async () => {
    const error = await runProcess('bad\0name', []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElpxError);
    expect((error as ElpxError).message).toMatch(/^Cannot start bad/);
  });

  it('ignores cancellation of a command that never started', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await runProcess('/nonexistent/elpx-tool', [], { signal: controller.signal }).catch((e: unknown) => e);
    expect((error as ElpxError).message).toMatch(/^Cannot run/);
  });

  it('kills only the child on Windows (no process groups)', async () => {
    fakePlatform('win32');
    const controller = new AbortController();
    const pending = runProcess(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });
});
