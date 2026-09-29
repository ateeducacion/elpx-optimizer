import { FFMPEG_ASSETS } from './ffmpeg-assets.js';
import { createPipelineHandler } from './pipeline-handler.js';
import type { ClientMessage, WorkerMessage } from './protocol.js';

/**
 * Pipeline worker entry: ZIP reading, analysis, image codecs and packaging
 * run here; FFmpeg runs in its own nested worker. Only this thin wiring is
 * worker-specific.
 */
const scope = self as unknown as { postMessage(m: WorkerMessage): void; onmessage: ((e: MessageEvent<ClientMessage>) => void) | null };
const handle = createPipelineHandler({ assets: FFMPEG_ASSETS }, (m) => scope.postMessage(m));
scope.onmessage = (e) => {
  void handle(e.data);
};
