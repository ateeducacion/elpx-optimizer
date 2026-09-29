import { describe, expect, it } from 'vitest';
import { EntryIndex, normalizeRelative, resolveReference, splitSuffix, type ResolveContext } from '../../../src/core/refs/resolve.js';

const editable: ResolveContext = { mode: 'editable', source: 'content.xml', basenameFallback: false };
const index = (...files: string[]) => new EntryIndex(files);
const page = (source: string, basenameFallback = false): ResolveContext => ({ mode: 'file', source, basenameFallback });

describe('EntryIndex', () => {
  it('indexes exact, NFC, lower-case and scoped basename lookups', () => {
    const nfc = 'content/resources/caf\u00e9.png';
    const idx = new EntryIndex([nfc, 'content/resources/A.png', 'theme/img/a.png'], (p) => p.startsWith('content/resources/'));
    expect(idx.has(nfc)).toBe(true);
    expect(idx.has('content/resources/cafe\u0301.png')).toBe(false);
    expect(idx.byNfc('content/resources/cafe\u0301.png')).toEqual([nfc]);
    expect(idx.byLower('CONTENT/RESOURCES/a.PNG')).toEqual(['content/resources/A.png']);
    expect(idx.byBasename('a.png')).toEqual([]);
    expect(idx.byBasename('A.png')).toEqual(['content/resources/A.png']);
    expect(idx.byBasename('cafe\u0301.png')).toEqual([nfc]);
    expect(idx.byNfc('missing')).toEqual([]);
    expect(idx.byLower('missing')).toEqual([]);
  });
});

describe('splitSuffix and normalizeRelative', () => {
  it('splits query and fragment', () => {
    expect(splitSuffix('a.png?v=1#x')).toEqual({ path: 'a.png', suffix: '?v=1#x' });
    expect(splitSuffix('a.png#x?y')).toEqual({ path: 'a.png', suffix: '#x?y' });
    expect(splitSuffix('a.png')).toEqual({ path: 'a.png', suffix: '' });
  });

  it('resolves dot segments and refuses to escape the root', () => {
    expect(normalizeRelative('html/', '../content/resources/a.png')).toBe('content/resources/a.png');
    expect(normalizeRelative('a/b/', './c/../d')).toBe('a/b/d');
    expect(normalizeRelative('', '../x')).toBeUndefined();
    expect(normalizeRelative('html/', '../../x')).toBeUndefined();
    expect(normalizeRelative('html/', '../')).toBe('');
  });
});

describe('resolveReference: classification', () => {
  const idx = index('content/resources/a.png');

  it.each([
    ['', 'empty', 'ignored'],
    ['   ', 'empty', 'ignored'],
    ['#top', 'fragment', 'ignored'],
    ['{{context_path}}', 'context-path', 'ignored'],
    ['{{context_path}}/', 'context-path', 'ignored'],
    ['asset://3f7a1c2e-0000-4000-8000-123456789abc.jpg', 'asset-uri', 'unmapped'],
    ['ASSET://resources/00.jpg', 'asset-uri', 'unmapped'],
    ['data:image/png;base64,AAAA', 'data-uri', 'ignored'],
    ['file:///C:/Users/me/a.png', 'local-file', 'unresolvable'],
    ['C:\\Users\\me\\a.png', 'local-file', 'unresolvable'],
    ['c:/Users/me/a.png', 'local-file', 'unresolvable'],
    ['\\\\server\\share\\a.png', 'local-file', 'unresolvable'],
    ['exe-node:page-2#frag', 'pseudo', 'ignored'],
    ['exe-package:elp', 'pseudo', 'ignored'],
    ['mailto:a@b.c', 'pseudo', 'ignored'],
    ['javascript:void(0)', 'pseudo', 'ignored'],
    ['https://example.org/a.png', 'absolute-url', 'external'],
    ['\\"https://example.org/a.png\\"', 'absolute-url', 'external'],
    ["'//cdn.example.org/x.js'", 'absolute-url', 'external'],
    ['//cdn.example.org/x.js', 'protocol-relative', 'external'],
    ['/raiz.html', 'root-relative', 'unresolvable'],
  ])('classifies %j as %s/%s', (value, form, status) => {
    const r = resolveReference(value, editable, idx);
    expect(r.form).toBe(form);
    expect(r.status).toBe(status);
    expect(resolveReference(value, page('index.html'), idx).form).toBe(form);
  });

  it('keeps the fragment of an in-page link as its suffix', () => {
    expect(resolveReference('#sec', editable, idx).suffix).toBe('#sec');
  });
});

describe('resolveReference: {{context_path}} placeholders', () => {
  it('resolves the long and short forms exactly', () => {
    const idx = index('content/resources/fotos/sol.jpg', 'content/resources/sol.jpg', 'content/css/base.css');
    expect(resolveReference('{{context_path}}/content/resources/fotos/sol.jpg', editable, idx)).toEqual({
      form: 'context-path',
      status: 'resolved',
      target: 'content/resources/fotos/sol.jpg',
      suffix: '',
    });
    expect(resolveReference('{{context_path}}/fotos/sol.jpg?x=1#y', editable, idx)).toEqual({
      form: 'context-path',
      status: 'resolved',
      target: 'content/resources/fotos/sol.jpg',
      suffix: '?x=1#y',
    });
    expect(resolveReference('{{context_path}}//sol.jpg', editable, idx).target).toBe('content/resources/sol.jpg');
    // The long form is looked up literally (no prefix trials); only the basename fallback can match it.
    expect(resolveReference('{{context_path}}/content/resources/css/base.css', editable, idx)).toMatchObject({
      status: 'resolved',
      target: 'content/css/base.css',
      lenient: 'basename',
    });
    const scoped = new EntryIndex(['content/css/base.css'], (p) => p.startsWith('content/resources/'));
    expect(resolveReference('{{context_path}}/content/resources/css/base.css', editable, scoped).status).toBe('missing');
    expect(resolveReference('{{context_path}}/css/base.css', editable, idx)).toMatchObject({ status: 'resolved', target: 'content/css/base.css' });
  });

  it('reports several prefix matches and picks the first like eXeLearning', () => {
    const r = resolveReference('{{context_path}}/x.png', editable, index('resources/x.png', 'content/resources/x.png', 'x.png'));
    expect(r).toMatchObject({
      status: 'resolved',
      target: 'x.png',
      lenient: 'multiple-prefixes',
      candidates: ['x.png', 'content/resources/x.png', 'resources/x.png'],
    });
  });

  it('decodes percent-encoding and flags it', () => {
    const idx = index('content/resources/doc final.pdf', 'content/resources/ñ.png');
    expect(resolveReference('{{context_path}}/content/resources/doc%20final.pdf', editable, idx)).toMatchObject({
      status: 'resolved',
      target: 'content/resources/doc final.pdf',
      percentEncoded: true,
    });
    expect(resolveReference('{{context_path}}/content/resources/%C3%B1.png', editable, idx)).toMatchObject({
      status: 'resolved',
      target: 'content/resources/ñ.png',
      percentEncoded: true,
    });
    // Invalid escapes are looked up literally.
    expect(resolveReference('{{context_path}}/content/resources/doc%zzfinal.pdf', editable, idx)).toMatchObject({
      status: 'missing',
      candidates: ['content/resources/doc%zzfinal.pdf'],
    });
    expect(resolveReference('{{context_path}}/content/resources/no%20such.pdf', editable, idx)).toMatchObject({
      status: 'missing',
      percentEncoded: true,
      candidates: ['content/resources/no such.pdf'],
    });
  });

  it('applies each lenient rule and reports it', () => {
    const idx = index(
      'content/resources/mayus.png',
      'content/resources/caf\u00e9.png',
      'content/resources/a#1.png',
      'content/resources/q?.png',
      'content/resources/d/x.png',
      'content/resources/b/c.png',
    );
    const lenient = (v: string) => resolveReference(v, editable, idx);
    expect(lenient('{{context_path}}/content/resources/Mayus.PNG')).toMatchObject({
      status: 'resolved',
      target: 'content/resources/mayus.png',
      lenient: 'case',
    });
    expect(lenient('{{context_path}}/content/resources/cafe\u0301.png')).toMatchObject({
      status: 'resolved',
      target: 'content/resources/caf\u00e9.png',
      lenient: 'unicode',
    });
    expect(lenient('{{context_path}}/content/resources/a#1.png')).toMatchObject({
      status: 'resolved',
      target: 'content/resources/a#1.png',
      lenient: 'literal-special',
      suffix: '',
    });
    expect(lenient('{{context_path}}/content/resources/q?.png')).toMatchObject({ target: 'content/resources/q?.png', lenient: 'literal-special' });
    expect(lenient('{{context_path}}/content/resources//d//x.png')).toMatchObject({ target: 'content/resources/d/x.png', lenient: 'double-slash' });
    expect(lenient('{{context_path}}/content/resources/b\\c.png')).toMatchObject({ target: 'content/resources/b/c.png', lenient: 'backslash' });
    expect(lenient('{{context_path}}/elsewhere/c.png')).toMatchObject({ status: 'resolved', target: 'content/resources/b/c.png', lenient: 'basename' });
  });

  it('resolves placeholders wrapped in doubly escaped quotes, leniently', () => {
    const idx = index('content/resources/a.png');
    expect(resolveReference('\\"{{context_path}}/content/resources/a.png\\"', editable, idx)).toMatchObject({
      status: 'resolved',
      target: 'content/resources/a.png',
      lenient: 'escaped-quotes',
    });
    expect(resolveReference('"{{context_path}}/content/resources/a.png\\', editable, idx)).toMatchObject({ status: 'resolved', lenient: 'escaped-quotes' });
    expect(resolveReference('\\"{{context_path}}/content/resources/b.png\\"', editable, idx)).toMatchObject({ status: 'missing', form: 'context-path' });
  });

  it('never picks a file when a lenient rule is ambiguous', () => {
    const idx = index('content/resources/a/logo.png', 'content/resources/b/logo.png', 'content/resources/X.png', 'content/resources/x.PNG');
    expect(resolveReference('{{context_path}}/logo.png', editable, idx)).toMatchObject({
      status: 'ambiguous',
      candidates: ['content/resources/a/logo.png', 'content/resources/b/logo.png'],
    });
    expect(resolveReference('{{context_path}}/content/resources/x.png', editable, idx)).toMatchObject({
      status: 'ambiguous',
      candidates: ['content/resources/X.png', 'content/resources/x.PNG'],
    });
  });

  it('reports missing files with their expected paths', () => {
    expect(resolveReference('{{context_path}}/nada.png', editable, index('content/resources/otra.png'))).toEqual({
      form: 'context-path',
      status: 'missing',
      candidates: ['nada.png', 'content/nada.png', 'content/resources/nada.png', 'resources/nada.png'],
      suffix: '',
    });
  });
});

describe('resolveReference: editable legacy and relative forms', () => {
  it('resolves legacy resources/ paths through content/', () => {
    const idx = index('content/resources/antiguo.jpg', 'content/resources/x/y.jpg');
    expect(resolveReference('resources/antiguo.jpg', editable, idx)).toMatchObject({
      form: 'resources-legacy',
      status: 'resolved',
      target: 'content/resources/antiguo.jpg',
    });
    expect(resolveReference('resources/y.jpg', editable, idx)).toMatchObject({ form: 'resources-legacy', status: 'resolved', lenient: 'basename' });
  });

  it('maps stale editor upload paths to their folder, leniently', () => {
    const idx = index('content/resources/20251024113355JKQMOB/leon.png');
    expect(resolveReference('files/tmp/2025/10/24/20251024113355JKQMOB/leon.png', editable, idx)).toMatchObject({
      form: 'stale-editor-path',
      status: 'resolved',
      lenient: 'stale-editor-path',
    });
    expect(resolveReference('files/tmp/2025/10/24/OTHER/leon.png', editable, idx)).toMatchObject({
      form: 'stale-editor-path',
      status: 'missing',
      candidates: ['content/resources/OTHER/leon.png'],
    });
    // A single segment after tmp/ is not an upload path.
    expect(resolveReference('files/tmp/leon.png', editable, idx)).toMatchObject({ form: 'relative', status: 'missing' });
  });

  it('resolves archive-relative paths, optionally by basename', () => {
    const idx = index('content/resources/a.png');
    expect(resolveReference('./content/resources/a.png', editable, idx)).toMatchObject({
      form: 'relative',
      status: 'resolved',
      target: 'content/resources/a.png',
    });
    expect(resolveReference('../content/resources/a.png', editable, idx)).toEqual({ form: 'relative', status: 'unresolvable', suffix: '' });
    expect(resolveReference('img/a.png', editable, idx).status).toBe('missing');
    expect(resolveReference('img/a.png', { ...editable, basenameFallback: true }, idx)).toMatchObject({ status: 'resolved', lenient: 'basename' });
  });
});

describe('resolveReference: references inside real files', () => {
  const idx = index('index.html', 'html/juego.html', 'content/resources/a b.png', 'theme/style.css', 'theme/img/bg.png', 'content/resources/sub/index.html');

  it('resolves relative to the containing file', () => {
    expect(resolveReference('../content/resources/a%20b.png', page('html/juego.html'), idx)).toMatchObject({
      status: 'resolved',
      target: 'content/resources/a b.png',
      percentEncoded: true,
    });
    expect(resolveReference('img/bg.png', page('theme/style.css'), idx)).toMatchObject({ status: 'resolved', target: 'theme/img/bg.png' });
    expect(resolveReference('html/juego.html#x', page('index.html'), idx)).toMatchObject({ status: 'resolved', target: 'html/juego.html', suffix: '#x' });
    expect(resolveReference('../../x.png', page('html/juego.html'), idx)).toMatchObject({ form: 'relative', status: 'unresolvable' });
  });

  it('serves folder links through their index page', () => {
    expect(resolveReference('../', page('html/juego.html'), idx)).toMatchObject({ status: 'resolved', target: 'index.html' });
    expect(resolveReference('content/resources/sub/', page('index.html'), idx)).toMatchObject({
      status: 'resolved',
      target: 'content/resources/sub/index.html',
    });
    expect(resolveReference('./', page('theme/style.css'), idx)).toEqual({ form: 'relative', status: 'ignored', suffix: '' });
  });

  it('only uses the basename fallback when allowed', () => {
    expect(resolveReference('elsewhere/bg.png', page('index.html'), idx).status).toBe('missing');
    expect(resolveReference('elsewhere/bg.png', page('index.html', true), idx)).toMatchObject({
      status: 'resolved',
      target: 'theme/img/bg.png',
      lenient: 'basename',
    });
  });
});
