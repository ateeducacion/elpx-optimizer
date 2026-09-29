import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { encryptDataGame } from '../../../src/core/format/datagame.js';
import { sha256Hex } from '../../../src/core/io/hash.js';
import { applyEdits } from '../../../src/core/parse/text-map.js';
import { analyzeBytes, buildElpx, codes, diags, enc, entry, limits, media, odeXml, page, refs, zipFiles } from '../../helpers/core-kit.js';
import { fakeMp4 } from '../../helpers/fake-platform.js';

const R = '{{context_path}}/content/resources';
const PNG = media('palette-efficient.png');
const JPG = media('efficient.jpg');

describe('the four iDevice storage patterns', () => {
  const textHtml = `<p><img src="${R}/texto.png" alt=""></p>`;
  const mapa = JSON.stringify({ url: `${R}/juego/mapa.png`, points: [{ x: 1 }] });
  const secret = encryptDataGame(JSON.stringify({ url: `${R}/juego/secreto.png`, stale: 'files/tmp/2025/10/24/20251024113355JKQMOB/leon.png' }));
  const games =
    `<div class="mapa-IDevice"><div class="mapa-DataGame js-hidden">${mapa}</div></div>` +
    `<div class="clasifica-IDevice"><div class="clasifica-version js-hidden">2</div><div class="clasifica-DataGame js-hidden">${secret}</div>` +
    `<a href="${R}/juego/leon.png" class="js-hidden clasifica-LinkImages">0</a><a href="${R}/juego/leon2.png" class="js-hidden clasifica-LinkImages-1">1</a></div>`;
  const slides = JSON.stringify({ slides: [{ type: 'image', url: `${R}/iv/s1.png`, startTime: 1 }] });
  const iv =
    `<div class="exe-interactive-video"><p id="exe-interactive-video-file" class="js-hidden"><a href="${R}/iv/clase.mp4">mp4</a></p>` +
    `<div id="exe-interactive-video-contents" style="display: none">${slides}</div>` +
    `<script id="exe-interactive-video-contents" type="application/json">${slides.replace('s1', 's2')}</script></div>` +
    `<p class="sr-av"><video class="mediaelement"><source src="${R}/iv/clase.mp4" /></video></p>`;
  const rubric = `<table class="exe-table"><tr><td><a href="${R}/rubrica.pdf">Rúbrica</a></td></tr></table>`;
  const bytes = buildElpx({
    components: [
      { id: 'c-text', type: 'text', html: textHtml, json: { ideviceId: 'c-text', textTextarea: textHtml } },
      { id: 'c-games', type: 'classify', html: games },
      { id: 'c-iv', type: 'interactive-video', html: iv },
      { id: 'c-rubric', type: 'rubric', html: rubric },
    ],
    files: {
      'content/resources/texto.png': PNG,
      'content/resources/juego/mapa.png': media('alpha-text.png'),
      'content/resources/juego/secreto.png': media('animated.png'),
      'content/resources/juego/leon.png': JPG,
      'content/resources/juego/leon2.png': media('progressive.jpg'),
      'content/resources/iv/s1.png': media('lossless-alpha.webp'),
      'content/resources/iv/s2.png': media('deep-16bit.png'),
      'content/resources/iv/clase.mp4': fakeMp4(3000),
      'content/resources/rubrica.pdf': '%PDF-1.4\n',
    },
  });

  it('finds references in htmlView, jsonProperties, DataGame payloads, link anchors and the interactive-video JSON', async () => {
    const a = await analyzeBytes(bytes);
    expect(a.result.ok).toBe(true);
    const text = refs(a, 'texto.png');
    expect(text.map((r) => [r.location.field, r.via.join('>')])).toEqual([
      ['htmlView', 'xml-cdata>html-attribute'],
      ['jsonProperties', 'xml-cdata>json-string>html>html-attribute'],
    ]);
    expect(text[1]!.location).toMatchObject({
      jsonPath: '$.textTextarea',
      ideviceId: 'c-text',
      ideviceType: 'text',
      pageId: 'page-1',
      pageName: 'Page 1',
      blockId: 'block-1',
      element: 'img',
      attribute: 'src',
    });
    expect(refs(a, 'mapa.png')[0]!.via).toEqual(['xml-cdata', 'html-text', 'datagame-json', 'json-string']);
    expect(refs(a, 'juego/leon.png').map((r) => [r.kind, r.status])).toEqual([['explicit', 'resolved']]);
    expect(refs(a, 'leon2.png')[0]!.location.element).toBe('a');
    expect(refs(a, 's1.png')[0]!.location.jsonPath).toBe('$.slides[0].url');
    expect(refs(a, 's2.png')[0]!.location.field).toBe('htmlView#exe-interactive-video-contents');
    expect(refs(a, 'clase.mp4')).toHaveLength(2);
    expect(refs(a, 'rubrica.pdf')[0]!.location.ideviceType).toBe('rubric');
    for (const p of ['texto.png', 'juego/mapa.png', 'juego/leon.png', 'juego/leon2.png', 'iv/s1.png', 'iv/s2.png', 'iv/clase.mp4', 'rubrica.pdf']) {
      expect(entry(a, `content/resources/${p}`).usage).toBe('used');
    }
    expect(entry(a, 'content/resources/texto.png')).toMatchObject({ references: 2, referencedFrom: ['content.xml'], representations: ['editable'] });
  });

  it('treats URLs inside obfuscated payloads as possible references only', async () => {
    const a = await analyzeBytes(bytes);
    const secreto = entry(a, 'content/resources/juego/secreto.png');
    expect(secreto).toMatchObject({ usage: 'uncertain', usageReasons: ['possible reference in script or obfuscated data'], references: 0 });
    expect(refs(a, 'secreto.png')[0]).toMatchObject({ kind: 'dynamic', rewritable: false, via: ['xml-cdata', 'html-text', 'datagame-xor', 'json-string'] });
    expect(diags(a, 'dynamic-reference').map((d) => d.resource)).toContain('content/resources/juego/secreto.png');
    // The stale editor path inside the payload is not reported as missing.
    expect(diags(a, 'missing-resource')).toEqual([]);
  });
});

describe('content.xml variants', () => {
  it('rewrites-ready references in entity-escaped v3.0 content with ODE-ID folders', async () => {
    const html = '<p><img src="{{context_path}}/20251009090601SQPBIF/00.jpg" alt="a &amp; b"></p>';
    const a = await analyzeBytes(
      buildElpx({ variant: 'v3', components: [{ html, json: { textTextarea: html } }], files: { 'content/resources/20251009090601SQPBIF/00.jpg': JPG } }),
    );
    expect(a.result.package?.variant).toBe('v3');
    const r = refs(a, '00.jpg');
    expect(r.map((x) => [x.via[0], x.target, x.rewritable, x.lenient])).toEqual([
      ['xml-text', 'content/resources/20251009090601SQPBIF/00.jpg', true, undefined],
      ['xml-text', 'content/resources/20251009090601SQPBIF/00.jpg', true, undefined],
    ]);
    expect(a.result.package?.exeVersion).toBe('v3.0.2');
    expect(a.result.package?.legacyFolders).toEqual({ folders: 1, files: 1 });
    expect(codes(a)).toEqual(['legacy-resource-folders']);
  });

  it('scans HTML and text in ODE properties but never the base64 screenshot copy', async () => {
    const a = await analyzeBytes(
      buildElpx({
        props: [
          ['pp_title', 'T'],
          ['pp_extraHeadContent', `<link rel="stylesheet" href="${R}/extra.css">`],
          ['footer', `Logo: ${R}/pie.png`],
          ['pp_screenshot', `data:image/png;base64,AAAA ${R}/z.png`],
          ['pp_empty', ''],
        ],
        components: [],
        files: { 'content/resources/extra.css': 'p{}', 'content/resources/pie.png': PNG, 'content/resources/z.png': JPG },
      }),
    );
    expect(refs(a, 'extra.css')[0]!.location.field).toBe('odeProperty:pp_extraHeadContent');
    expect(refs(a, 'pie.png')[0]!.via).toEqual(['xml-text']);
    expect(refs(a, 'z.png')).toEqual([]);
    expect(entry(a, 'content/resources/z.png').usage).toBe('unreferenced');
    expect(diags(a, 'pp-screenshot-duplicate')[0]!.message).toMatch(/embeds a \d+-character base64 screenshot/);
  });

  it('protects a favicon that nothing references: sites and themes find it by its name', async () => {
    const a = await analyzeBytes(
      buildElpx({
        components: [],
        files: { 'content/resources/favicon.ico': 'ico', 'content/resources/img/FAVICON.PNG': PNG, 'content/resources/favicon-old.png': PNG },
      }),
    );
    expect(entry(a, 'content/resources/favicon.ico').usage).toBe('protected');
    expect(entry(a, 'content/resources/favicon.ico').usageReasons).toEqual(['site icon (favicon), used by its name']);
    expect(entry(a, 'content/resources/img/FAVICON.PNG').usage).toBe('protected');
    expect(entry(a, 'content/resources/favicon-old.png').usage).toBe('unreferenced');
  });
});

describe('reference forms and resolution rules', () => {
  const html = [
    `<img src="{{context_path}}/fotos/sol.jpg">`,
    `<a href="${R}/doc%20final.pdf">pdf</a>`,
    `<img src="${R}/foto&amp;paisaje.jpg">`,
    `<img src="${R}/cafe\u0301.png">`,
    `<img src="${R}/Mayus.PNG">`,
    `<img src="{{context_path}}/logo.png">`,
    `<img src="${R}//d//x.png">`,
    `<img src="${R}/a#1.png">`,
    `<img src="asset://3f7a1c2e-0000-4000-8000-123456789abc.jpg">`,
    `<a href="/raiz.html">raíz</a><a href="file:///C:/Users/profe/foto.png">local</a>`,
    `<a href="https://example.org/recurso">ext</a><a href="exe-node:page-2">p2</a><a href="exe-package:elp" download="exe-package:elp-name">dl</a>`,
    `<img src="{{context_path}}/nada.png"><img src="{{context_path}}/nada.png">`,
    `<img srcset="${R}/x1.png 1x, ${R}/x2.png 2x">`,
    `<video poster="${R}/poster.jpg"><track kind="captions" src="${R}/subs.vtt"></video>`,
  ].join('\n');
  const files = {
    'content/resources/fotos/sol.jpg': JPG,
    'content/resources/doc final.pdf': '%PDF-1.4\n',
    'content/resources/foto&paisaje.jpg': media('progressive.jpg'),
    'content/resources/caf\u00e9.png': PNG,
    'content/resources/mayus.png': media('alpha-text.png'),
    'content/resources/a/logo.png': media('lossless-alpha.webp'),
    'content/resources/b/logo.png': media('animated.gif'),
    'content/resources/d/x.png': media('deep-16bit.png'),
    'content/resources/a#1.png': media('animated.png'),
    'content/resources/imports/3f7a1c2e-0000-4000-8000-123456789abc.jpg': media('cmyk.jpg'),
    'content/resources/x1.png': media('jpeg-named.png'),
    'content/resources/x2.png': media('photo-exif-icc.jpg'),
    'content/resources/poster.jpg': media('truncated.jpg'),
    'content/resources/subs.vtt': 'WEBVTT\n',
    'content/resources/otra/perdida.png': PNG,
    'index.html': '<!DOCTYPE html><html><body><img src="img/perdida.png"></body></html>',
  };

  it('resolves each form with the right status, rule and diagnostic', async () => {
    const a = await analyzeBytes(buildElpx({ components: [{ html }], files }));
    const one = (v: string) => {
      const list = refs(a, v);
      expect(list.length).toBeGreaterThan(0);
      return list[0]!;
    };
    expect(one('fotos/sol.jpg')).toMatchObject({ form: 'context-path', status: 'resolved', target: 'content/resources/fotos/sol.jpg' });
    expect(one('doc%20final.pdf')).toMatchObject({ status: 'resolved', percentEncoded: true, target: 'content/resources/doc final.pdf' });
    expect(one('foto&paisaje.jpg')).toMatchObject({ status: 'resolved', target: 'content/resources/foto&paisaje.jpg', rewritable: true });
    expect(one('cafe\u0301.png')).toMatchObject({ status: 'resolved', lenient: 'unicode', target: 'content/resources/caf\u00e9.png' });
    expect(one('Mayus.PNG')).toMatchObject({ lenient: 'case', target: 'content/resources/mayus.png' });
    expect(one('/logo.png')).toMatchObject({ status: 'ambiguous', candidates: ['content/resources/a/logo.png', 'content/resources/b/logo.png'] });
    expect(one('//d//x.png')).toMatchObject({ lenient: 'double-slash', target: 'content/resources/d/x.png' });
    expect(one('a#1.png')).toMatchObject({ lenient: 'literal-special', target: 'content/resources/a#1.png' });
    expect(one('asset://')).toMatchObject({ form: 'asset-uri', status: 'unmapped' });
    expect(one('/raiz.html')).toMatchObject({ form: 'root-relative', status: 'unresolvable' });
    expect(one('file:///')).toMatchObject({ form: 'local-file', status: 'unresolvable' });
    expect(one('exe-package:elp')).toMatchObject({ form: 'pseudo', status: 'ignored' });
    expect(refs(a, 'nada.png').map((r) => r.status)).toEqual(['missing', 'missing']);
    expect(one('x2.png').location.attribute).toBe('srcset');
    expect(one('poster.jpg').location.attribute).toBe('poster');
    expect(one('subs.vtt').location.element).toBe('track');

    const d = (code: string) => diags(a, code).map((x) => x.resource ?? x.message);
    // Two identical broken references in the same place are reported once.
    expect(diags(a, 'missing-resource')).toEqual([
      expect.objectContaining({ severity: 'error', resource: 'img/perdida.png', location: expect.objectContaining({ entry: 'index.html' }) }),
      expect.objectContaining({ severity: 'error', resource: 'nada.png', details: { reference: '{{context_path}}/nada.png', form: 'context-path' } }),
    ]);
    expect(d('percent-encoded-reference')).toEqual(['content/resources/doc final.pdf']);
    expect(d('lenient-resolution').sort()).toEqual([
      'content/resources/a#1.png',
      'content/resources/caf\u00e9.png',
      'content/resources/d/x.png',
      'content/resources/mayus.png',
    ]);
    expect(diags(a, 'ambiguous-reference')[0]).toMatchObject({
      severity: 'warning',
      details: { candidates: ['content/resources/a/logo.png', 'content/resources/b/logo.png'] },
    });
    expect(diags(a, 'asset-uri-unmapped')).toHaveLength(1);
    expect(diags(a, 'root-relative-reference').map((x) => x.message)).toEqual([
      '"/raiz.html" cannot be resolved inside the package',
      '"file:///C:/Users/profe/foto.png" cannot be resolved inside the package',
    ]);
    expect(diags(a, 'external-reference')[0]).toMatchObject({ severity: 'info', details: { url: 'https://example.org/recurso' } });
  });

  it('protects files that lenient, ambiguous or unmapped references may point to', async () => {
    const a = await analyzeBytes(buildElpx({ components: [{ html }], files }));
    const usage = (p: string) => [entry(a, `content/resources/${p}`).usage, ...entry(a, `content/resources/${p}`).usageReasons];
    expect(usage('fotos/sol.jpg')).toEqual(['used']);
    expect(usage('caf\u00e9.png')).toEqual(['uncertain', 'lenient match (unicode)']);
    expect(usage('mayus.png')).toEqual(['uncertain', 'lenient match (case)']);
    expect(usage('a/logo.png')).toEqual(['uncertain', 'same file name as a missing or ambiguous reference']);
    expect(usage('otra/perdida.png')).toEqual(['uncertain', 'same file name as a missing or ambiguous reference']);
    expect(usage('imports/3f7a1c2e-0000-4000-8000-123456789abc.jpg')).toEqual(['uncertain', 'possible target of an asset:// reference']);
    expect(entry(a, 'content/resources/doc final.pdf').references).toBe(1);
  });

  it('keeps whole placeholder values with spaces in JSON as one reference', async () => {
    const mapa = `<div class="mapa-DataGame js-hidden">${JSON.stringify({ url: `${R}/juego/mi mapa.png`, text: `${R}/fondo.png es el fondo` })}</div>`;
    const a = await analyzeBytes(
      buildElpx({
        components: [
          { type: 'map', html: mapa },
          { type: 'file-attachment', html: '<p/>', json: { files: [{ url: `${R}/Guía del curso.pdf`, filename: 'Guía del curso.pdf' }] } },
        ],
        files: { 'content/resources/juego/mi mapa.png': PNG, 'content/resources/Guía del curso.pdf': '%PDF-1.4\n', 'content/resources/fondo.png': JPG },
      }),
    );
    expect(entry(a, 'content/resources/juego/mi mapa.png').usage).toBe('used');
    expect(entry(a, 'content/resources/Guía del curso.pdf').usage).toBe('used');
    // Prose that merely starts with a placeholder is still cut at the first space.
    expect(entry(a, 'content/resources/fondo.png').usage).toBe('used');
    expect(diags(a, 'missing-resource')).toEqual([]);
  });

  it('resolves doubly escaped quotes like eXeLearning, but only leniently', async () => {
    const a = await analyzeBytes(
      buildElpx({ components: [{ html: `<p><a href=\\"${R}/doc.pdf\\">guía</a></p>` }], files: { 'content/resources/doc.pdf': '%PDF-1.4\n' } }),
    );
    expect(refs(a, 'doc.pdf')[0]).toMatchObject({ status: 'resolved', target: 'content/resources/doc.pdf', lenient: 'escaped-quotes' });
    expect(diags(a, 'lenient-resolution')[0]).toMatchObject({ resource: 'content/resources/doc.pdf', details: { rule: 'escaped-quotes' } });
    expect(entry(a, 'content/resources/doc.pdf')).toMatchObject({ usage: 'uncertain', usageReasons: ['lenient match (escaped-quotes)'] });
    expect(diags(a, 'missing-resource')).toEqual([]);
  });

  it('reports several prefix matches, stale editor paths and dynamic references', async () => {
    const a = await analyzeBytes(
      buildElpx({
        components: [
          {
            html: '<img src="{{context_path}}/x.png"><script>var img = "content/resources/solo-js.png";</script>',
            json: { img: 'files/tmp/2025/10/24/20251024113355JKQMOB/leon.png', gone: 'files/tmp/2025/10/24/OTRO/gato.png' },
          },
        ],
        publish: true,
        files: {
          'x.png': PNG,
          'content/resources/x.png': PNG,
          'content/resources/20251024113355JKQMOB/leon.png': JPG,
          'content/resources/solo-js.png': media('alpha-text.png'),
        },
      }),
    );
    expect(refs(a, '{{context_path}}/x.png')[0]).toMatchObject({ status: 'resolved', target: 'x.png', lenient: 'multiple-prefixes' });
    expect(diags(a, 'ambiguous-reference')[0]).toMatchObject({
      severity: 'info',
      resource: 'x.png',
      message: expect.stringMatching(/eXeLearning uses x\.png/),
    });
    // The published page names it directly, so it is used, with the ambiguity recorded.
    expect(entry(a, 'content/resources/x.png')).toMatchObject({ usage: 'used', usageReasons: ['alternative match of an ambiguous reference'] });
    expect(diags(a, 'stale-editor-path')[0]).toMatchObject({ severity: 'info', resource: 'content/resources/20251024113355JKQMOB/leon.png' });
    expect(entry(a, 'content/resources/20251024113355JKQMOB/leon.png').usageReasons).toEqual(['lenient match (stale-editor-path)']);
    expect(diags(a, 'missing-resource')).toEqual([expect.objectContaining({ severity: 'warning', resource: 'content/resources/OTRO/gato.png' })]);
    expect(
      diags(a, 'dynamic-reference')
        .filter((d) => d.resource === 'content/resources/solo-js.png')
        .map((d) => d.message),
    ).toEqual([
      'Possible reference to content/resources/solo-js.png in xml-cdata › html-text › code',
      'Possible reference to content/resources/solo-js.png in html-text › code',
    ]);
    expect(entry(a, 'content/resources/solo-js.png').usage).toBe('uncertain');
  });
});

describe('indirect dependencies and representations', () => {
  const bytes = buildElpx({
    components: [
      { html: `<link rel="stylesheet" href="${R}/web/estilo.css"><img src="${R}/dibujo.svg"><img src="${R}/ambos.png"><img src="${R}/solo-editable.png">` },
      { type: 'magnifier', html: `<img src="${R}/lupa.jpg">` },
    ],
    files: {
      'index.html': page(`<img src="content/resources/ambos.png"><img src="content/resources/solo-publicado.png"><a href="html/dos.html">2</a>`),
      'html/dos.html': page(`<link rel="stylesheet" href="../theme/style.css"><img src="../content/resources/sub%20dir/b.png">`),
      'content/resources/web/estilo.css': '@import "base2.css";\nbody{background:url(fondo.png)}\n.x{background:url(../falta.png)}',
      'content/resources/web/base2.css': 'p{color:red}',
      'content/resources/web/fondo.png': PNG,
      'content/resources/dibujo.svg':
        '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="textura.png"/><image href="textura2.png"/></svg>',
      'content/resources/textura.png': media('alpha-text.png'),
      'content/resources/textura2.png': JPG,
      'content/resources/ambos.png': PNG,
      'content/resources/solo-editable.png': media('deep-16bit.png'),
      'content/resources/solo-publicado.png': media('animated.png'),
      'content/resources/sub dir/b.png': media('lossless-alpha.webp'),
      'content/resources/lupa.jpg': media('photo-exif-icc.jpg'),
      'theme/style.css': 'body{background:url(img/bg.png)}\n.y{background:url(img/none.png)}',
      'theme/img/bg.png': PNG,
      'content/resources/applet/index.html': page('<script src="app.js"></script><img src="img.png">'),
      'content/resources/applet/app.js': 'var x = 1;',
      'content/resources/applet/img.png': PNG,
      'content/resources/applet/huerfana.png': JPG,
      'content/resources/datos.json': '{"a":1}',
      'content/resources/20251009090601SQPBIF/pagina.html': page('x'),
      'custom/Mi foto.png': PNG,
    },
  });

  it('follows CSS url()/@import, SVG images and published pages', async () => {
    const a = await analyzeBytes(bytes);
    expect(entry(a, 'content/resources/web/fondo.png')).toMatchObject({
      usage: 'used',
      representations: ['resource'],
      referencedFrom: ['content/resources/web/estilo.css'],
    });
    expect(entry(a, 'content/resources/web/base2.css').usage).toBe('used');
    expect(entry(a, 'content/resources/textura.png')).toMatchObject({ usage: 'used', referencedFrom: ['content/resources/dibujo.svg'] });
    expect(entry(a, 'content/resources/textura2.png').usage).toBe('used');
    expect(entry(a, 'content/resources/sub dir/b.png')).toMatchObject({ usage: 'used', representations: ['published'] });
    expect(entry(a, 'theme/img/bg.png')).toMatchObject({ role: 'runtime', usage: 'not-applicable', references: 1, representations: ['runtime'] });
    const missing = diags(a, 'missing-resource').map((d) => [d.resource, d.severity]);
    expect(missing).toEqual([
      ['content/resources/falta.png', 'error'],
      ['theme/img/none.png', 'warning'],
    ]);
    expect(refs(a, 'sub%20dir')[0]).toMatchObject({ percentEncoded: true, representation: 'published' });
  });

  it('records which representation references each file', async () => {
    const a = await analyzeBytes(bytes);
    expect(entry(a, 'content/resources/ambos.png').representations).toEqual(['editable', 'published']);
    expect(entry(a, 'content/resources/solo-editable.png').representations).toEqual(['editable']);
    expect(entry(a, 'content/resources/solo-publicado.png')).toMatchObject({ usage: 'used', representations: ['published'], referencedFrom: ['index.html'] });
    expect(entry(a, 'content/resources/lupa.jpg').resolutionSensitive).toBe(true);
    expect(entry(a, 'content/resources/ambos.png').resolutionSensitive).toBe(false);
  });

  it('reports files referenced only by the editable or only by the published representation', async () => {
    const a = await analyzeBytes(bytes);
    const only = (code: string) =>
      diags(a, code)
        .map((d) => d.resource)
        .sort();
    expect(only('reference-editable-only')).toEqual([
      'content/resources/dibujo.svg',
      'content/resources/lupa.jpg',
      'content/resources/solo-editable.png',
      'content/resources/web/estilo.css',
    ]);
    expect(only('reference-published-only')).toEqual(['content/resources/solo-publicado.png', 'content/resources/sub dir/b.png']);
    expect(diags(a, 'reference-published-only').find((d) => d.resource === 'content/resources/solo-publicado.png')).toMatchObject({
      severity: 'info',
      message: 'content/resources/solo-publicado.png is referenced from the exported pages but not from content.xml; eXeLearning drops it on the next export',
    });
    expect(diags(a, 'reference-editable-only')[0]!.message).toBe('content/resources/dibujo.svg is referenced from content.xml but not from the exported pages');
  });

  it('ignores runtime stylesheets and source-only packages for the representation checks', async () => {
    const theme = await analyzeBytes(
      buildElpx({
        components: [{ html: `<img src="${R}/editado.png">` }],
        files: {
          'index.html': page('<img src="content/resources/pagina.png"><img src="content/resources/editado.png">'),
          'theme/style.css': '.a{background:url(../content/resources/pagina.png)} .b{background:url(../content/resources/tema.png)}',
          'content/resources/pagina.png': PNG,
          'content/resources/editado.png': JPG,
          'content/resources/tema.png': media('alpha-text.png'),
          'search_index.js': `window.exeSearchData = ${JSON.stringify({ p: { html: `<img src="${R}/indice.png">` } })};`,
          'content/resources/indice.png': media('deep-16bit.png'),
        },
      }),
    );
    expect(diags(theme, 'reference-published-only').map((d) => d.resource)).toEqual(['content/resources/pagina.png']);
    expect(diags(theme, 'reference-editable-only').map((d) => d.resource)).toEqual(['content/resources/indice.png']);
    expect(entry(theme, 'content/resources/tema.png').representations).toEqual(['runtime']);
    const sourceOnly = await analyzeBytes(buildElpx({ components: [{ html: `<img src="${R}/a.png">` }], files: { 'content/resources/a.png': PNG } }));
    expect(codes(sourceOnly)).toEqual([]);
  });

  it('protects opaque HTML bundles and the legacy custom/ folder', async () => {
    const a = await analyzeBytes(bytes);
    expect(diags(a, 'opaque-bundle').map((d) => d.resource)).toEqual(['content/resources/applet/']);
    expect(entry(a, 'content/resources/applet/huerfana.png')).toMatchObject({
      usage: 'protected',
      usageReasons: ['inside content/resources/applet/, which contains HTML or scripts'],
    });
    expect(entry(a, 'content/resources/applet/img.png').usage).toBe('used');
    expect(entry(a, 'content/resources/datos.json').usage).toBe('unreferenced');
    expect(entry(a, 'content/resources/20251009090601SQPBIF/pagina.html').usage).toBe('unreferenced');
    expect(entry(a, 'custom/Mi foto.png')).toMatchObject({ usage: 'protected', usageReasons: ['legacy File Manager folder (references use altered names)'] });
  });
});

describe('duplicates', () => {
  it('groups byte-identical binary user assets only', async () => {
    const a = await analyzeBytes(
      buildElpx({
        components: [{ html: `<img src="${R}/a.png">` }],
        files: {
          'content/resources/a.png': PNG,
          'content/resources/copia/a2.png': PNG,
          'content/resources/a.bin': PNG,
          'content/resources/vacio1.png': new Uint8Array(0),
          'content/resources/vacio2.png': new Uint8Array(0),
          'content/resources/t1.txt': 'same text',
          'content/resources/t2.txt': 'same text',
          'theme/img/a.png': PNG,
          'theme/img/b.png': PNG,
          'content/resources/f1.jpg': JPG,
          'content/resources/f2.jpg': JPG,
          'content/resources/f3.jpg': JPG,
        },
      }),
    );
    expect(a.result.duplicates).toEqual([
      { id: 1, sha256: sha256Hex(PNG), size: PNG.length, format: 'png', paths: ['content/resources/a.png', 'content/resources/copia/a2.png'] },
      {
        id: 2,
        sha256: sha256Hex(JPG),
        size: JPG.length,
        format: 'jpeg',
        paths: ['content/resources/f1.jpg', 'content/resources/f2.jpg', 'content/resources/f3.jpg'],
      },
    ]);
    expect(entry(a, 'content/resources/copia/a2.png').duplicateGroup).toBe(1);
    expect(entry(a, 'content/resources/a.bin').duplicateGroup).toBeUndefined();
    expect(diags(a, 'duplicate-content').map((d) => d.message)).toEqual([
      `2 identical png files (${PNG.length} bytes each)`,
      `3 identical jpeg files (${JPG.length} bytes each)`,
    ]);
  });

  it('compares large entries stored and deflated with different chunking', async () => {
    const big = fakeMp4(3 * 1024 * 1024 + 123, 0);
    for (let i = 12; i < big.length; i++) big[i] = (i * 2654435761) >>> 27;
    const bytes = zipSync({
      'content.xml': enc.encode(odeXml({ components: [] })),
      'content/resources/v1.mp4': [big, { level: 0 }],
      'content/resources/v2.mp4': [big, { level: 9 }],
    });
    const a = await analyzeBytes(bytes);
    expect(a.result.duplicates.map((g) => g.paths)).toEqual([['content/resources/v1.mp4', 'content/resources/v2.mp4']]);
    expect(entry(a, 'content/resources/v2.mp4').method).toBe('deflate');
  });
});

describe('package-level checks', () => {
  it('reports a missing DTD, an invalid screenshot, extension mismatches and an invalid manifest', async () => {
    const a = await analyzeBytes(
      buildElpx({
        dtd: false,
        components: [{ html: `<img src="${R}/foto.png">` }],
        files: { 'screenshot.png': JPG, 'content/resources/foto.png': JPG, 'libs/elpx-manifest.js': 'console.log("not data")' },
      }),
    );
    expect(codes(a)).toEqual(['content-dtd-missing', 'extension-mismatch', 'manifest-invalid', 'screenshot-invalid']);
    expect(diags(a, 'extension-mismatch')[0]).toMatchObject({
      resource: 'content/resources/foto.png',
      message: 'content/resources/foto.png contains JPEG data',
      details: { format: 'jpeg' },
    });
    expect(entry(a, 'content/resources/foto.png').extensionMatches).toBe(false);
    expect(diags(a, 'manifest-invalid')[0]!.message).toBe('libs/elpx-manifest.js: window.__ELPX_MANIFEST__ assignment not found');
    expect(a.manifest).toBeUndefined();
  });

  it('accepts a fresh manifest and warns about hosted import limits', async () => {
    const fresh = await analyzeBytes(buildElpx({ components: [], manifest: true }));
    expect(codes(fresh)).toEqual([]);
    expect(fresh.manifest?.files.at(-1)).toBe('libs/elpx-manifest.js');
    const files: Record<string, string> = {};
    for (let i = 0; i < 10_001; i++) files[`content/resources/n/${i}.txt`] = '';
    const many = await analyzeBytes(buildElpx({ components: [], files }));
    expect(diags(many, 'limits-host-policy')).toHaveLength(1);
  });

  it('scans search_index.js as data when it has the upstream format', async () => {
    const data = { p1: { blocks: { b1: { idevices: { i1: { htmlView: `<img src="${R}/s.png">` } } } } } };
    const good = await analyzeBytes(
      buildElpx({ components: [], files: { 'search_index.js': `window.exeSearchData = ${JSON.stringify(data)};\n`, 'content/resources/s.png': PNG } }),
    );
    const r = good.references.find((x) => x.value.endsWith('/s.png'))!;
    expect(r).toMatchObject({ representation: 'search-index', rewritable: true, via: ['json', 'json-string', 'html', 'html-attribute'] });
    const text = good.texts.get('search_index.js')!.text;
    const edit = r.site!.lift({ start: r.site!.start, end: r.site!.end, text: `${R}/t.png` })!;
    expect(applyEdits(text, [edit])).toBe(text.replace('/s.png', '/t.png'));
    for (const broken of [`var exeSearchData = ${JSON.stringify(data)};`, `window.exeSearchData = {"p1": "<img src=\\"${R}/s.png\\">"`]) {
      const a = await analyzeBytes(buildElpx({ components: [], files: { 'search_index.js': broken, 'content/resources/s.png': PNG } }));
      expect(a.result.references.map((x) => [x.value, x.representation, x.rewritable])).toEqual([[`${R}/s.png`, 'search-index', false]]);
      expect(entry(a, 'content/resources/s.png').usage).toBe('used');
    }
  });

  it('leaves unreadable text entries unscanned instead of failing', async () => {
    const latin1 = new Uint8Array([...enc.encode('<p>caf'), 0xe9, ...enc.encode(`<img src="content/resources/a.png"></p>`)]);
    const binary = new Uint8Array([0x3c, 0x70, 0x3e, 0, 1, 2, 3]);
    const a = await analyzeBytes(
      buildElpx({
        components: [],
        files: {
          'index.html': latin1,
          'html/bin.html': binary,
          'html/big.html': page(`<img src="../content/resources/a.png">${' '.repeat(5000)}`),
          'content/resources/a.png': PNG,
        },
      }),
      { limits: limits({ maxTextEntryBytes: 3000 }) },
    );
    expect(a.result.ok).toBe(true);
    expect([...a.texts.keys()]).toEqual(['content.xml']);
    expect(entry(a, 'content/resources/a.png').usage).toBe('unreferenced');
    expect(entry(a, 'html/bin.html')).toMatchObject({ kind: 'unknown', format: 'binary' });
  });

  it('sniffs formats even when the first inflated chunk is tiny', async () => {
    const { craftZip } = await import('../../helpers/zip-craft.js');
    // A valid deflate stream: 100 bytes in a stored block, thousands of empty stored blocks, then the rest.
    const stored = (data: Uint8Array, final: boolean): Uint8Array => {
      const out = new Uint8Array(5 + data.length);
      out.set([final ? 1 : 0, data.length & 0xff, data.length >> 8, ~data.length & 0xff, (~data.length >> 8) & 0xff]);
      out.set(data, 5);
      return out;
    };
    const parts = [
      stored(PNG.subarray(0, 100), false),
      ...Array.from({ length: 4000 }, () => stored(new Uint8Array(0), false)),
      stored(PNG.subarray(100), true),
    ];
    const payload = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((o, p) => (payload.set(p, o), o + p.length), 0);
    const xml = odeXml({ components: [{ html: `<img src="${R}/lento.png">` }] });
    const a = await analyzeBytes(
      craftZip([
        { name: 'content.xml', data: xml },
        { name: 'content/resources/lento.png', data: PNG, method: 8, payload },
      ]),
    );
    expect(entry(a, 'content/resources/lento.png')).toMatchObject({
      kind: 'image',
      format: 'png',
      method: 'deflate',
      extensionMatches: true,
      image: expect.objectContaining({ width: expect.any(Number) }),
    });
  });

  it('reports ZIP warnings (case collisions, archive comments) as diagnostics', async () => {
    const { craftZip } = await import('../../helpers/zip-craft.js');
    const xml = odeXml({ components: [{ html: `<img src="${R}/Foto.png">` }] });
    const a = await analyzeBytes(
      craftZip(
        [
          { name: 'content.xml', data: xml },
          { name: 'content/resources/Foto.png', data: PNG },
          { name: 'content/resources/foto.png', data: JPG },
        ],
        { comment: 'made by hand' },
      ),
    );
    expect(codes(a)).toEqual(expect.arrayContaining(['zip-archive-comment', 'zip-case-collision']));
    expect(diags(a, 'zip-case-collision')[0]!.resource).toBe('content/resources/foto.png');
    expect(refs(a, 'Foto.png')[0]).toMatchObject({ status: 'resolved', target: 'content/resources/Foto.png' });
    expect(entry(a, 'content/resources/foto.png').usage).toBe('unreferenced');
    expect(zipFiles({})).toBeInstanceOf(Uint8Array);
  });
});
