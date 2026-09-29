import { CancelledError } from './errors.js';

/**
 * Minimal structural view of AbortSignal so the core does not depend on DOM or
 * Node typings. Any real AbortSignal satisfies this interface.
 */
export interface CancelSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Throws CancelledError when the signal has been aborted. */
export function throwIfCancelled(signal: CancelSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

/**
 * Registers a cancellation callback and returns a disposer. The callback runs
 * immediately when the signal is already aborted.
 */
export function onCancel(signal: CancelSignal | undefined, callback: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    callback();
    return () => undefined;
  }
  const listener = (): void => callback();
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}
