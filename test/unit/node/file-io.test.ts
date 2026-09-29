import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, readdir, readFile, stat, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { AtomicFileSink } from '../../../src/adapters/node/file-sink.js';
import { FileByteSource } from '../../../src/adapters/node/file-source.js';
import { ElpxError } from '../../../src/core/errors.js';
import { removeDir, tempDir } from '../../helpers/cli.js';
import { failNextClose } from '../../helpers/fs-faults.js';

const enc = new TextEncoder();
let dir: string;

beforeEach(async () => {
  dir = await tempDir('elpx-fileio-');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(dir);
});

/** Error thrown by a promise (fails when it resolves). */
async function failure(promise: Promise<unknown>): Promise<ElpxError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ElpxError);
  return error as ElpxError;
}

describe('AtomicFileSink', () => {
  it('writes to a hidden temporary file and renames it on commit', async () => {
    const final = join(dir, 'out.elpx');
    const sink = await AtomicFileSink.create(final);
    expect(sink.finalPath).toBe(final);
    expect(sink.tempPath).toMatch(/[/\\]\.out\.elpx\.[0-9a-f]{12}\.partial$/);
    await sink.write(enc.encode('hello '));
    await sink.write(enc.encode('world'));
    await sink.write(new Uint8Array(0));
    expect(sink.bytesWritten).toBe(11);
    expect(await readdir(dir)).toEqual([sink.tempPath.split(/[/\\]/).pop()]);
    await sink.commit(false);
    expect(await readFile(final, 'utf8')).toBe('hello world');
    expect(await readdir(dir)).toEqual(['out.elpx']);
  });

  it('can be closed more than once and reopened for verification', async () => {
    const sink = await AtomicFileSink.create(join(dir, 'a.bin'));
    await sink.write(enc.encode('abc'));
    await sink.close();
    await sink.close();
    expect(await readFile(sink.tempPath, 'utf8')).toBe('abc');
    await sink.commit(false);
    expect(await readFile(join(dir, 'a.bin'), 'utf8')).toBe('abc');
  });

  it('refuses to replace an existing file without overwrite and removes its temporary file', async () => {
    const final = join(dir, 'exists.elpx');
    await writeFile(final, 'original');
    const sink = await AtomicFileSink.create(final);
    await sink.write(enc.encode('new'));
    const error = await failure(sink.commit(false));
    expect(error.code).toBe('output-exists');
    expect(await readFile(final, 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual(['exists.elpx']);
  });

  it('replaces an existing file with overwrite', async () => {
    const final = join(dir, 'exists.elpx');
    await writeFile(final, 'original');
    const sink = await AtomicFileSink.create(final);
    await sink.write(enc.encode('new'));
    await sink.commit(true);
    expect(await readFile(final, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['exists.elpx']);
  });

  it('discards the temporary file whether open or closed', async () => {
    const open = await AtomicFileSink.create(join(dir, 'x.elpx'));
    await open.write(enc.encode('partial'));
    await open.discard();
    await open.discard();
    const closed = await AtomicFileSink.create(join(dir, 'y.elpx'));
    await closed.close();
    await closed.discard();
    expect(await readdir(dir)).toEqual([]);
  });

  it('still removes the temporary file when closing it fails', async () => {
    const sink = await AtomicFileSink.create(join(dir, 'z.elpx'));
    await sink.write(enc.encode('partial'));
    // The handle is private: reach it to simulate a failing close.
    failNextClose((sink as unknown as { handle: FileHandle }).handle);
    await sink.discard();
    expect(await readdir(dir)).toEqual([]);
  });

  it('creates files with the default mode (0666 minus the umask)', async () => {
    const previous = process.umask(0o027);
    try {
      const sink = await AtomicFileSink.create(join(dir, 'mode.elpx'));
      await sink.commit(false);
      expect((await stat(join(dir, 'mode.elpx'))).mode & 0o777).toBe(0o640);
    } finally {
      process.umask(previous);
    }
  });

  it('fails when the destination directory does not exist', async () => {
    await expect(AtomicFileSink.create(join(dir, 'missing', 'out.elpx'))).rejects.toThrow(/ENOENT/);
  });
});

describe('FileByteSource', () => {
  it('reads exact ranges with positional reads', async () => {
    const path = join(dir, 'data.bin');
    await writeFile(path, '0123456789');
    const source = await FileByteSource.open(path);
    expect(source.size).toBe(10);
    expect(source.path).toBe(path);
    expect(new TextDecoder().decode(await source.read(3, 4))).toBe('3456');
    expect(await source.read(10, 0)).toEqual(new Uint8Array(0));
    await expect(source.read(8, 5)).rejects.toThrow();
    await expect(source.read(-1, 1)).rejects.toThrow();
    await source.close();
  });

  it('detects a file that shrank while reading', async () => {
    const path = join(dir, 'shrinks.bin');
    await writeFile(path, 'x'.repeat(100));
    const source = await FileByteSource.open(path);
    await truncate(path, 10);
    const error = await failure(source.read(0, 50));
    expect(error.code).toBe('io');
    expect(error.message).toMatch(/Unexpected end of file/);
    await source.close();
  });

  it('reports a missing file', async () => {
    const error = await failure(FileByteSource.open(join(dir, 'nope.elpx')));
    expect(error.code).toBe('io');
    expect(error.message).toBe('Input file not found');
  });

  it('refuses directories', async () => {
    await mkdir(join(dir, 'sub'));
    const error = await failure(FileByteSource.open(join(dir, 'sub')));
    expect(error.message).toBe('Input is not a regular file');
  });

  it.skipIf(process.getuid?.() === 0)('reports unreadable files with their error code', async () => {
    const path = join(dir, 'locked.elpx');
    await writeFile(path, 'secret');
    await chmod(path, 0o000);
    const error = await failure(FileByteSource.open(path));
    expect(error.message).toBe('Cannot open input file (EACCES)');
  });
});
