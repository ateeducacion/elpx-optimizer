/// <reference lib="webworker" />
import wasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import { runQpdfWasm, wasmFromMemory } from './qpdf-wasm.js';

/**
 * Dedicated worker that runs qpdf (WebAssembly) for the pipeline worker, so
 * a long rewrite can be stopped by terminating it. Thin wiring: the logic is
 * in qpdf-wasm.ts.
 */
export interface PdfRequest {
  readonly id: number;
  readonly args: readonly string[];
  readonly input: Uint8Array;
}

const wasm = wasmFromMemory(new URL(wasmUrl, self.location.href).href);

self.onmessage = async (e: MessageEvent<PdfRequest>) => {
  const { id, args, input } = e.data;
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  try {
    const result = await runQpdfWasm(await wasm(), args, input);
    scope.postMessage({ id, result }, result.output ? [result.output.buffer as ArrayBuffer] : []);
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
};
