import { ElpxError } from '../errors.js';
import { throwIfCancelled, type CancelSignal } from '../cancel.js';

/**
 * Random-access, read-only view over bytes. Adapters implement it on top of a
 * browser Blob/File, a Node file handle or an in-memory buffer. The core never
 * needs the whole archive in memory.
 */
export interface ByteSource {
  /** Total size in bytes. */
  readonly size: number;
  /** Reads exactly `length` bytes starting at `offset`; throws on short reads. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Releases underlying handles, if any. */
  close?(): Promise<void>;
}

/** Default chunk size used when streaming ranges. */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/** In-memory ByteSource, used for small payloads and tests. */
export class MemoryByteSource implements ByteSource {
  readonly size: number;

  constructor(private readonly bytes: Uint8Array) {
    this.size = bytes.length;
  }

  /** Returns a copy-free view of the requested range. */
  read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(this.size, offset, length);
    return Promise.resolve(this.bytes.subarray(offset, offset + length));
  }
}

/** Validates that [offset, offset + length) lies inside a source of the given size. */
export function assertRange(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new ElpxError('io', `Invalid read range ${offset}+${length}`);
  }
  if (offset + length > size) {
    throw new ElpxError('zip-structure', `Read beyond end of data (${offset}+${length} > ${size})`);
  }
}

/** Streams the byte range [start, end) of a source in bounded chunks. */
export async function* streamRange(
  source: ByteSource,
  start: number,
  end: number,
  options: { chunkSize?: number; signal?: CancelSignal } = {},
): AsyncGenerator<Uint8Array> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  let offset = start;
  while (offset < end) {
    throwIfCancelled(options.signal);
    const length = Math.min(chunkSize, end - offset);
    yield await source.read(offset, length);
    offset += length;
  }
}

/** Collects an async byte stream into one buffer, enforcing a maximum size. */
export async function collectBytes(stream: AsyncIterable<Uint8Array>, maxBytes: number, what = 'data'): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new ElpxError('limit-exceeded', `${what} exceeds the limit of ${maxBytes} bytes`);
    }
    parts.push(chunk);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
