/**
 * Selection of the ffmpeg.wasm core. The single-thread core is the baseline
 * and works without SharedArrayBuffer or COOP/COEP headers. The
 * multi-thread core is used only when the page is cross-origin isolated,
 * SharedArrayBuffer exists, enough cores are available and it was not
 * disabled.
 */

export interface FfmpegAssets {
  readonly single: { readonly core: string; readonly wasm: string };
  readonly multi: { readonly core: string; readonly wasm: string; readonly worker: string };
  readonly classWorker: string;
}

export type ThreadingPreference = 'auto' | 'single' | 'multi';

export interface ThreadingDecision {
  readonly mode: 'single' | 'multi';
  readonly reason: string;
  /** Encoder threads passed to FFmpeg (multi-thread core only). */
  readonly threads?: number;
}

export interface ThreadingEnvironment {
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly hardwareConcurrency: number;
  readonly deviceMemoryGiB: number | undefined;
}

/** Reads the current environment. */
export function currentEnvironment(): ThreadingEnvironment {
  const g = globalThis as unknown as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number; deviceMemory?: number } };
  return {
    crossOriginIsolated: g.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: g.navigator?.hardwareConcurrency ?? 1,
    deviceMemoryGiB: g.navigator?.deviceMemory,
  };
}

/** Decides which core to load. */
export function chooseThreading(pref: ThreadingPreference, env: ThreadingEnvironment): ThreadingDecision {
  if (pref === 'single') return { mode: 'single', reason: 'single-thread core selected' };
  if (!env.crossOriginIsolated) return { mode: 'single', reason: 'page is not cross-origin isolated (COOP/COEP headers not set)' };
  if (!env.sharedArrayBuffer) return { mode: 'single', reason: 'SharedArrayBuffer is not available' };
  if (env.hardwareConcurrency < 4) return { mode: 'single', reason: `only ${env.hardwareConcurrency} CPU cores` };
  if (env.deviceMemoryGiB !== undefined && env.deviceMemoryGiB < 4) return { mode: 'single', reason: `only ${env.deviceMemoryGiB} GiB of device memory` };
  return { mode: 'multi', reason: 'cross-origin isolated with enough cores', threads: Math.min(4, env.hardwareConcurrency - 1) };
}

/** Encoders compiled into the pinned @ffmpeg/core 0.12.10 (verified by test/browser). */
export const PINNED_CORE_ENCODERS = ['libx264', 'aac', 'libvpx-vp9', 'libopus'] as const;

/** Audio encoders of the same core used for audio files (verified by test/browser). */
export const PINNED_AUDIO_ENCODERS = ['libmp3lame', 'aac'] as const;

/** Parses `ffmpeg -encoders` output lines into encoder names (skipping the " V..... = Video" legend). */
export function parseEncoderList(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s[VAS][F.][S.][X.][B.][D.]\s+([^\s=]\S*)/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}
