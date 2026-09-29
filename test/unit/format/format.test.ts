import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import { openZip, type ZipArchive } from '../../../src/core/zip/reader.js';
import { detectPackage, isOdeIdFolder } from '../../../src/core/format/detect.js';
import {
  DATAGAME_LINK_CLASS,
  dataGameEncoding,
  dataGamePrefix,
  decryptDataGame,
  encryptDataGame,
  jsEscape,
  jsUnescape,
} from '../../../src/core/format/datagame.js';
import { MANIFEST_PATH, manifestDiff, parseManifest, renderManifest, type ElpxManifest } from '../../../src/core/format/manifest.js';
import { componentLocation, ODE_NAMESPACE, parseContentXml } from '../../../src/core/format/content-xml.js';
import { ElpxError } from '../../../src/core/errors.js';
import { manifestText, odeXml, upstream, zipFiles } from '../../helpers/core-kit.js';

/** Opens an in-memory ZIP built from a file map. */
function archiveOf(files: Record<string, string | Uint8Array>): Promise<ZipArchive> {
  return openZip(new MemoryByteSource(zipFiles(files)), NATIVE_LIMITS);
}

/** Asserts the manifest parse result is valid and returns it. */
function okManifest(text: string): ElpxManifest {
  const m = parseManifest(text);
  if ('error' in m) throw new Error(m.error);
  return m;
}

describe('detectPackage', () => {
  it('classifies by content, never by extension', async () => {
    expect(detectPackage(await archiveOf({ 'content.xml': '<ode/>' }))).toEqual({ kind: 'elpx', contentXml: 'content.xml' });
    expect(detectPackage(await openZip(new MemoryByteSource(upstream('encoding_test.elp')), NATIVE_LIMITS)).kind).toBe('elpx');
    expect(detectPackage(await openZip(new MemoryByteSource(upstream('download-elpx-link.zip')), NATIVE_LIMITS)).kind).toBe('elpx');
    const legacy = detectPackage(await openZip(new MemoryByteSource(upstream('verdaderofalso.elp')), NATIVE_LIMITS));
    expect(legacy.kind).toBe('legacy-elp');
    // A legacy package with index.html at the root is still legacy.
    expect(detectPackage(await openZip(new MemoryByteSource(upstream('old_epvelp_udl.elp')), NATIVE_LIMITS)).kind).toBe('legacy-elp');
    expect(detectPackage(await archiveOf({ 'content.data': 'x' })).kind).toBe('legacy-elp');
  });

  it.each([
    [{ 'EPUB/content.xml': '<ode/>', 'EPUB/x.html': 'x' }, 'epub', /EPUB export/],
    [{ 'project.elpx': 'PK', 'readme.txt': 'x' }, 'nested', /project\.elpx/],
    [{ 'Other.ELP': 'x' }, 'nested', /Other\.ELP/],
    [{ 'proyecto/content.xml': '<ode/>', 'proyecto/index.html': 'x', 'proyecto/': '' }, 'wrapped', /"proyecto\/"/],
    [{ 'index.html': 'x', 'libs/a.js': 'x' }, 'html-export', /web\/SCORM/],
    [{ 'imsmanifest.xml': '<m/>' }, 'html-export', /web\/SCORM/],
    [{ 'folder/readme.txt': 'x', 'folder/b.txt': 'y' }, 'unknown-zip', /does not contain content\.xml/],
    [{ 'a.zip': 'x', 'b.txt': '', 'c.txt': '', 'd.txt': '' }, 'unknown-zip', /content\.xml/],
  ])('detects %j as %s', async (files, kind, reason) => {
    const d = detectPackage(await archiveOf(files as Record<string, string>));
    expect(d.kind).toBe(kind);
    if (d.kind !== 'elpx') expect(d.reason).toMatch(reason);
  });

  it('recognizes eXeLearning 3.0 ODE-ID folders', () => {
    expect(isOdeIdFolder('20251009090601SQPBIF')).toBe(true);
    expect(isOdeIdFolder('20251009090601sqpbif')).toBe(false);
    expect(isOdeIdFolder('2025100909060SQPBIF')).toBe(false);
    expect(isOdeIdFolder('photos')).toBe(false);
  });
});

describe('DataGame codecs', () => {
  it('implements the legacy escape()/unescape() semantics exactly', () => {
    const samples = ['plain-ASCII_09@*+./', 'a b&c=d?e#f', 'café ñ ü', '€ 中文 😀', '\u0000ÿĀ'];
    for (const s of samples) {
      expect(jsEscape(s)).toBe(escape(s));
      expect(jsUnescape(jsEscape(s))).toBe(s);
    }
    // Malformed sequences are left as they are, like the browser does.
    for (const s of ['%', '%z1', '%u12', '%u12zz', 'a%2', '100%']) expect(jsUnescape(s)).toBe(unescape(s));
    expect(jsUnescape('%41%u0042%e9')).toBe('ABé');
  });

  it('round-trips the XOR 146 obfuscation used by games', () => {
    const json = JSON.stringify({ url: '{{context_path}}/content/resources/león.png', t: 'Acción € 😀' });
    const payload = encryptDataGame(json);
    expect(payload).not.toContain('{');
    expect(payload).toMatch(/^[A-Za-z0-9@*_+\-./%]+$/);
    expect(decryptDataGame(payload)).toBe(json);
    // The upstream decrypt treats the literal strings "undefined" and "null" as empty.
    expect(decryptDataGame('undefined')).toBe('');
    expect(decryptDataGame('null')).toBe('');
  });

  it('classifies bodies and extracts the game prefix', () => {
    expect(dataGameEncoding('   ')).toBe('empty');
    expect(dataGameEncoding('  {"a":1}')).toBe('json');
    expect(dataGameEncoding('%E9%B0')).toBe('xor');
    expect(dataGamePrefix('js-hidden clasifica-DataGame')).toBe('clasifica');
    expect(dataGamePrefix('electrical-circuits-DataGame')).toBe('electrical-circuits');
    expect(dataGamePrefix('js-hidden exe-text')).toBeUndefined();
  });

  it('matches every link-anchor class family, with an optional index suffix', () => {
    for (const cls of [
      'clasifica-LinkImages',
      'ordena-LinkImages-1',
      'x-LinkImagesBack',
      'x-LinkAudiosClue',
      'x-LinkBack',
      'x-LinkWordings',
      'x-LinkLocalVideo',
      'x-LinkTextsPoints',
    ]) {
      expect(DATAGAME_LINK_CLASS.test(cls)).toBe(true);
    }
    expect(DATAGAME_LINK_CLASS.test('x-LinkFoo')).toBe(false);
    expect(DATAGAME_LINK_CLASS.test('clasifica-DataGame')).toBe(false);
  });
});

describe('libs/elpx-manifest.js', () => {
  const text = manifestText(['content.xml', 'index.html', 'content/resources/a.png'], 'Título');

  it('parses the upstream format as data', () => {
    const m = okManifest(text);
    expect(m.version).toBe(1);
    expect(m.files).toEqual(['content.xml', 'index.html', 'content/resources/a.png', MANIFEST_PATH]);
    expect(m.projectTitle).toBe('Título');
    expect(m.prefix).toMatch(/^\/\*\*[\s\S]*\*\/\n$/);
    expect(m.extra).toEqual({});
  });

  it.each([
    ['var files = [];', /assignment not found/],
    ['alert(1);\nwindow.__ELPX_MANIFEST__={"files":[]};', /unexpected code before/],
    ['window.__ELPX_MANIFEST__={files:["a"]};', /not JSON data: /],
    ['window.__ELPX_MANIFEST__=["a"];', /not an object/],
    ['window.__ELPX_MANIFEST__=null;', /not an object/],
    ['window.__ELPX_MANIFEST__={"files":"a"};', /not a list of strings/],
    ['window.__ELPX_MANIFEST__={"files":["a",1]};', /not a list of strings/],
  ])('rejects %j', (bad, message) => {
    const m = parseManifest(bad);
    expect('error' in m && m.error).toMatch(message);
  });

  it('accepts line comments before the assignment and keeps unknown keys', () => {
    const m = okManifest(
      '// generated\nwindow.__ELPX_MANIFEST__ = {"files":["a"],"basePath":"../","isPreview":false,"n":[1.5,null,{"k":true}],"projectTitle":7}',
    );
    expect(m.version).toBe(1);
    expect(m.projectTitle).toBeUndefined();
    expect(m.extra).toEqual({ basePath: '../', isPreview: false, n: [1.5, null, { k: true }], projectTitle: undefined });
    expect(Object.keys(m.extra)).toEqual(['basePath', 'isPreview', 'n']);
  });

  it('renders the final entry list in upstream order with the self-reference last', () => {
    const m = okManifest(manifestText(['b.txt', 'a.txt', 'gone.txt', 'b.txt'], 'T'));
    const out = renderManifest(m, ['a.txt', 'dir/', 'new.txt', MANIFEST_PATH, 'b.txt']);
    expect(out.startsWith(m.prefix)).toBe(true);
    expect(out.endsWith('};\n')).toBe(true);
    const again = okManifest(out);
    expect(again.files).toEqual(['b.txt', 'a.txt', 'new.txt', MANIFEST_PATH]);
    expect(again.projectTitle).toBe('T');
    expect(out).toContain('window.__ELPX_MANIFEST__={\n  "version": 1,\n  "files": [\n');
    // Title-less manifests stay title-less; extra keys survive.
    const bare = okManifest('window.__ELPX_MANIFEST__={"version":2,"files":["x"],"basePath":""};');
    const rendered = okManifest(renderManifest(bare, ['x', 'y']));
    expect(rendered).toMatchObject({ version: 2, files: ['x', 'y', MANIFEST_PATH], projectTitle: undefined, extra: { basePath: '' } });
  });

  it('diffs a manifest against the archive entries', () => {
    const m = okManifest(manifestText(['a', 'stale/b'], 'T'));
    expect(manifestDiff(m, ['a', 'c', 'dir/', MANIFEST_PATH])).toEqual({ missing: ['stale/b'], unlisted: ['c'] });
    expect(manifestDiff(m, ['a', 'stale/b', MANIFEST_PATH])).toEqual({ missing: [], unlisted: [] });
  });

  it('reads the stale manifest of the real v4 fixture', async () => {
    const archive = await openZip(new MemoryByteSource(upstream('un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx')), NATIVE_LIMITS);
    const { readEntryBytes } = await import('../../../src/core/zip/reader.js');
    const bytes = await readEntryBytes(archive, archive.byName.get(MANIFEST_PATH)!, 1 << 20);
    const m = okManifest(new TextDecoder().decode(bytes));
    const diff = manifestDiff(
      m,
      archive.entries.map((e) => e.name),
    );
    expect(diff.missing.filter((f) => /^content\/resources\/2025100909060[0-9][A-Z0-9]{6}\//.test(f))).toHaveLength(7);
    expect(m.files.at(-1)).toBe(MANIFEST_PATH);
  });
});

describe('parseContentXml', () => {
  it('builds the page/block/component model of a v4 document', () => {
    const xml = odeXml({
      props: [
        ['pp_title', 'Curso'],
        ['pp_lang', 'es'],
      ],
      pages: [
        {
          id: 'p1',
          name: 'Uno',
          blocks: [
            {
              id: 'b1',
              name: 'B',
              components: [
                { id: 'c1', type: 'text', html: '<p>x</p>', json: { a: 1 } },
                { id: 'c2', type: 'rubric', html: '<p>y</p>' },
              ],
            },
          ],
        },
        { id: 'p2', name: 'Dos', parent: 'p1', blocks: [] },
      ],
    });
    const doc = parseContentXml(xml, 64);
    expect(doc.variant).toBe('v4');
    expect(doc.hasDoctype).toBe(true);
    expect(doc.resources).toEqual({ odeId: '20260115100000TESTAB', exe_version: '4.0.5' });
    expect(doc.properties.map((p) => [p.key, p.value.text])).toEqual([
      ['pp_title', 'Curso'],
      ['pp_lang', 'es'],
    ]);
    expect(doc.pages.map((p) => [p.id, p.parentId, p.name, p.order, p.blocks.length])).toEqual([
      ['p1', '', 'Uno', '0', 1],
      ['p2', 'p1', 'Dos', '1', 0],
    ]);
    expect(doc.components.map((c) => [c.id, c.type, c.pageId, c.blockId])).toEqual([
      ['c1', 'text', 'p1', 'b1'],
      ['c2', 'rubric', 'p1', 'b1'],
    ]);
    expect(doc.components[0]!.jsonProperties?.text).toBe('{"a":1}');
    expect(doc.components[1]!.jsonProperties?.text).toBe('');
    expect(doc.diagnostics).toEqual([]);
    expect(componentLocation(doc, doc.components[1]!)).toEqual({ pageId: 'p1', pageName: 'Uno', blockId: 'b1', ideviceId: 'c2', ideviceType: 'rubric' });
  });

  it('parses the entity-escaped v3.0 form and the real v3 fixture', async () => {
    const doc = parseContentXml(odeXml({ variant: 'v3', components: [{ html: '<p>a &amp; b</p>', json: '{"x":"<b>"}' }] }), 64);
    expect(doc.variant).toBe('v3');
    expect(doc.hasDoctype).toBe(false);
    expect(doc.components[0]!.htmlView?.text).toBe('<p>a &amp; b</p>');
    expect(doc.components[0]!.htmlView?.chunks[0]!.chunk.kind).toBe('text');
    expect(doc.resources['eXeVersion']).toBe('v3.0.2');
    const archive = await openZip(new MemoryByteSource(upstream('Un contenido de ejemplo para probar estilos y catalogación.elpx')), NATIVE_LIMITS);
    const { readEntryBytes } = await import('../../../src/core/zip/reader.js');
    const real = parseContentXml(new TextDecoder().decode(await readEntryBytes(archive, archive.byName.get('content.xml')!, 1 << 22)), 512);
    expect(real.variant).toBe('v3');
    expect(real.pages.length).toBeGreaterThan(5);
  });

  it('infers v4 from the version attribute or CDATA when the namespace is absent', () => {
    expect(parseContentXml('<ode version="2.0"><odeNavStructures/></ode>', 10).variant).toBe('v4');
    const cdataOnly = odeXml({ components: [{ html: '<p/>' }] })
      .replace(/<!DOCTYPE[^>]*>\n/, '')
      .replace(/<ode [^>]*>/, '<ode>');
    expect(parseContentXml(cdataOnly, 20).variant).toBe('v4');
    expect(parseContentXml(`<ode xmlns="${ODE_NAMESPACE}"/>`, 10).variant).toBe('v4');
    expect(parseContentXml('<x:ode xmlns:x="urn:x"><x:odeNavStructures/></x:ode>', 10).variant).toBe('v3');
  });

  it('reports structural problems without throwing', () => {
    const xml = odeXml({
      pages: [
        {
          id: 'dup',
          name: 'A',
          blocks: [
            {
              id: 'dup',
              components: [
                { id: 'c', type: 'text' },
                { id: 'c', type: 'text' },
                { id: '', type: '' },
              ],
            },
          ],
        },
        { id: '', name: 'Sin id', blocks: [{ id: '', components: [] }] },
        { id: 'orphan', name: 'Huérfana', parent: 'nowhere', blocks: [] },
      ],
    });
    const doc = parseContentXml(xml, 64);
    const byCode = (c: string) => doc.diagnostics.filter((d) => d.code === c).map((d) => d.message);
    expect(byCode('ode-duplicate-id')).toEqual(['Id "dup" is used by more than one block/page', 'Id "c" is used by more than one component/component']);
    expect(byCode('ode-structure')).toEqual(['A component has no odeIdeviceId or odeIdeviceTypeName', 'A page has no odePageId', 'A block has no odeBlockId']);
    expect(byCode('ode-orphan-page')).toEqual(['Page "Huérfana" points to a missing parent page']);
    expect(componentLocation(doc, { ...doc.components[0]!, pageId: 'unknown' }).pageName).toBe('');
  });

  it('tolerates optional elements that are entirely absent', () => {
    const xml =
      '<ode><odeNavStructures>' +
      '<odeNavStructure><odePagStructures><odePagStructure><odeBlockId>b1</odeBlockId></odePagStructure></odePagStructures></odeNavStructure>' +
      '<odeNavStructure><odePageId>p2</odePageId><odePagStructures><odePagStructure><odeBlockId>b2</odeBlockId><odeComponents>' +
      '<odeComponent><odeIdeviceId>c1</odeIdeviceId><odeIdeviceTypeName>text</odeIdeviceTypeName></odeComponent>' +
      '</odeComponents></odePagStructure></odePagStructures></odeNavStructure>' +
      '<odeNavStructure><odePageId>p3</odePageId></odeNavStructure>' +
      '</odeNavStructures></ode>';
    const doc = parseContentXml(xml, 20);
    expect(doc.pages.map((p) => [p.id, p.name, p.order, p.blocks.map((b) => [b.id, b.name, b.components.length])])).toEqual([
      ['', '', '', [['b1', '', 0]]],
      ['p2', '', '', [['b2', '', 1]]],
      ['p3', '', '', []],
    ]);
    expect(doc.components[0]).toMatchObject({ id: 'c1', htmlView: undefined, jsonProperties: undefined });
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['ode-structure']);
  });

  it('reports a project without pages', () => {
    expect(parseContentXml('<ode><odeResources><odeResource><key>odeId</key></odeResource></odeResources></ode>', 10)).toMatchObject({
      resources: { odeId: '' },
      pages: [],
      diagnostics: [expect.objectContaining({ code: 'ode-missing-nav', severity: 'warning' })],
    });
    expect(parseContentXml('<ode><odeNavStructures></odeNavStructures></ode>', 10).diagnostics[0]!.code).toBe('ode-missing-nav');
  });

  it.each([
    ['<instance xmlns="http://www.exelearning.org/content/v0.3"/>', 'legacy-elp'],
    ['<dictionary/>', 'legacy-elp'],
    ['<html><body/></html>', 'content-xml-invalid'],
    ['<ode><unclosed></ode>', 'content-xml-invalid'],
    ['<!DOCTYPE ode [<!ENTITY x SYSTEM "file:///etc/passwd">]><ode>&x;</ode>', 'xml-security'],
  ])('rejects %j', (xml, code) => {
    let error: unknown;
    try {
      parseContentXml(xml, 20);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ElpxError);
    expect((error as ElpxError).code).toBe(code);
  });
});
