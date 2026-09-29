import { afterEach, describe, expect, it, vi } from 'vitest';
import efficientUrl from '../fixtures/elpx/efficient.elpx?url';
import pngUrl from '../fixtures/media/palette-efficient.png?url';
import type { App } from '../../src/web/app.js';
import type { PipelineClient } from '../../src/adapters/browser/pipeline-client.js';
import type { WorkerMessage } from '../../src/adapters/browser/protocol.js';
import type { ImageResponse } from '../../src/adapters/browser/image-pool.js';
import type { QpdfResult } from '../../src/core/media/engine.js';
import { fixtureBytes, fixtureFile, imageJobFor, waitFor } from './helpers.js';
import { craftPdf } from '../helpers/pdf-craft.js';

type AppWindow = Window & { elpxApp?: App };

/** The pipeline client behind an App (private field, reached for wiring checks). */
function clientOf(app: App): PipelineClient {
  return (app as unknown as { pipeline: PipelineClient }).pipeline;
}

describe('pipeline worker entry', () => {
  const previous = self.onmessage;

  afterEach(() => {
    self.onmessage = previous;
    vi.restoreAllMocks();
  });

  it('connects the worker scope to a pipeline handler', async () => {
    // On the main thread `self` is the window: capture what the entry posts back.
    const posted: WorkerMessage[] = [];
    vi.spyOn(window, 'postMessage').mockImplementation(((m: WorkerMessage) => posted.push(m)) as typeof window.postMessage);
    await import('../../src/adapters/browser/pipeline.worker.js');
    expect(typeof self.onmessage).toBe('function');
    self.onmessage!(new MessageEvent('message', { data: { type: 'plan', id: 1, options: {} } }));
    await waitFor(() => posted.length === 1, 5000, 'worker answer');
    expect(posted).toEqual([{ type: 'error', id: 1, code: 'internal', message: 'Analyze a project first' }]);
  });
});

describe('image worker entry', () => {
  const previous = self.onmessage;

  afterEach(() => {
    self.onmessage = previous;
    vi.restoreAllMocks();
  });

  it('runs requests with its own codecs and transfers the result', async () => {
    const posted: { response: ImageResponse; transfer: Transferable[] }[] = [];
    vi.spyOn(window, 'postMessage').mockImplementation(((response: ImageResponse, transfer: Transferable[]) =>
      posted.push({ response, transfer })) as unknown as typeof window.postMessage);
    await import('../../src/adapters/browser/image.worker.js');
    const png = await fixtureBytes(pngUrl);
    self.onmessage!(new MessageEvent('message', { data: { kind: 'encode', job: imageJobFor(png, 'png'), original: png } }));
    await waitFor(() => posted.length === 1, 30_000, 'image worker answer');
    const { response, transfer } = posted[0]!;
    expect(response).toMatchObject({ ok: true, kind: 'encode' });
    const encoded = (response as { encoded: Uint8Array }).encoded;
    expect(encoded.length).toBeGreaterThan(0);
    expect(transfer).toEqual([encoded.buffer]);
  });
});

describe('qpdf worker entry', () => {
  const previous = self.onmessage;

  afterEach(() => {
    self.onmessage = previous;
    vi.restoreAllMocks();
  });

  it('runs qpdf for each request and answers errors by id', async () => {
    const posted: { id: number; result?: QpdfResult; error?: string }[] = [];
    const transfers: Transferable[][] = [];
    vi.spyOn(window, 'postMessage').mockImplementation(((m: (typeof posted)[number], transfer: Transferable[] = []) => {
      posted.push(m);
      transfers.push(transfer);
    }) as unknown as typeof window.postMessage);
    await import('../../src/adapters/browser/pdf.worker.js');
    self.onmessage!(new MessageEvent('message', { data: { id: 1, args: ['--version'], input: new Uint8Array() } }));
    await waitFor(() => posted.length === 1, 30_000, 'qpdf worker answer');
    expect(posted[0]).toMatchObject({ id: 1, result: { code: 0 } });
    expect(transfers[0]).toEqual([]);
    // A rewrite answers with the new file, transferred.
    self.onmessage!(new MessageEvent('message', { data: { id: 3, args: ['/in.pdf', '/out.pdf'], input: craftPdf() } }));
    await waitFor(() => posted.length === 2, 30_000, 'qpdf worker rewrite');
    const output = posted[1]!.result!.output!;
    expect(new TextDecoder().decode(output.subarray(0, 5))).toBe('%PDF-');
    expect(transfers[1]).toEqual([output.buffer]);
    // Input that is not bytes cannot be written to qpdf's file system.
    self.onmessage!(new MessageEvent('message', { data: { id: 2, args: ['--check', '/in.pdf'], input: 42 } }));
    await waitFor(() => posted.length === 3, 30_000, 'qpdf worker error');
    expect(posted[2]!.id).toBe(2);
    expect(posted[2]!.error).toBeTruthy();
  });
});

describe('web entry', () => {
  afterEach(() => {
    document.getElementById('app')?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('boots the app over a real pipeline worker and analyzes a project end to end', async () => {
    const root = document.createElement('div');
    root.id = 'app';
    document.body.append(root);
    await import('../../src/web/main.js');
    const app = (window as AppWindow).elpxApp!;
    expect(app).toBeDefined();
    expect(root.querySelector('h1')).not.toBeNull();
    expect(root.querySelector('[data-testid="dropzone"]')).not.toBeNull();
    expect(getComputedStyle(root.querySelector('#file-input')!).position).toBe('absolute'); // styles.css is applied
    // Playback checks from the worker are answered with a real <video> element.
    expect(await clientOf(app).onPlaybackCheck!(new Blob(['x']), 'video/x-unknown')).toBe('unsupported');
    await app.start(await fixtureFile(efficientUrl, 'efficient.elpx'));
    expect(app.currentView).toBe('review');
    expect(root.querySelector('.inventory')).not.toBeNull();
    expect(root.querySelector('.engine-line')!.getAttribute('data-state')).toBe('ready');
    // The page follows the system colour scheme.
    expect(document.documentElement.dataset['bsTheme']).toBe(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    // Leaving the page stops the worker.
    const dispose = vi.spyOn(clientOf(app), 'dispose');
    window.dispatchEvent(new Event('pagehide'));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('applies ?threads and ?maxVideoMiB from the page URL', async () => {
    const { boot } = await import('../../src/web/main.js');
    const root = document.createElement('div');
    root.id = 'app';
    document.body.append(root);
    boot('?threads=single&maxVideoMiB=5');
    const app = (window as AppWindow).elpxApp!;
    const client = clientOf(app);
    expect(client.maxVideoBytes).toBe(5 * 1024 * 1024);
    const analyze = vi.spyOn(client, 'analyze').mockReturnValue(new Promise(() => undefined));
    void app.start(new File(['PK'], 'x.elpx'));
    expect(analyze).toHaveBeenCalledWith(expect.any(File), expect.any(Function), 'single');
    client.dispose();
    boot('?threads=bogus&maxVideoMiB=-1');
    const other = (window as AppWindow).elpxApp!;
    expect(other).not.toBe(app);
    expect(clientOf(other).maxVideoBytes).toBeUndefined();
    clientOf(other).dispose();
  });

  it('follows the system colour scheme with Bootstrap themes', async () => {
    const { followColorScheme } = await import('../../src/web/main.js');
    const listeners: { type: string; listener: () => void }[] = [];
    const media = {
      matches: false,
      addEventListener: (type: string, listener: () => void) => listeners.push({ type, listener }),
    };
    const target = document.createElement('div');
    followColorScheme(target, media as unknown as MediaQueryList);
    expect(target.dataset['bsTheme']).toBe('light');
    expect(listeners.map((l) => l.type)).toEqual(['change']);
    media.matches = true;
    listeners[0]!.listener();
    expect(target.dataset['bsTheme']).toBe('dark');
    media.matches = false;
    listeners[0]!.listener();
    expect(target.dataset['bsTheme']).toBe('light');
  });

  it('switches the compiled theme between light and dark', async () => {
    const { followColorScheme } = await import('../../src/web/main.js');
    const html = document.documentElement;
    const previous = html.dataset['bsTheme'];
    const media = { matches: true, addEventListener: () => undefined } as unknown as MediaQueryList;
    try {
      followColorScheme(html, media);
      expect(html.dataset['bsTheme']).toBe('dark');
      // The app background (styles.css) and Bootstrap's body colour (theme.scss) both switch.
      expect(getComputedStyle(document.body).backgroundColor).toBe('rgb(18, 21, 31)');
      expect(getComputedStyle(document.body).color).toBe('rgb(222, 226, 230)');
      followColorScheme(html, { ...media, matches: false } as unknown as MediaQueryList);
      expect(html.dataset['bsTheme']).toBe('light');
      expect(getComputedStyle(document.body).backgroundColor).toBe('rgb(243, 244, 248)');
      expect(getComputedStyle(document.body).color).toBe('rgb(29, 34, 51)');
    } finally {
      if (previous === undefined) delete html.dataset['bsTheme'];
      else html.dataset['bsTheme'] = previous;
    }
  });

  it('does nothing without a mount point, and falls back to navigator.language', async () => {
    const { boot } = await import('../../src/web/main.js');
    const before = (window as AppWindow).elpxApp;
    boot();
    expect((window as AppWindow).elpxApp).toBe(before);
    const root = document.createElement('div');
    root.id = 'app';
    document.body.append(root);
    vi.stubGlobal('navigator', { language: 'en-US' });
    boot();
    const app = (window as AppWindow).elpxApp!;
    expect(app).not.toBe(before);
    expect(document.documentElement.lang).toBe('en');
    clientOf(app).dispose();
  });
});
