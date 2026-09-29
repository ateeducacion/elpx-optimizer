import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileResource, NodeResourceStore, statfsFreeSpace } from '../../../src/adapters/node/resource-store.js';
import { ElpxError } from '../../../src/core/errors.js';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import { openZip } from '../../../src/core/zip/reader.js';
import { craftZip } from '../../helpers/zip-craft.js';
import { removeDir, tempDir } from '../../helpers/cli.js';

let root: string;
let store: NodeResourceStore | undefined;

beforeEach(async () => {
  root = await tempDir('elpx-store-');
});
afterEach(async () => {
  await store?.disposeAll();
  store = undefined;
  await removeDir(root);
});

/** True when the path exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('NodeResourceStore', () => {
  it('creates a private work directory under the temp root', async () => {
    store = await NodeResourceStore.create({ tempRoot: root });
    expect(store.dir.startsWith(join(root, 'elpx-optimizer-'))).toBe(true);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
  });

  it('uses the OS temporary directory by default', async () => {
    store = await NodeResourceStore.create();
    expect(await exists(store.dir)).toBe(true);
  });

  it('generates synthetic names with sanitized extensions', async () => {
    store = await NodeResourceStore.create({ tempRoot: root });
    expect(store.newPath('MP4').name).toBe('r1.mp4');
    expect(store.newPath('../../etc').name).toBe('r2.bin');
    expect(store.newPath('toolong').name).toBe('r3.bin');
    expect(store.newPath('').name).toBe('r4.bin');
    expect(store.newPath('webp').path).toBe(join(store.dir, 'r5.webp'));
  });

  it('stores bytes in owner-only files that can be reopened', async () => {
    store = await NodeResourceStore.create({ tempRoot: root });
    const resource = await store.fromBytes(new TextEncoder().encode('pixels'), 'png');
    expect(resource).toBeInstanceOf(FileResource);
    expect(resource.size).toBe(6);
    expect(resource.name).toBe('r1.png');
    expect((await stat(resource.path)).mode & 0o777).toBe(0o600);
    const source = await resource.open();
    expect(new TextDecoder().decode(await source.read(0, 6))).toBe('pixels');
    await source.close();
    await resource.dispose();
    await resource.dispose();
    expect(await exists(resource.path)).toBe(false);
  });

  it('extracts ZIP entries to files', async () => {
    store = await NodeResourceStore.create({ tempRoot: root });
    const payload = 'video '.repeat(5000);
    const archive = await openZip(new MemoryByteSource(craftZip([{ name: 'content/resources/clip.mp4', data: payload, method: 8 }])), NATIVE_LIMITS);
    const resource = await store.fromEntry(archive, archive.entries[0]!, 'mp4', new AbortController().signal);
    expect(resource.size).toBe(payload.length);
    expect(await readFile(resource.path, 'utf8')).toBe(payload);
    const again = await store.fromEntry(archive, archive.entries[0]!, 'mp4');
    expect(again.name).toBe('r2.mp4');
  });

  it('removes a partial extraction when the entry is corrupt', async () => {
    store = await NodeResourceStore.create({ tempRoot: root });
    const bytes = craftZip([{ name: 'bad.png', data: 'not what the CRC says', central: { crc: 1 }, local: { crc: 1 } }]);
    const archive = await openZip(new MemoryByteSource(bytes), NATIVE_LIMITS);
    await expect(store.fromEntry(archive, archive.entries[0]!, 'png')).rejects.toThrow(ElpxError);
    expect(await readdir(store.dir)).toEqual([]);
  });

  it('checks free space before writing (injected probe and reserve)', async () => {
    store = await NodeResourceStore.create({ tempRoot: root, freeSpace: async () => 1000, reserveBytes: 100 });
    await store.ensureSpace(900);
    const error = await store.fromBytes(new Uint8Array(901), 'bin').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElpxError);
    expect((error as ElpxError).code).toBe('io');
    expect((error as ElpxError).message).toBe('Insufficient disk space in the temporary directory (1000 bytes free, 1001 needed)');
    expect(await readdir(store.dir)).toEqual([]);
  });

  it('keeps a default reserve of 64 MiB and skips the check when the probe cannot tell', async () => {
    const tight = await NodeResourceStore.create({ tempRoot: root, freeSpace: async () => 64 * 1024 * 1024 });
    await expect(tight.ensureSpace(1)).rejects.toThrow(/Insufficient disk space/);
    await tight.disposeAll();
    store = await NodeResourceStore.create({ tempRoot: root, freeSpace: async () => undefined });
    await store.ensureSpace(Number.MAX_SAFE_INTEGER);
  });

  it('probes free space with statfs', async () => {
    const free = await statfsFreeSpace(root);
    expect(free).toBeGreaterThan(0);
    expect(await statfsFreeSpace(join(root, 'missing'))).toBeUndefined();
  });

  it('adopts tool outputs and removes everything on disposeAll', async () => {
    store = await NodeResourceStore.create({ tempRoot: root });
    const { path, name } = store.newPath('mp4');
    await writeFile(path, 'encoded');
    const adopted = store.adopt(path, name, 7);
    const kept = await store.fromBytes(new Uint8Array([1, 2, 3]), 'jpg');
    await adopted.dispose();
    expect(await exists(path)).toBe(false);
    await store.disposeAll();
    expect(await exists(kept.path)).toBe(false);
    expect(await exists(store.dir)).toBe(false);
    store = undefined;
  });
});
