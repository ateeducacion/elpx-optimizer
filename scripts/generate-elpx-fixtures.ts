#!/usr/bin/env bun
/**
 * Builds synthetic .elpx fixtures under test/fixtures/elpx from the media in
 * test/fixtures/media. The packages follow the v4 layout written by
 * eXeLearning at the pinned upstream SHA (see docs/upstream-review.md) and
 * cover cases missing from the upstream fixtures: file names with spaces,
 * "&" and non-ASCII characters, srcset, posters, subtitle tracks, plain and
 * obfuscated DataGame payloads with link anchors, a local interactive video,
 * the download-source-file manifest, duplicates, unused files and a video
 * that is deliberately inefficient.
 *
 * Usage: bun scripts/generate-elpx-fixtures.ts
 * The ZIPs are written with fflate (not with this project's writer), using a
 * fixed timestamp so that the output is reproducible.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptDataGame } from '../src/core/format/datagame.ts';
import { buildPackage as build, type Page } from '../test/helpers/elpx-builder.ts';

const enc = new TextEncoder();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const media = join(root, 'test', 'fixtures', 'media');
const out = join(root, 'test', 'fixtures', 'elpx');
mkdirSync(out, { recursive: true });
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(media, name)));

/** Builds a package using the palette PNG for runtime images. */
function buildPackage(...args: Parameters<typeof build> extends [unknown, ...infer R] ? R : never): Uint8Array {
  return build(read('palette-efficient.png'), ...args);
}

// ---------------------------------------------------------------- course-video.elpx
{
  const photo = read('photo-exif-icc.jpg');
  const textHtml =
    '<div class="exe-text"><p><video controls="controls" width="640" poster="{{context_path}}/content/resources/media/poster.jpg">' +
    '<source src="{{context_path}}/content/resources/media/clase 1.mp4" type="video/mp4">' +
    '<track kind="captions" src="{{context_path}}/content/resources/media/clase 1.vtt" srclang="es" label="Español"></video></p>' +
    '<p><img src="{{context_path}}/content/resources/fotos/foto&amp;paisaje.jpg" srcset="{{context_path}}/content/resources/fotos/foto&amp;paisaje.jpg 1x, {{context_path}}/content/resources/fotos/año-2x.png 2x" alt="Paisaje"></p></div>';
  const downloadHtml =
    '<div class="exe-download-package-instructions"><p>Descarga el proyecto editable.</p></div><p class="exe-download-package-link"><a download="exe-package:elp-name" href="exe-package:elp">Descargar el fichero .elpx</a></p>';
  const mapHtml =
    '<div class="mapa-IDevice"><div class="mapa-DataGame js-hidden">' +
    JSON.stringify({ url: '{{context_path}}/content/resources/juego/mapa.png', points: [{ x: 10, y: 20, title: 'Punto' }] }) +
    '</div><p>Mapa</p></div>';
  const xorPayload = encryptDataGame(
    JSON.stringify({
      wordsGame: [{ url: 'files/tmp/2025/10/24/20251024113355JKQMOB/leon.png' }, { url: '{{context_path}}/content/resources/juego/secreto.png' }],
    }),
  );
  const classifyHtml =
    `<div class="clasifica-IDevice"><div class="clasifica-version js-hidden">2</div><div class="clasifica-DataGame js-hidden">${xorPayload}</div>` +
    '<a href="{{context_path}}/content/resources/juego/leon.png" class="js-hidden clasifica-LinkImages">0</a>' +
    '<p><img src="{{context_path}}/content/resources/fotos/copia-foto.jpg" alt="Copia"></p></div>';
  const ivHtml =
    '<div class="exe-interactive-video"><p id="exe-interactive-video-file" class="js-hidden"><a href="{{context_path}}/content/resources/media/clase 1.mp4">mp4</a></p>' +
    `<div id="exe-interactive-video-contents" style="display: none">${JSON.stringify({ slides: [{ type: 'image', url: '{{context_path}}/content/resources/juego/diapositiva.png', startTime: 1 }], i18n: { start: 'Empezar' } })}</div></div>` +
    '<p class="sr-av"><video width="320" height="240" controls="controls" class="mediaelement"><source src="{{context_path}}/content/resources/media/clase 1.mp4" /></video></p>';
  const pages: Page[] = [
    {
      id: 'page-inicio-0001',
      name: 'Inicio',
      file: 'index.html',
      blocks: [
        {
          id: 'block-inicio-0001',
          name: 'Vídeo',
          components: [
            { id: 'idevice-text-0001', type: 'text', html: textHtml, json: { ideviceId: 'idevice-text-0001', textTextarea: textHtml } },
            { id: 'idevice-download-0001', type: 'download-source-file', html: downloadHtml },
          ],
        },
      ],
    },
    {
      id: 'page-juego-0002',
      name: 'Juego',
      file: 'html/juego.html',
      blocks: [
        {
          id: 'block-juego-0002',
          name: 'Juegos',
          components: [
            { id: 'idevice-map-0002', type: 'map', html: mapHtml },
            { id: 'idevice-classify-0002', type: 'classify', html: classifyHtml },
            { id: 'idevice-iv-0002', type: 'interactive-video', html: ivHtml },
          ],
        },
      ],
    },
  ];
  const assets = {
    'content/resources/media/clase 1.mp4': read('inefficient.mp4'),
    'content/resources/media/clase 1.vtt': read('captions.vtt'),
    'content/resources/media/poster.jpg': read('progressive.jpg'),
    'content/resources/fotos/foto&paisaje.jpg': photo,
    'content/resources/fotos/copia-foto.jpg': photo,
    'content/resources/fotos/año-2x.png': read('alpha-text.png'),
    'content/resources/juego/mapa.png': read('deep-16bit.png'),
    'content/resources/juego/leon.png': read('palette-efficient.png'),
    'content/resources/juego/secreto.png': read('animated.png'),
    'content/resources/juego/diapositiva.png': read('alpha-text.png'),
    'content/resources/sin-uso/viejo.webp': read('lossless-alpha.webp'),
  };
  writeFileSync(join(out, 'course-video.elpx'), buildPackage('Curso con vídeo', pages, assets, { download: true }));
}

// ---------------------------------------------------------------- efficient.elpx (no improvement expected)
{
  const html =
    '<p><video controls src="{{context_path}}/content/resources/clip.mp4"></video></p><p><img src="{{context_path}}/content/resources/foto.jpg" alt=""><img src="{{context_path}}/content/resources/icono.png" alt=""></p>';
  const pages: Page[] = [
    {
      id: 'page-1',
      name: 'Única',
      file: 'index.html',
      blocks: [{ id: 'block-1', name: '', components: [{ id: 'idevice-1', type: 'text', html, json: { textTextarea: html } }] }],
    },
  ];
  writeFileSync(
    join(out, 'efficient.elpx'),
    buildPackage('Ya optimizado', pages, {
      'content/resources/clip.mp4': read('efficient.mp4'),
      'content/resources/foto.jpg': read('efficient.jpg'),
      'content/resources/icono.png': read('optimal.png'),
    }),
  );
}

// ---------------------------------------------------------------- broken-refs.elpx (diagnostics)
{
  const html =
    '<p><img src="{{context_path}}/content/resources/no-existe.png" alt=""></p>' +
    '<p><img src="{{context_path}}/content/resources/Mayus.PNG" alt=""></p>' +
    '<p><img src="{{context_path}}/logo.png" alt=""></p>' +
    '<p><a href="{{context_path}}/content/resources/doc%20final.pdf">PDF</a></p>' +
    '<p><img src="asset://3f7a1c2e-0000-4000-8000-123456789abc.jpg" alt=""></p>' +
    '<p><a href="https://example.org/recurso">Externo</a> <a href="/raiz.html">Raíz</a> <a href="exe-node:page-2">Página</a></p>' +
    '<p><img src="resources/antiguo.jpg" alt=""></p>';
  const pages: Page[] = [
    {
      id: 'page-1',
      name: 'Errores',
      file: 'index.html',
      blocks: [{ id: 'block-1', name: '', components: [{ id: 'idevice-1', type: 'text', html, json: '{"textTextarea": "sin cerrar' }] }],
    },
  ];
  writeFileSync(
    join(out, 'broken-refs.elpx'),
    buildPackage(
      'Referencias rotas',
      pages,
      {
        'content/resources/mayus.png': read('palette-efficient.png'),
        'content/resources/a/logo.png': read('palette-efficient.png'),
        'content/resources/b/logo.png': read('efficient.jpg'),
        'content/resources/doc final.pdf': enc.encode('%PDF-1.4\n% test\n'),
        'content/resources/antiguo.jpg': read('efficient.jpg'),
      },
      { screenshot: false },
    ),
  );
}

console.log('ELPX fixtures written to', out);
