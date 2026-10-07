import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNotInput, defaultOutputPath, intFlag, limitsFromFlags, openInputArg, progressPrinter } from '../../../src/cli/shared.js';
import { logger, printJson, progressLine } from '../../../src/cli/io.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { ElpxError } from '../../../src/core/errors.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import type { ProgressEvent } from '../../../src/core/media/engine.js';
import { captureIO, removeDir, tempDir } from '../../helpers/cli.js';

let dir: string;

beforeEach(async () => {
  dir = await tempDir('elpx-shared-');
});
afterEach(async () => {
  vi.useRealTimers();
  await removeDir(dir);
});

/** Error thrown by a function or promise. */
async function failure(run: () => unknown): Promise<ElpxError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ElpxError);
    return error as ElpxError;
  }
  throw new Error('expected a failure');
}

describe('exit codes', () => {
  it('match the documented values', () => {
    expect(EXIT).toEqual({ SUCCESS: 0, FAILURE: 1, USAGE: 2, INVALID_INPUT: 3, PARTIAL: 4, DEPENDENCY: 5, CANCELLED: 130 });
  });
});

describe('io helpers', () => {
  it('prints one indented JSON document per call', () => {
    const { io, out } = captureIO();
    printJson(io, { a: [1] });
    expect(out).toEqual(['{\n  "a": [\n    1\n  ]\n}\n']);
  });

  it('logs to stderr unless quiet', () => {
    const { io, err } = captureIO();
    logger(io, false)('hello');
    logger(io, true)('hidden');
    expect(err).toEqual(['hello\n']);
  });
});

describe('intFlag', () => {
  it('parses integers within range', () => {
    expect(intFlag({}, 'threads', 1, 4)).toBeUndefined();
    expect(intFlag({ threads: '4' }, 'threads', 1, 4)).toBe(4);
    expect(intFlag({ threads: '1' }, 'threads', 1, 4)).toBe(1);
  });

  it.each(['0', '5', '1.5', 'abc', ''])('rejects %j', async (raw) => {
    const error = await failure(() => intFlag({ threads: raw }, 'threads', 1, 4));
    expect(error.code).toBe('invalid-options');
    expect(error.message).toBe('--threads must be an integer between 1 and 4');
  });
});

describe('limitsFromFlags', () => {
  it('keeps the native defaults without flags', () => {
    expect(limitsFromFlags({})).toEqual(NATIVE_LIMITS);
  });

  it('applies size and time overrides', () => {
    const limits = limitsFromFlags({ 'max-archive-size': '1000', 'max-video-size': '500', 'timeout-video': '60' });
    expect(limits.maxArchiveBytes).toBe(1000);
    expect(limits.maxVideoBytes).toBe(500);
    expect(limits.videoTimeoutMs).toBe(60_000);
  });

  it('rejects invalid limits', async () => {
    await expect(failure(() => limitsFromFlags({ 'timeout-video': '0' }))).resolves.toMatchObject({ code: 'invalid-options' });
    await expect(failure(() => limitsFromFlags({ 'max-archive-size': '-1' }))).resolves.toMatchObject({ code: 'invalid-options' });
  });
});

describe('openInputArg', () => {
  it('resolves the input against the working directory', async () => {
    await writeFile(join(dir, 'curso ñ.elpx'), 'PK');
    const { io } = captureIO({ cwd: dir });
    const input = await openInputArg(['curso ñ.elpx'], io);
    expect(input.path).toBe(join(dir, 'curso ñ.elpx'));
    expect(input.name).toBe('curso ñ.elpx');
    expect(input.source.size).toBe(2);
    await input.source.close();
  });

  it('requires exactly one argument', async () => {
    const { io } = captureIO();
    expect((await failure(() => openInputArg([], io))).message).toBe('Expected exactly one input file');
    expect((await failure(() => openInputArg(['a', 'b'], io))).code).toBe('invalid-options');
  });
});

describe('defaultOutputPath', () => {
  it('derives <name>_optimized.elpx next to the input', () => {
    expect(defaultOutputPath('/a/b/curso.elpx')).toBe('/a/b/curso_optimized.elpx');
    expect(defaultOutputPath('/a/b/Curso Ñ.ELP')).toBe('/a/b/Curso Ñ_optimized.elpx');
    expect(defaultOutputPath('/a/b/export.zip')).toBe('/a/b/export_optimized.elpx');
    expect(defaultOutputPath('/a/b/curso.v2.bin')).toBe('/a/b/curso.v2.bin_optimized.elpx');
    expect(defaultOutputPath('/a/b/noext')).toBe('/a/b/noext_optimized.elpx');
  });
});

describe('assertNotInput', () => {
  it('accepts a different or not yet existing output', async () => {
    await writeFile(join(dir, 'in.elpx'), 'x');
    await writeFile(join(dir, 'other.elpx'), 'x');
    await assertNotInput(join(dir, 'in.elpx'), join(dir, 'out.elpx'));
    await assertNotInput(join(dir, 'in.elpx'), join(dir, 'other.elpx'));
  });

  it('refuses the input path itself, also spelled differently', async () => {
    await writeFile(join(dir, 'in.elpx'), 'x');
    const error = await failure(() => assertNotInput(join(dir, 'in.elpx'), join(dir, '.', 'sub', '..', 'in.elpx')));
    expect(error).toMatchObject({ code: 'invalid-options', message: 'The output must not be the input file' });
  });

  it('refuses a symbolic link to the input', async () => {
    await writeFile(join(dir, 'in.elpx'), 'x');
    await symlink(join(dir, 'in.elpx'), join(dir, 'link.elpx'));
    expect((await failure(() => assertNotInput(join(dir, 'in.elpx'), join(dir, 'link.elpx')))).message).toBe('The output must not be the input file');
  });

  it('refuses a hard link to the input', async () => {
    await writeFile(join(dir, 'in.elpx'), 'x');
    await link(join(dir, 'in.elpx'), join(dir, 'hard.elpx'));
    expect((await failure(() => assertNotInput(join(dir, 'in.elpx'), join(dir, 'hard.elpx')))).message).toBe('The output is a link to the input file');
  });
});

describe('progressPrinter', () => {
  /** Feeds events at the given times (ms) and returns what was printed. */
  function feed(events: [number, ProgressEvent][], quiet = false): string[] {
    const { io, err } = captureIO();
    const print = progressPrinter(io, quiet);
    vi.useFakeTimers();
    for (const [time, event] of events) {
      vi.setSystemTime(time);
      print(event);
    }
    return err;
  }

  it('prints nothing when quiet', () => {
    expect(feed([[0, { stage: 'read' }]], true)).toEqual([]);
  });

  it('describes every stage', () => {
    const lines = feed([
      [0, { stage: 'read' }],
      [1, { stage: 'analyze', item: 1, items: 3 }],
      [1, { stage: 'duplicates', resource: 'b.mp4', fraction: 0.426 }],
      [2, { stage: 'probe', item: 1, items: 1, resource: 'v.mp4' }],
      [3, { stage: 'transcode', resource: 'v.mp4', processedSeconds: 1.25, totalSeconds: 4 }],
      [4, { stage: 'encode-image', item: 2, items: 5 }],
      [5, { stage: 'package', item: 1, items: 9 }],
      [6, { stage: 'verify', message: 'Re-opening' }],
      [7, { stage: 'extract', resource: 'a.png', item: 1, items: 2 }],
      [8, { stage: 'engine-load' }],
      [9, { stage: 'done' }],
    ]);
    expect(lines).toEqual([
      'Reading input\n',
      'Checking entries [1/3]\n',
      'Comparing duplicates b.mp4 43%\n',
      'Inspecting media [1/1] v.mp4\n',
      'Transcoding v.mp4 1.3/4.0 s\n',
      'Images [2/5]\n',
      'Packaging [1/9]\n',
      'verify: Re-opening\n',
      'extract [1/2] a.png\n',
      'engine-load\n',
    ]);
  });

  it('omits unknown durations and resources', () => {
    expect(feed([[0, { stage: 'transcode' }]])).toEqual(['Transcoding \n']);
    expect(feed([[0, { stage: 'transcode', resource: 'v.mp4', processedSeconds: 2 }]])).toEqual(['Transcoding v.mp4\n']);
    expect(feed([[0, { stage: 'probe' }]])).toEqual(['Inspecting media \n']);
  });

  it('redraws a single line in a terminal, cleared before any other output (#36)', () => {
    const { io, out, err } = captureIO({ interactive: true });
    const tty = progressLine(io);
    const print = progressPrinter(tty, false);
    print({ stage: 'read' });
    print({ stage: 'package', item: 1, items: 2 });
    tty.stderr('Plan: 1 operations\n');
    tty.stdout('Summary\n');
    tty.stderr('Done\n');
    expect(err).toEqual(['\r\x1b[KReading input', '\r\x1b[KPackaging [1/2]', '\r\x1b[K', 'Plan: 1 operations\n', 'Done\n']);
    expect(out).toEqual(['Summary\n']);
    // Not a terminal: unchanged.
    const plain = captureIO();
    expect(progressLine(plain.io)).toBe(plain.io);
  });

  it('throttles updates of the same stage to one per second', () => {
    const lines = feed([
      [10_000, { stage: 'analyze', item: 1, items: 4 }],
      [10_100, { stage: 'analyze', item: 2, items: 4 }],
      [10_200, { stage: 'analyze', item: 2, items: 4 }],
      [11_200, { stage: 'analyze', item: 3, items: 4 }],
      [11_300, { stage: 'analyze', item: 3, items: 4 }],
      [11_400, { stage: 'package', item: 1, items: 4 }],
    ]);
    expect(lines).toEqual(['Checking entries [1/4]\n', 'Checking entries [3/4]\n', 'Packaging [1/4]\n']);
  });
});
