import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import webmUrl from '../fixtures/media/sample.webm?url';
import mp4Url from '../fixtures/media/inefficient.mp4?url';
import toneOpusUrl from '../fixtures/media/tone-opus.webm?url';
import recordingUrl from '../fixtures/media/recording-opus.webm?url';
import tone320Url from '../fixtures/media/tone-320.mp3?url';
import { FFMPEG_ASSETS } from '../../src/adapters/browser/ffmpeg-assets.js';
import { checkPlayback } from '../../src/adapters/browser/playback.js';
import { fixtureBytes } from './helpers.js';

/** Extracts the audio track of a WebM with the real ffmpeg.wasm (no video stream). */
async function audioOnlyWebm(webm: Uint8Array): Promise<Blob> {
  const ff = new FFmpeg();
  await ff.load({ coreURL: FFMPEG_ASSETS.single.core, wasmURL: FFMPEG_ASSETS.single.wasm, classWorkerURL: FFMPEG_ASSETS.classWorker });
  try {
    await ff.writeFile('/in.webm', webm);
    const code = await ff.exec(['-hide_banner', '-i', '/in.webm', '-vn', '-c:a', 'copy', '/out.webm']);
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
    return new Blob([(await ff.readFile('/out.webm')) as Uint8Array<ArrayBuffer>], { type: 'audio/webm' });
  } finally {
    ff.terminate();
  }
}

describe('checkPlayback (main-thread <video>)', () => {
  let webm: Blob;

  beforeAll(async () => {
    webm = new Blob([(await fixtureBytes(webmUrl)) as Uint8Array<ArrayBuffer>], { type: 'video/webm' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports MIME types the browser cannot play as unsupported, without creating a URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    expect(await checkPlayback(webm, 'video/x-unknown-container')).toBe('unsupported');
    expect(create).not.toHaveBeenCalled();
  });

  it('plays a real WebM and revokes its object URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    expect(await checkPlayback(webm, 'video/webm')).toBe('playable');
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(create.mock.results[0]!.value);
  });

  it('plays H.264 MP4 only where the browser supports it', async () => {
    const mp4 = new Blob([(await fixtureBytes(mp4Url)) as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
    // Some Chromium builds ship without proprietary codecs.
    const supported = document.createElement('video').canPlayType('video/mp4') !== '';
    expect(await checkPlayback(mp4, 'video/mp4')).toBe(supported ? 'playable' : 'unsupported');
  });

  it('reports undecodable data as not playable', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    expect(await checkPlayback(new Blob([new Uint8Array(4096).fill(7)]), 'video/webm')).toBe('not-playable');
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('reports media without a video picture as not playable', async () => {
    const audio = await audioOnlyWebm(new Uint8Array(await webm.arrayBuffer()));
    expect(await checkPlayback(audio, 'video/webm')).toBe('not-playable');
  });

  it('gives up after the time limit', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    expect(await checkPlayback(webm, 'video/webm', 0)).toBe('not-playable');
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('ignores late media events once settled', async () => {
    const create = document.createElement.bind(document);
    let video: HTMLVideoElement | undefined;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'video') video = el as HTMLVideoElement;
      return el;
    }) as typeof document.createElement);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    expect(await checkPlayback(webm, 'video/webm')).toBe('playable');
    video!.dispatchEvent(new Event('error'));
    expect(revoke).toHaveBeenCalledTimes(1);
    // The element was never attached to the page.
    expect(video!.isConnected).toBe(false);
    expect(video!.hasAttribute('src')).toBe(false);
  });
});

describe('checkPlayback (main-thread <audio>)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Records the media elements the check creates. */
  function spyElements(): HTMLMediaElement[] {
    const create = document.createElement.bind(document);
    const made: HTMLMediaElement[] = [];
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (el instanceof HTMLMediaElement) made.push(el);
      return el;
    }) as typeof document.createElement);
    return made;
  }

  const blobOf = async (url: string, type: string): Promise<Blob> => new Blob([(await fixtureBytes(url)) as Uint8Array<ArrayBuffer>], { type });

  it('plays Opus audio in a detached <audio> element and revokes its URL', async () => {
    const made = spyElements();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    expect(await checkPlayback(await blobOf(toneOpusUrl, 'audio/webm'), 'audio/webm')).toBe('playable');
    expect(made.map((m) => m.tagName)).toEqual(['AUDIO']);
    expect(made[0]!.isConnected).toBe(false);
    expect(made[0]!.muted).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('accepts a browser recording, whose duration is infinite until read to the end', async () => {
    expect(await checkPlayback(await blobOf(recordingUrl, 'audio/webm'), 'audio/webm')).toBe('playable');
  });

  it('plays MP3 where the browser supports it', async () => {
    const supported = document.createElement('audio').canPlayType('audio/mpeg') !== '';
    expect(await checkPlayback(await blobOf(tone320Url, 'audio/mpeg'), 'audio/mpeg')).toBe(supported ? 'playable' : 'unsupported');
  });

  it('reports undecodable audio, and audio without a duration, as not playable', async () => {
    expect(await checkPlayback(new Blob([new Uint8Array(4096).fill(7)]), 'audio/webm')).toBe('not-playable');
    // Data reported loaded before any duration is known (NaN) is not a decoded file.
    const made = spyElements();
    const pending = checkPlayback(await blobOf(toneOpusUrl, 'audio/webm'), 'audio/webm');
    made[0]!.dispatchEvent(new Event('loadeddata'));
    expect(await pending).toBe('not-playable');
  });
});
