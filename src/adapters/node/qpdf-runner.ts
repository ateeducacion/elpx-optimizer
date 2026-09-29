/**
 * Child process that runs qpdf compiled to WebAssembly: the same build the
 * web app uses, run in its own process so the CLI applies a timeout and kills
 * it like any other tool. Self-contained on purpose (run directly by Node or
 * Bun from source, and bundled to qpdf-runner.mjs next to the CLI).
 *
 * Usage: qpdf-runner <input.pdf|-> <output.pdf|-> <qpdf arguments…>
 * The input is placed at /in.pdf and /out.pdf is copied to the output path.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import createModule from '@neslinesli93/qpdf-wasm';

interface QpdfInstance {
  callMain(args: string[]): number;
  FS: {
    init(input: null, output: (c: number | null) => void, error: (c: number | null) => void): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
}

const [input = '-', output = '-', ...args] = process.argv.slice(2);
const stdout: number[] = [];
const stderr: number[] = [];
const factory = createModule as unknown as (options: object) => Promise<QpdfInstance>;
// Under Node the module finds qpdf.wasm next to its own file (the build accepts no wasmBinary option).
const qpdf = await factory({
  noInitialRun: true,
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
if (input !== '-') qpdf.FS.writeFile('/in.pdf', readFileSync(input));
let code: number;
try {
  code = qpdf.callMain(args);
} catch (error) {
  const status = (error as { status?: unknown }).status;
  code = typeof status === 'number' ? status : 2;
  if (typeof status !== 'number') stderr.push(...Buffer.from(String(error)));
}
if (output !== '-') {
  try {
    writeFileSync(output, qpdf.FS.readFile('/out.pdf'));
  } catch {
    // No output written (a failure or an inspection run).
  }
}
process.stdout.write(Buffer.from(stdout));
process.stderr.write(Buffer.from(stderr));
process.exitCode = code;
