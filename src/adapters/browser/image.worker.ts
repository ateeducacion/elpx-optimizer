import { createJsquashCodecs } from './image-codecs.js';
import { runImageRequest, type ImageRequest, type ImageResponse } from './image-pool.js';

/**
 * Image worker entry: one set of WASM codecs per worker; the ImagePool sends
 * one job at a time. Only this thin wiring is worker-specific.
 */
const scope = self as unknown as { postMessage(m: ImageResponse, transfer: Transferable[]): void; onmessage: ((e: MessageEvent<ImageRequest>) => void) | null };
const codecs = createJsquashCodecs();
scope.onmessage = (e) => {
  void runImageRequest(codecs, e.data).then(({ response, transfer }) => scope.postMessage(response, transfer));
};
