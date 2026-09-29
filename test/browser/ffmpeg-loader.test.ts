import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseThreading,
  currentEnvironment,
  parseEncoderList,
  PINNED_CORE_ENCODERS,
  type ThreadingEnvironment,
} from '../../src/adapters/browser/ffmpeg-loader.js';
import { FFMPEG_ASSETS } from '../../src/adapters/browser/ffmpeg-assets.js';

const capable: ThreadingEnvironment = { crossOriginIsolated: true, sharedArrayBuffer: true, hardwareConcurrency: 8, deviceMemoryGiB: 8 };

describe('chooseThreading', () => {
  it('honours an explicit single-thread preference', () => {
    expect(chooseThreading('single', capable)).toEqual({ mode: 'single', reason: 'single-thread core selected' });
  });

  it('falls back to the single-thread core for every missing requirement', () => {
    expect(chooseThreading('auto', { ...capable, crossOriginIsolated: false }).reason).toMatch(/not cross-origin isolated/);
    expect(chooseThreading('multi', { ...capable, sharedArrayBuffer: false }).reason).toMatch(/SharedArrayBuffer/);
    expect(chooseThreading('auto', { ...capable, hardwareConcurrency: 2 })).toEqual({ mode: 'single', reason: 'only 2 CPU cores' });
    expect(chooseThreading('auto', { ...capable, deviceMemoryGiB: 2 })).toEqual({ mode: 'single', reason: 'only 2 GiB of device memory' });
  });

  it('uses the multi-thread core with a bounded thread count', () => {
    expect(chooseThreading('auto', capable)).toEqual({ mode: 'multi', reason: 'cross-origin isolated with enough cores', threads: 4 });
    expect(chooseThreading('multi', { ...capable, hardwareConcurrency: 4, deviceMemoryGiB: undefined })).toMatchObject({ mode: 'multi', threads: 3 });
  });
});

describe('currentEnvironment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the real page environment', () => {
    const env = currentEnvironment();
    expect(env.crossOriginIsolated).toBe(globalThis.crossOriginIsolated === true);
    expect(env.sharedArrayBuffer).toBe(typeof SharedArrayBuffer !== 'undefined');
    expect(env.hardwareConcurrency).toBe(navigator.hardwareConcurrency);
  });

  it('defaults when navigator details are missing', () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('crossOriginIsolated', true);
    expect(currentEnvironment()).toMatchObject({ crossOriginIsolated: true, hardwareConcurrency: 1, deviceMemoryGiB: undefined });
    vi.stubGlobal('navigator', undefined);
    expect(currentEnvironment().hardwareConcurrency).toBe(1);
  });
});

describe('parseEncoderList', () => {
  it('extracts encoder names from `ffmpeg -encoders` lines', () => {
    const lines = [
      'Encoders:',
      ' V..... = Video',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC',
      ' A....D aac                  AAC (Advanced Audio Coding)',
      ' S..... mov_text             3GPP Timed Text subtitle',
      ' VF.X.. something            frame-threaded experimental',
      'not an encoder line',
    ];
    expect(parseEncoderList(lines)).toEqual(['libx264', 'aac', 'mov_text', 'something']);
    expect(parseEncoderList([])).toEqual([]);
  });

  it('pins the encoders compiled into the bundled core', () => {
    expect([...PINNED_CORE_ENCODERS]).toEqual(['libx264', 'aac', 'libvpx-vp9', 'libopus']);
  });
});

describe('ffmpeg assets', () => {
  it('resolves every core artefact to a same-origin absolute URL', () => {
    const urls = [
      FFMPEG_ASSETS.single.core,
      FFMPEG_ASSETS.single.wasm,
      FFMPEG_ASSETS.multi.core,
      FFMPEG_ASSETS.multi.wasm,
      FFMPEG_ASSETS.multi.worker,
      FFMPEG_ASSETS.classWorker,
    ];
    for (const u of urls) expect(new URL(u).origin).toBe(location.origin);
    expect(FFMPEG_ASSETS.single.wasm).toMatch(/\.wasm/);
  });
});
