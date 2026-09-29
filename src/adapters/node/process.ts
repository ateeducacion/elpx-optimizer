import { spawn } from 'node:child_process';
import { ElpxError, CancelledError } from '../../core/errors.js';
import { onCancel, type CancelSignal } from '../../core/cancel.js';

/** Options for running an external tool. */
export interface RunOptions {
  cwd?: string;
  /** Environment for the child; defaults to a minimal PATH-only environment. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: CancelSignal;
  /** Called for each complete stdout line (used for -progress output). */
  onStdoutLine?: (line: string) => void;
  /** Maximum captured bytes per stream; the rest is discarded. */
  maxCaptureBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an argument vector (never through a shell). The child
 * gets its own process group so cancellation and timeouts terminate the
 * whole tree (SIGTERM, then SIGKILL after a grace period).
 */
export function runProcess(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const max = options.maxCaptureBytes ?? 4 * 1024 * 1024;
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      reject(new ElpxError('media-engine-unavailable', `Cannot start ${command}: ${(error as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reason: 'timeout' | 'cancel' | undefined;
    const killTree = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already exited
      }
    };
    const terminate = (why: 'timeout' | 'cancel'): void => {
      if (reason) return;
      reason = why;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 3000);
      killTimer.unref?.();
    };
    const timer = options.timeoutMs ? setTimeout(() => terminate('timeout'), options.timeoutMs) : undefined;
    timer?.unref?.();
    const disposeCancel = onCancel(options.signal, () => terminate('cancel'));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < max) stdout += d.slice(0, max - stdout.length);
      if (options.onStdoutLine) {
        pending += d;
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          options.onStdoutLine(pending.slice(0, nl).replace(/\r$/, ''));
          pending = pending.slice(nl + 1);
        }
      }
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < max) stderr += d.slice(0, max - stderr.length);
    });
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      disposeCancel();
      fn();
    };
    child.on('error', (error) => {
      finish(() => reject(new ElpxError('media-engine-unavailable', `Cannot run ${command}: ${error.message}`)));
    });
    child.on('close', (code, sig) => {
      finish(() => {
        if (reason === 'cancel') reject(new CancelledError());
        else if (reason === 'timeout') reject(new ElpxError('media-failed', `${command} exceeded the time limit`));
        else resolve({ code, signal: sig, stdout, stderr });
      });
    });
  });
}
