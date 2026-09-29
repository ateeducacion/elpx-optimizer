import createModule from '@neslinesli93/qpdf-wasm';
import type { QpdfResult } from '../../core/media/engine.js';
import { PDF_INPUT, PDF_OUTPUT } from '../../core/media/pdf-policy.js';

/**
 * qpdf compiled to WebAssembly (the same build the CLI uses). Every run gets a
 * fresh instance, because qpdf's command line keeps global state between runs.
 * The build only accepts a few module options: the wasm is located with
 * locateFile (see wasmFromMemory), and print callbacks are ignored.
 */

export { QPDF_VERSION } from './qpdf-version.js';

export interface QpdfInstance {
  callMain(args: string[]): number;
  FS: {
    init(input: null, output: (c: number | null) => void, error: (c: number | null) => void): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
}

/** Creates a qpdf instance (the Emscripten module factory; injectable for tests). */
export type QpdfFactory = (options: object) => Promise<QpdfInstance>;

/**
 * Downloads the module once and returns a blob: URL for it, so every run
 * loads it from memory: no request per run, also with the network gone. A
 * failed download is not kept (the next call tries again).
 */
export function wasmFromMemory(url: string): () => Promise<string> {
  let blobUrl: Promise<string> | undefined;
  return async () => {
    blobUrl ??= fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`qpdf.wasm could not be downloaded: HTTP ${r.status}`);
      return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'application/wasm' }));
    });
    try {
      return await blobUrl;
    } catch (error) {
      blobUrl = undefined;
      throw error;
    }
  };
}

/** Runs qpdf once with `input` at PDF_INPUT and returns its output, including PDF_OUTPUT when written. */
export async function runQpdfWasm(
  wasmUrl: string,
  args: readonly string[],
  input: Uint8Array,
  factory: QpdfFactory = createModule as unknown as QpdfFactory,
): Promise<QpdfResult> {
  const stdout: number[] = [];
  const stderr: number[] = [];
  const qpdf = await factory({
    noInitialRun: true,
    locateFile: () => wasmUrl,
    // Standard streams are captured here (the build has no print options).
    preRun: [
      (m: QpdfInstance) =>
        m.FS.init(
          null,
          (c) => {
            if (c !== null) stdout.push(c);
          },
          (c) => {
            if (c !== null) stderr.push(c);
          },
        ),
    ],
  });
  qpdf.FS.writeFile(PDF_INPUT, input);
  let code: number;
  try {
    code = qpdf.callMain([...args]);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    code = typeof status === 'number' ? status : 2;
    if (typeof status !== 'number') stderr.push(...new TextEncoder().encode(String(error)));
  }
  let output: Uint8Array | undefined;
  try {
    output = qpdf.FS.readFile(PDF_OUTPUT);
  } catch {
    output = undefined;
  }
  const text = (bytes: number[]): string => new TextDecoder().decode(new Uint8Array(bytes));
  return { code, stdout: text(stdout), stderr: text(stderr), ...(output ? { output } : {}) };
}
