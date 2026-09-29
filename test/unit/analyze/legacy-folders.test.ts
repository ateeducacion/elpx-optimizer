import { describe, expect, it } from 'vitest';
import { legacyFolderOf } from '../../../src/core/format/legacy-folders.js';
import { analyzeBytes, buildElpx, diags, elpxFixture, media } from '../../helpers/core-kit.js';

/** Detection of files stored in eXeLearning 3 editor folders (content/resources/<ODE-ID>/). */

const PNG = media('palette-efficient.png');

describe('legacyFolderOf', () => {
  it('only matches files directly inside a folder named like an ODE-ID', () => {
    expect(legacyFolderOf('content/resources/20240101120000AB12CD/foto 1.png')).toEqual({ folder: '20240101120000AB12CD', name: 'foto 1.png' });
    for (const path of [
      'content/resources/20240101120000AB12CD/',
      'content/resources/20240101120000AB12CD/sub/foto.png',
      'content/resources/20240101120000ab12cd/foto.png',
      'content/resources/2024010112000AB12CD/foto.png',
      'content/resources/20240101120000AB12CDE/foto.png',
      'custom/20240101120000AB12CD/foto.png',
      'content/resources/foto.png',
    ]) {
      expect(legacyFolderOf(path)).toBeUndefined();
    }
  });
});

describe('legacy-resource-folders diagnostic', () => {
  it('counts files and folders of legacy-folders.elpx', async () => {
    const a = await analyzeBytes(elpxFixture('legacy-folders.elpx'));
    expect(a.result.package?.legacyFolders).toEqual({ folders: 5, files: 7 });
    expect(diags(a, 'legacy-resource-folders')).toEqual([
      expect.objectContaining({
        severity: 'info',
        message: '7 files are stored in 5 eXeLearning 3 editor folders (content/resources/<ODE-ID>/)',
        details: { files: 7, folders: 5 },
      }),
    ]);
  });

  it('uses the singular for one file, and ignores empty folders and look-alikes', async () => {
    const a = await analyzeBytes(
      buildElpx({
        components: [],
        files: {
          'content/resources/20240101120000AAAAAA/a.png': PNG,
          'content/resources/20240101120000BBBBBB/': new Uint8Array(0),
          'content/resources/20240101120000CCCCCC/sub/b.png': PNG,
          'content/resources/2024-01-01/c.png': PNG,
        },
      }),
    );
    expect(a.result.package?.legacyFolders).toEqual({ folders: 1, files: 1 });
    expect(diags(a, 'legacy-resource-folders').map((d) => d.message)).toEqual([
      '1 file is stored in 1 eXeLearning 3 editor folder (content/resources/<ODE-ID>/)',
    ]);
    const none = await analyzeBytes(buildElpx({ components: [], files: { 'content/resources/2024-01-01/c.png': PNG } }));
    expect(none.result.package?.legacyFolders).toEqual({ folders: 0, files: 0 });
    expect(diags(none, 'legacy-resource-folders')).toEqual([]);
  });
});
