import type { FileHandle } from 'node:fs/promises';
import { vi } from 'vitest';

/** Makes the next close() of a FileHandle fail after really closing it (e.g. EIO on a network drive). */
export function failNextClose(handle: FileHandle): void {
  const original = handle.close.bind(handle);
  vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
    await original();
    throw new Error('EIO: i/o error, close');
  });
}
