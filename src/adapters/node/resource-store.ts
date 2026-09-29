import { mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElpxError } from '../../core/errors.js';
import type { CancelSignal } from '../../core/cancel.js';
import { readEntry, type ZipArchive, type ZipEntry } from '../../core/zip/reader.js';
import type { ResourceStore, StoredResource } from '../../core/media/engine.js';
import { FileByteSource } from './file-source.js';

/** A resource stored as a file in the run's private temporary directory. */
export class FileResource implements StoredResource {
  private disposed = false;

  constructor(
    readonly path: string,
    readonly name: string,
    readonly size: number,
    private readonly onDispose: (r: FileResource) => void,
  ) {}

  open(): Promise<FileByteSource> {
    return FileByteSource.open(this.path);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose(this);
    await rm(this.path, { force: true });
  }
}

/** Free-space probe, injectable for tests. */
export type FreeSpaceProbe = (dir: string) => Promise<number | undefined>;

/** Default probe using statfs (returns undefined where unsupported). */
export const statfsFreeSpace: FreeSpaceProbe = async (dir) => {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
};

/** Options for the native resource store. */
export interface NodeStoreOptions {
  /** Parent directory for the private work directory (default: OS temp). */
  tempRoot?: string;
  /** Extra free space to keep available (bytes). */
  reserveBytes?: number;
  freeSpace?: FreeSpaceProbe;
}

/**
 * Temporary files for one run, in a private directory (mode 0700) with
 * synthetic names, so user-controlled names never reach the file system or
 * FFmpeg. Disk space is checked before each extraction.
 */
export class NodeResourceStore implements ResourceStore {
  private counter = 0;
  private readonly live = new Set<FileResource>();

  private constructor(
    readonly dir: string,
    private readonly options: NodeStoreOptions,
  ) {}

  static async create(options: NodeStoreOptions = {}): Promise<NodeResourceStore> {
    const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'elpx-optimizer-'));
    return new NodeResourceStore(dir, options);
  }

  /** Returns a new synthetic file path with a sanitized extension. */
  newPath(extension: string): { path: string; name: string } {
    const ext = /^[a-z0-9]{1,5}$/i.test(extension) ? extension.toLowerCase() : 'bin';
    const name = `r${++this.counter}.${ext}`;
    return { path: join(this.dir, name), name };
  }

  /** Throws when the file system does not have room for `bytes` more. */
  async ensureSpace(bytes: number): Promise<void> {
    const free = await (this.options.freeSpace ?? statfsFreeSpace)(this.dir);
    const needed = bytes + (this.options.reserveBytes ?? 64 * 1024 * 1024);
    if (free !== undefined && free < needed) {
      throw new ElpxError('io', `Insufficient disk space in the temporary directory (${free} bytes free, ${needed} needed)`);
    }
  }

  async fromEntry(archive: ZipArchive, entry: ZipEntry, extension: string, signal?: CancelSignal): Promise<FileResource> {
    await this.ensureSpace(entry.uncompressedSize);
    const { path, name } = this.newPath(extension);
    const handle = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of readEntry(archive, entry, signal ? { signal } : {})) {
        let done = 0;
        while (done < chunk.length) done += (await handle.write(chunk, done)).bytesWritten;
      }
    } catch (error) {
      await handle.close();
      await rm(path, { force: true });
      throw error;
    }
    await handle.close();
    return this.track(path, name, entry.uncompressedSize);
  }

  async fromBytes(bytes: Uint8Array, extension: string): Promise<FileResource> {
    await this.ensureSpace(bytes.length);
    const { path, name } = this.newPath(extension);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
    return this.track(path, name, bytes.length);
  }

  /** Registers a file produced by a tool inside the store directory. */
  adopt(path: string, name: string, size: number): FileResource {
    return this.track(path, name, size);
  }

  private track(path: string, name: string, size: number): FileResource {
    const r = new FileResource(path, name, size, (x) => this.live.delete(x));
    this.live.add(r);
    return r;
  }

  async disposeAll(): Promise<void> {
    for (const r of [...this.live]) await r.dispose();
    await rm(this.dir, { recursive: true, force: true });
  }
}
