import { describe, expect, it } from 'vitest';
import { optimizedFileName } from '../../src/adapters/browser/protocol.js';

describe('browser project smoke', () => {
  it('runs in a real browser', () => {
    expect(typeof window).toBe('object');
    expect(optimizedFileName('curso final.elpx')).toBe('curso final_optimized.elpx');
  });
});

describe('optimizedFileName', () => {
  it('drops directories, the extension and reserved characters', () => {
    expect(optimizedFileName('C:\\Users\\ana\\Tema 1.ELPX')).toBe('Tema 1_optimized.elpx');
    expect(optimizedFileName('dir/sub/curso.elp')).toBe('curso_optimized.elpx');
    expect(optimizedFileName('line\nbreak/export.zip')).toBe('export_optimized.elpx');
    expect(optimizedFileName('a<b>c:"d"|e?*\u0001.elpx')).toBe('a_b_c__d__e____optimized.elpx');
    expect(optimizedFileName('  .curso.  .elpx')).toBe('curso_optimized.elpx');
    expect(optimizedFileName('notes.txt')).toBe('notes.txt_optimized.elpx');
  });

  it('falls back to "project" and bounds the length', () => {
    expect(optimizedFileName('')).toBe('project_optimized.elpx');
    expect(optimizedFileName('.elpx')).toBe('project_optimized.elpx');
    expect(optimizedFileName('folder/')).toBe('project_optimized.elpx');
    expect(optimizedFileName(`${'x'.repeat(300)}.elpx`)).toBe(`${'x'.repeat(180)}_optimized.elpx`);
  });
});
