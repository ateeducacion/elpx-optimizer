import { open, type FileHandle } from 'node:fs/promises';
import { ElpxError } from '../../core/errors.js';
import { assertRange, type ByteSource } from '../../core/io/byte-source.js';

/** ByteSource over a file on disk, read with positional reads. */
export class FileByteSource implements ByteSource {
  private constructor(
    private readonly handle: FileHandle,
    readonly size: number,
    /** Path of the file (used for fast copies; never reported). */
    readonly path: string,
  ) {}

  /** Opens a regular file for reading. */
  static async open(path: string): Promise<FileByteSource> {
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ElpxError('io', code === 'ENOENT' ? 'Input file not found' : `Cannot open input file (${code ?? 'error'})`);
    }
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      throw new ElpxError('io', 'Input is not a regular file');
    }
    return new FileByteSource(handle, stat.size, path);
  }

  /** Reads exactly `length` bytes at `offset`. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(this.size, offset, length);
    const buffer = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buffer, done, length - done, offset + done);
      if (bytesRead === 0) throw new ElpxError('io', 'Unexpected end of file (was it modified while reading?)');
      done += bytesRead;
    }
    return buffer;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
