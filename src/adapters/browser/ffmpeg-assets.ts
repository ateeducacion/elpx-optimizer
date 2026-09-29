/**
 * Same-origin URLs of the pinned ffmpeg.wasm artefacts, emitted by Vite into
 * the static build (never fetched from a CDN). Kept in a separate module so
 * the engine itself can be tested with injected URLs.
 */
import stCore from '@ffmpeg/core?url';
import stWasm from '@ffmpeg/core/wasm?url';
import mtCore from '@ffmpeg/core-mt?url';
import mtWasm from '@ffmpeg/core-mt/wasm?url';
import mtWorker from '@ffmpeg/core-mt/worker?url';
import classWorker from '@ffmpeg/ffmpeg/worker?worker&url';
import type { FfmpegAssets } from './ffmpeg-loader.js';

/** Resolves a Vite asset URL against the current module (works under any base path). */
function abs(url: string): string {
  return new URL(url, import.meta.url).href;
}

export const FFMPEG_ASSETS: FfmpegAssets = {
  single: { core: abs(stCore), wasm: abs(stWasm) },
  multi: { core: abs(mtCore), wasm: abs(mtWasm), worker: abs(mtWorker) },
  classWorker: abs(classWorker),
};
