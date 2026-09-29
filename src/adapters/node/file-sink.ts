import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ByteSink } from '../../core/io/byte-sink.js';
import { ElpxError } from '../../core/errors.js';

/**
 * Writes to a temporary file next to the final destination and renames it
 * into place only after the caller commits, so a failed or cancelled run
 * never leaves a partial output under the final name.
 */
export class AtomicFileSink implements ByteSink {
  bytesWritten = 0;
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    readonly tempPath: string,
    readonly finalPath: string,
  ) {}

  /**
   * Creates the temporary file (exclusive) in the destination directory. It
   * gets the default mode (0666 minus the umask), like any file the user saves.
   */
  static async create(finalPath: string): Promise<AtomicFileSink> {
    const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomBytes(6).toString('hex')}.partial`);
    const handle = await open(tempPath, 'wx');
    return new AtomicFileSink(handle, tempPath, finalPath);
  }

  async write(chunk: Uint8Array): Promise<void> {
    let done = 0;
    while (done < chunk.length) {
      const { bytesWritten } = await this.handle.write(chunk, done, chunk.length - done);
      done += bytesWritten;
    }
    this.bytesWritten += chunk.length;
  }

  /** Flushes and closes the temporary file (it can then be reopened for verification). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.sync();
    await this.handle.close();
  }

  /** Moves the verified temporary file to its final name. */
  async commit(overwrite: boolean): Promise<void> {
    await this.close();
    if (!overwrite) {
      const exists = await stat(this.finalPath).then(
        () => true,
        () => false,
      );
      if (exists) {
        await this.discard();
        throw new ElpxError('output-exists', 'Output file already exists');
      }
    }
    await rename(this.tempPath, this.finalPath);
  }

  /** Deletes the temporary file. */
  async discard(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close().catch(() => undefined);
    }
    await rm(this.tempPath, { force: true });
  }
}
