import '@fontsource/atkinson-hyperlegible/latin-400.css';
import '@fontsource/atkinson-hyperlegible/latin-700.css';
import './styles.css';
import { PipelineClient, type WorkerLike } from '../adapters/browser/pipeline-client.js';
import { checkPlayback } from '../adapters/browser/playback.js';
import { App } from './app.js';
import { detectLang } from './i18n.js';
import { readUrlSettings } from './url-settings.js';

/** Boots the application: the pipeline worker and the UI (exported for tests). */
export function boot(search = location.search): void {
  const root = document.getElementById('app');
  if (!root) return;
  const settings = readUrlSettings(search);
  const client = new PipelineClient(
    () => new Worker(new URL('../adapters/browser/pipeline.worker.ts', import.meta.url), { type: 'module', name: 'elpx-pipeline' }) as unknown as WorkerLike,
  );
  client.onPlaybackCheck = (blob, mime) => checkPlayback(blob, mime);
  client.maxVideoBytes = settings.maxVideoBytes;
  const app = new App(root, client, detectLang(navigator.languages ?? [navigator.language]), URL, settings);
  app.mount();
  window.addEventListener('pagehide', () => client.dispose());
  (window as unknown as { elpxApp?: App }).elpxApp = app;
}

boot();
