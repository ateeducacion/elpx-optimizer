import { beforeEach, describe, expect, it } from 'vitest';
import { runQpdfWasm, type QpdfFactory, type QpdfInstance } from '../../src/adapters/browser/qpdf-wasm.js';

/**
 * The paths of runQpdfWasm that the real qpdf does not take on demand: exits
 * through Emscripten's ExitStatus and crashes (a WebAssembly trap), with a
 * scripted instance in place of the module.
 */
type Streams = { out: (c: number | null) => void; err: (c: number | null) => void; files: Map<string, Uint8Array> };

const script: { callMain: (s: Streams) => number; options?: Record<string, unknown> } = { callMain: () => 0 };

const factory: QpdfFactory = async (options: object) => {
  const o = options as { preRun: ((m: QpdfInstance) => void)[] } & Record<string, unknown>;
  script.options = o;
  const streams: Streams = { out: () => undefined, err: () => undefined, files: new Map() };
  const instance: QpdfInstance = {
    FS: {
      init: (_input, out, err) => void Object.assign(streams, { out, err }),
      writeFile: (path, data) => void streams.files.set(path, data),
      readFile: (path) => {
        const file = streams.files.get(path);
        if (!file) throw new Error(`ENOENT ${path}`);
        return file;
      },
    },
    callMain: () => script.callMain(streams),
  };
  for (const f of o.preRun) f(instance);
  return instance;
};

const emit = (write: (c: number | null) => void, text: string): void => {
  for (const c of new TextEncoder().encode(text)) write(c);
  write(null);
};

describe('runQpdfWasm with a scripted module', () => {
  beforeEach(() => {
    script.callMain = () => 0;
  });

  it('locates the module at the given URL and returns the output file and streams', async () => {
    script.callMain = ({ out, err, files }) => {
      expect(files.get('/in.pdf')).toEqual(new Uint8Array([1, 2]));
      emit(out, 'done');
      emit(err, 'warning');
      files.set('/out.pdf', new Uint8Array([9]));
      return 3;
    };
    const r = await runQpdfWasm('blob:qpdf', ['/in.pdf', '/out.pdf'], new Uint8Array([1, 2]), factory);
    expect(r).toEqual({ code: 3, stdout: 'done', stderr: 'warning', output: new Uint8Array([9]) });
    expect((script.options!['locateFile'] as () => string)()).toBe('blob:qpdf');
    expect(script.options!['noInitialRun']).toBe(true);
  });

  it('takes the exit code of an ExitStatus', async () => {
    script.callMain = ({ err }) => {
      emit(err, 'usage');
      throw Object.assign(new Error('ExitStatus'), { status: 2 });
    };
    expect(await runQpdfWasm('blob:qpdf', ['--bad'], new Uint8Array(), factory)).toEqual({ code: 2, stdout: '', stderr: 'usage' });
  });

  it('reports a crash as exit 2 with its message', async () => {
    script.callMain = () => {
      throw new Error('RuntimeError: unreachable');
    };
    const r = await runQpdfWasm('blob:qpdf', ['/in.pdf', '/out.pdf'], new Uint8Array(), factory);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('Error: RuntimeError: unreachable');
    expect(r.output).toBeUndefined();
  });
});
