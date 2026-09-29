import { ElpxError } from '../../core/errors.js';
import { assertRange, streamRange, type ByteSource } from '../../core/io/byte-source.js';
import type { ByteSink } from '../../core/io/byte-sink.js';
import { throwIfCancelled, type CancelSignal } from '../../core/cancel.js';
import { readEntry, type ZipArchive, type ZipEntry } from '../../core/zip/reader.js';
import type { ResourceStore, StoredResource } from '../../core/media/engine.js';
import type { OutputTarget } from '../../core/optimize/optimize.js';

/**
 * Browser I/O over File/Blob. Reads are ranged slices, so a project is never
 * loaded into memory as a whole; unchanged entries and stored media are
 * written to the output as Blob slices of the original file (no copies).
 */

/** Random-access reader over a Blob or File. */
export class BlobByteSource implements ByteSource {
  readonly size: number;

  constructor(readonly blob: Blob) {
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(this.size, offset, length);
    try {
      return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
    } catch {
      throw new ElpxError('io', 'The file could not be read (was it moved or modified?)');
    }
  }

  /** Zero-copy view of a byte range. */
  slice(start: number, end: number): Blob {
    return this.blob.slice(start, end);
  }
}

/** Collects output as Blob parts. */
export class BlobSink implements ByteSink {
  private readonly parts: BlobPart[] = [];
  bytesWritten = 0;

  write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk.slice());
    this.bytesWritten += chunk.length;
    return Promise.resolve();
  }

  async writeRange(source: ByteSource, start: number, end: number, signal?: CancelSignal): Promise<void> {
    throwIfCancelled(signal);
    if (source instanceof BlobByteSource) {
      this.parts.push(source.slice(start, end));
      this.bytesWritten += end - start;
      return;
    }
    for await (const chunk of streamRange(source, start, end, signal ? { signal } : {})) await this.write(chunk);
  }

  toBlob(type = 'application/zip'): Blob {
    return new Blob(this.parts, { type });
  }
}

/** A resource held as a Blob. */
export class BlobResource implements StoredResource {
  private released = false;

  constructor(
    public blob: Blob,
    readonly name: string,
  ) {}

  get size(): number {
    return this.blob.size;
  }

  open(): Promise<BlobByteSource> {
    if (this.released) return Promise.reject(new ElpxError('internal', 'Resource already released'));
    return Promise.resolve(new BlobByteSource(this.blob));
  }

  dispose(): Promise<void> {
    this.released = true;
    this.blob = new Blob([]);
    return Promise.resolve();
  }
}

/**
 * Resource store backed by Blobs. Stored (uncompressed) entries of the input
 * file are exposed as slices without copying; deflated ones are inflated in
 * chunks into a new Blob (the browser may keep large Blobs on disk).
 */
export class BlobStore implements ResourceStore {
  private counter = 0;
  private readonly live = new Set<BlobResource>();

  private nameFor(extension: string): string {
    const ext = /^[a-z0-9]{1,5}$/i.test(extension) ? extension.toLowerCase() : 'bin';
    return `r${++this.counter}.${ext}`;
  }

  async fromEntry(archive: ZipArchive, entry: ZipEntry, extension: string, signal?: CancelSignal): Promise<BlobResource> {
    let blob: Blob;
    if (entry.method === 0 && archive.source instanceof BlobByteSource) {
      // CRC was verified during analysis; the stored bytes are the content.
      blob = archive.source.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    } else {
      const parts: BlobPart[] = [];
      for await (const chunk of readEntry(archive, entry, signal ? { signal } : {})) parts.push(chunk.slice());
      blob = new Blob(parts);
    }
    return this.track(new BlobResource(blob, this.nameFor(extension)));
  }

  fromBytes(bytes: Uint8Array, extension: string): Promise<BlobResource> {
    return Promise.resolve(this.track(new BlobResource(new Blob([bytes.slice()]), this.nameFor(extension))));
  }

  /** Wraps a Blob produced by an engine. */
  adopt(blob: Blob, extension: string): BlobResource {
    return this.track(new BlobResource(blob, this.nameFor(extension)));
  }

  private track(r: BlobResource): BlobResource {
    this.live.add(r);
    return r;
  }

  async disposeAll(): Promise<void> {
    for (const r of this.live) await r.dispose();
    this.live.clear();
  }
}

/** Output target producing a Blob; "useOriginal" returns the input file itself. */
export class BlobOutputTarget implements OutputTarget {
  readonly sink = new BlobSink();
  private result: Blob | undefined;

  finish(): Promise<ByteSource> {
    this.result = this.sink.toBlob();
    return Promise.resolve(new BlobByteSource(this.result));
  }

  useOriginal(source: ByteSource): Promise<ByteSource> {
    if (source instanceof BlobByteSource) {
      this.result = source.blob.slice(0, source.size, 'application/zip');
      return Promise.resolve(new BlobByteSource(this.result));
    }
    return Promise.reject(new ElpxError('internal', 'Unexpected source type'));
  }

  discard(): Promise<void> {
    this.result = undefined;
    return Promise.resolve();
  }

  /** The delivered Blob (after finish or useOriginal). */
  get blob(): Blob | undefined {
    return this.result;
  }
}
