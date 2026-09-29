import { describe, expect, it } from 'vitest';
import videoUrl from '../fixtures/media/inefficient.mp4?url';
import { FFMPEG_ASSETS } from '../../src/adapters/browser/ffmpeg-assets.js';
import { BrowserMediaEngine } from '../../src/adapters/browser/browser-media-engine.js';
import { BlobStore } from '../../src/adapters/browser/blob-io.js';

describe('ffmpeg.wasm in vitest browser mode', () => {
  it('loads the pinned core and probes a video', async () => {
    const store = new BlobStore();
    const engine = new BrowserMediaEngine({ store, assets: FFMPEG_ASSETS, threading: 'single' });
    const blob = await (await fetch(videoUrl)).blob();
    const res = store.adopt(blob, 'mp4');
    const probe = await engine.probe(res, { resourcePath: 'v.mp4', timeoutMs: 120_000 });
    expect(probe.streams.map((s) => s.codec)).toEqual(['h264', 'aac']);
    expect(engine.encodersFromCore).toEqual(expect.arrayContaining(['libx264', 'aac', 'libvpx-vp9', 'libopus']));
    await engine.dispose();
  });
});
