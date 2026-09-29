import { describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import { FileByteSource } from '../../../src/adapters/node/file-source.js';

/** A path whose open() fails with an error that has no errno code. */
const CODELESS = '/elpx-test/open-fails-without-code';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: (path: string, ...rest: []) => (path === CODELESS ? Promise.reject(new Error('odd failure')) : actual.open(path, ...rest)) };
});

describe('FileByteSource open errors', () => {
  it('reports errors without an errno code generically', async () => {
    await expect(FileByteSource.open(CODELESS)).rejects.toMatchObject({ code: 'io', message: 'Cannot open input file (error)' });
  });
});
