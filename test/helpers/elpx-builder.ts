/**
 * Builder for synthetic eXeLearning v4 packages used by tests and fixture
 * scripts. It mirrors the layout written by eXeLearning at the pinned
 * upstream SHA (docs/upstream-review.md): content.xml with CDATA, pages
 * rendered to index.html and html/*.html, search_index.js, content.dtd,
 * screenshot.png, runtime folders and, optionally, the download manifest.
 * ZIPs are written with fflate (not this project's writer) with a fixed
 * timestamp, storing media and deflating text like eXeLearning does.
 */
import { zipSync, type Zippable } from 'fflate';

const MTIME = new Date('2026-01-15T10:00:00Z');
const enc = new TextEncoder();
const TEXT_EXT = /\.(css|csv|dtd|htm|html|js|json|map|mjs|svg|txt|xhtml|xml|vtt)$/i;

/** Mirrors upstream FflateZipProvider: deflate text, store everything else. */
export function zip(files: Record<string, Uint8Array | string>): Uint8Array {
  const z: Zippable = {};
  for (const [path, data] of Object.entries(files)) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    z[path] = [bytes, { level: TEXT_EXT.test(path) ? 6 : 0, mtime: MTIME }];
  }
  return zipSync(z);
}

const cdata = (s: string): string => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface Component {
  id: string;
  type: string;
  html: string;
  json?: object | string;
}
export interface Page {
  id: string;
  name: string;
  file: string;
  blocks: { id: string; name: string; components: Component[] }[];
}

/** Writes content.xml exactly in the upstream v4 generator layout. */
export function contentXml(title: string, pages: Page[], extraProps: [string, string][] = []): string {
  const props: [string, string][] = [
    ['pp_title', title],
    ['pp_author', 'elpx-optimizer tests'],
    ['pp_lang', 'es'],
    ['pp_license', 'creative commons: attribution - share alike 4.0'],
    ['pp_addSearchBox', 'true'],
    ['exportSource', 'true'],
    ...extraProps,
  ];
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ode SYSTEM "content.dtd">\n<ode xmlns="http://www.intef.es/xsd/ode" version="2.0">\n';
  x += '<userPreferences>\n  <userPreference>\n    <key>theme</key>\n    <value>base</value>\n  </userPreference>\n</userPreferences>\n';
  x += '<odeResources>\n';
  for (const [k, v] of [
    ['odeId', '20260115100000TESTAB'],
    ['odeVersionId', '20260115100000TESTCD'],
    ['exe_version', '4.0.5'],
  ]) {
    x += `  <odeResource>\n    <key>${k}</key>\n    <value>${v}</value>\n  </odeResource>\n`;
  }
  x += '</odeResources>\n<odeProperties>\n';
  for (const [k, v] of props) x += `  <odeProperty>\n    <key>${k}</key>\n    <value>${xmlEscape(v)}</value>\n  </odeProperty>\n`;
  x += '</odeProperties>\n<odeNavStructures>\n';
  pages.forEach((p, pi) => {
    x += `<odeNavStructure>\n  <odePageId>${p.id}</odePageId>\n  <odeParentPageId></odeParentPageId>\n  <pageName>${xmlEscape(p.name)}</pageName>\n  <odeNavStructureOrder>${pi}</odeNavStructureOrder>\n`;
    x += `  <odeNavStructureProperties>\n    <odeNavStructureProperty><key>titlePage</key><value>${xmlEscape(p.name)}</value></odeNavStructureProperty>\n  </odeNavStructureProperties>\n  <odePagStructures>\n`;
    p.blocks.forEach((b, bi) => {
      x += `    <odePagStructure>\n      <odePageId>${p.id}</odePageId>\n      <odeBlockId>${b.id}</odeBlockId>\n      <blockName>${xmlEscape(b.name)}</blockName>\n      <iconName></iconName>\n      <odePagStructureOrder>${bi}</odePagStructureOrder>\n      <odeComponents>\n`;
      b.components.forEach((c, ci) => {
        const json = c.json === undefined ? '' : typeof c.json === 'string' ? c.json : JSON.stringify(c.json);
        x += `        <odeComponent>\n          <odePageId>${p.id}</odePageId>\n          <odeBlockId>${b.id}</odeBlockId>\n          <odeIdeviceId>${c.id}</odeIdeviceId>\n          <odeIdeviceTypeName>${c.type}</odeIdeviceTypeName>\n`;
        x += `          <htmlView>${cdata(c.html)}</htmlView>\n`;
        x += json ? `          <jsonProperties>${cdata(json)}</jsonProperties>\n` : '          <jsonProperties></jsonProperties>\n';
        x += `          <odeComponentsOrder>${ci}</odeComponentsOrder>\n          <odeComponentsProperties>\n            <odeComponentsProperty><key>visibility</key><value>true</value></odeComponentsProperty>\n          </odeComponentsProperties>\n        </odeComponent>\n`;
      });
      x += '      </odeComponents>\n    </odePagStructure>\n';
    });
    x += '  </odePagStructures>\n</odeNavStructure>\n';
  });
  return `${x}</odeNavStructures>\n</ode>\n`;
}

const DTD =
  '<!-- content.dtd (test copy; eXeLearning ships the full DTD) -->\n<!ELEMENT ode (userPreferences?, odeResources?, odeProperties?, odeNavStructures)>\n';

/** Renders a page as upstream does: placeholders become paths relative to the page. */
export function pageHtml(page: Page, title: string, pages: Page[], withDownload: boolean): string {
  const base = page.file === 'index.html' ? '' : '../';
  const body = page.blocks
    .flatMap((b) => b.components)
    .map((c) => {
      let html = c.html.replace(/\{\{context_path\}\}\/content\/resources\//g, `${base}content/resources/`);
      html = html.replace('href="exe-package:elp"', 'href="#" onclick="if(typeof downloadElpx===\'function\')downloadElpx();return false;"');
      html = html.replace('download="exe-package:elp-name"', `download="${title}.elpx"`);
      return `<article class="idevice_node ${c.type}" id="${c.id}"><div class="idevice_body">${html}</div></article>`;
    })
    .join('\n');
  const nav = pages.map((p) => `<li><a href="${base}${p.file === 'index.html' ? 'index.html' : p.file}">${p.name}</a></li>`).join('');
  const scripts = withDownload
    ? `<script src="${base}libs/fflate/fflate.umd.js"></script><script src="${base}libs/exe_elpx_download/exe_elpx_download.js"></script><script src="${base}libs/elpx-manifest.js"> </script>`
    : '';
  return `<!DOCTYPE html>\n<html lang="es"><head><meta charset="utf-8"><title>${page.name}</title>
<link rel="stylesheet" href="${base}content/css/base.css"><link rel="stylesheet" href="${base}theme/style.css">
<script src="${base}search_index.js"></script></head>
<body><nav><ul>${nav}</ul></nav><main>${body}</main>${scripts}</body></html>\n`;
}

export function searchIndex(pages: Page[]): string {
  const data: Record<string, unknown> = {};
  for (const p of pages) {
    const blocks: Record<string, unknown> = {};
    for (const b of p.blocks) {
      const idevices: Record<string, unknown> = {};
      b.components.forEach((c, i) => {
        idevices[c.id] = {
          order: i + 1,
          htmlView: c.html,
          jsonProperties: c.json === undefined ? '{}' : typeof c.json === 'string' ? c.json : JSON.stringify(c.json),
        };
      });
      blocks[b.id] = { name: b.name, order: 1, idevices };
    }
    data[p.id] = { name: p.name, isIndex: p.file === 'index.html', fileName: p.file.replace('html/', ''), fileUrl: p.file, blocks };
  }
  return `window.exeSearchData = ${JSON.stringify(data)};`;
}

export function manifest(files: string[], title: string): string {
  const list = [...files.filter((f) => f !== 'libs/elpx-manifest.js'), 'libs/elpx-manifest.js'];
  return `/**\n * ELPX Manifest - Auto-generated for download-source-file iDevice\n * Used by exe_elpx_download.js to recreate the complete export package\n */\nwindow.__ELPX_MANIFEST__=${JSON.stringify({ version: 1, files: list, projectTitle: title }, null, 2)};\n`;
}

/** Assembles a complete v4 package. */
export function buildPackage(
  runtimeImage: Uint8Array,
  title: string,
  pages: Page[],
  assets: Record<string, Uint8Array | string>,
  opts: { download?: boolean; screenshot?: boolean; extraProps?: [string, string][] } = {},
): Uint8Array {
  const files: Record<string, Uint8Array | string> = {};
  files['search_index.js'] = searchIndex(pages);
  files['content/css/base.css'] = 'body{margin:0}\n.exe-content{background:url(../img/exe_powered_logo.png) no-repeat}\n';
  files['content/img/exe_powered_logo.png'] = runtimeImage;
  files['theme/style.css'] = 'body{background:url(img/bg.png)}\n';
  files['theme/img/bg.png'] = runtimeImage;
  if (opts.download) {
    files['libs/fflate/fflate.umd.js'] = '/* fflate stub for tests */\n';
    files['libs/exe_elpx_download/exe_elpx_download.js'] = '/* exe_elpx_download stub for tests */\n';
  }
  for (const [k, v] of Object.entries(assets)) files[k] = v;
  for (const p of pages) files[p.file] = pageHtml(p, title, pages, !!opts.download);
  files['content.xml'] = contentXml(title, pages, opts.extraProps);
  files['content.dtd'] = DTD;
  if (opts.screenshot !== false) files['screenshot.png'] = runtimeImage;
  if (opts.download) files['libs/elpx-manifest.js'] = manifest(Object.keys(files), title);
  return zip(files);
}
