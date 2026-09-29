import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, readdir, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createNodePlatform, NodeOutputTarget } from '../../../src/adapters/node/platform.js';
import { FileByteSource } from '../../../src/adapters/node/file-source.js';
import { NativeMediaEngine } from '../../../src/adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../../src/adapters/node/resource-store.js';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import { removeDir, tempDir } from '../../helpers/cli.js';
import { failNextClose } from '../../helpers/fs-faults.js';

const enc = new TextEncoder();
let dir: string;

beforeEach(async () => {
  dir = await tempDir('elpx-platform-');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(dir);
});

/** Reads a whole ByteSource as text. */
async function text(source: { size: number; read(o: number, l: number): Promise<Uint8Array> }): Promise<string> {
  return new TextDecoder().decode(await source.read(0, source.size));
}

describe('NodeOutputTarget', () => {
  it('finishes into a readable temporary file and commits it', async () => {
    const final = join(dir, 'out.elpx');
    const target = await NodeOutputTarget.create(final);
    expect(target.tempPath).toBe(target.sink.tempPath);
    await target.sink.write(enc.encode('optimized'));
    const reader = await target.finish();
    expect(await text(reader)).toBe('optimized');
    await target.commit(false);
    expect(await readFile(final, 'utf8')).toBe('optimized');
    expect(await readdir(dir)).toEqual(['out.elpx']);
  });

  it('replaces the output with a copy of a file input', async () => {
    const inputPath = join(dir, 'in.elpx');
    await writeFile(inputPath, 'original bytes');
    const input = await FileByteSource.open(inputPath);
    const target = await NodeOutputTarget.create(join(dir, 'out.elpx'));
    const firstTemp = target.tempPath;
    await target.sink.write(enc.encode('bigger than the original'));
    await target.finish();
    const copy = await target.useOriginal(input);
    expect(target.tempPath).not.toBe(firstTemp);
    expect(await text(copy)).toBe('original bytes');
    await target.commit(true);
    await input.close();
    expect(await readFile(join(dir, 'out.elpx'), 'utf8')).toBe('original bytes');
    expect((await readdir(dir)).sort()).toEqual(['in.elpx', 'out.elpx']);
  });

  it('streams a non-file input when replacing the output', async () => {
    const target = await NodeOutputTarget.create(join(dir, 'out.elpx'));
    const copy = await target.useOriginal(new MemoryByteSource(enc.encode('from memory')));
    expect(await text(copy)).toBe('from memory');
    await target.commit(false);
    expect(await readFile(join(dir, 'out.elpx'), 'utf8')).toBe('from memory');
  });

  it('discards everything, including an open reader', async () => {
    const target = await NodeOutputTarget.create(join(dir, 'out.elpx'));
    await target.sink.write(enc.encode('partial'));
    await target.finish();
    await target.discard();
    const unfinished = await NodeOutputTarget.create(join(dir, 'other.elpx'));
    await unfinished.discard();
    expect(await readdir(dir)).toEqual([]);
  });

  it('discards even when closing the reader fails', async () => {
    const target = await NodeOutputTarget.create(join(dir, 'out.elpx'));
    await target.finish();
    // The reader is private: reach its handle to simulate a failing close.
    failNextClose((target as unknown as { reader: { handle: FileHandle } }).reader.handle);
    await target.discard();
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses to commit over an existing file without overwrite', async () => {
    await writeFile(join(dir, 'out.elpx'), 'keep me');
    const target = await NodeOutputTarget.create(join(dir, 'out.elpx'));
    await target.finish();
    await expect(target.commit(false)).rejects.toMatchObject({ code: 'output-exists' });
    expect(await readFile(join(dir, 'out.elpx'), 'utf8')).toBe('keep me');
    expect(await readdir(dir)).toEqual(['out.elpx']);
  });
});

describe('createNodePlatform', () => {
  it('wires the store, the engine and the output target', async () => {
    const platform = await createNodePlatform({ limits: NATIVE_LIMITS, outputPath: join(dir, 'result.elpx'), tempRoot: dir, imageConcurrency: 3, threads: 2 });
    try {
      expect(platform.store).toBeInstanceOf(NodeResourceStore);
      expect(platform.store.dir.startsWith(dir)).toBe(true);
      expect(platform.engine).toBeInstanceOf(NativeMediaEngine);
      expect(platform.limits).toBe(NATIVE_LIMITS);
      expect(platform.imageConcurrency).toBe(3);
      expect(platform.lastOutput()).toBeUndefined();
      const target = await platform.createOutput();
      expect(platform.lastOutput()).toBe(target);
      await target.discard();
    } finally {
      await platform.store.disposeAll();
    }
  });

  it('defaults to the OS temp directory and a CPU-based image concurrency', async () => {
    const platform = await createNodePlatform({ limits: NATIVE_LIMITS, outputPath: join(dir, 'result.elpx') });
    try {
      expect(platform.imageConcurrency).toBeGreaterThanOrEqual(1);
      expect(platform.imageConcurrency).toBeLessThanOrEqual(4);
      await access(platform.store.dir);
    } finally {
      await platform.store.disposeAll();
    }
  });
});
