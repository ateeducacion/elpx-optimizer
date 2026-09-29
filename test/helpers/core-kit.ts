/**
 * Helpers for the portable-core tests: fixture loaders, an in-memory builder
 * for synthetic .elpx packages (v4 CDATA or v3 entity-escaped content.xml,
 * published pages, search index, manifest) and small analysis accessors.
 * ZIPs are written with fflate, not with this project's writer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import { MemoryByteSource } from '../../src/core/io/byte-source.js';
import { NATIVE_LIMITS, resolveLimits, type Limits } from '../../src/core/limits.js';
import { analyzeArchive, type AnalyzeOptions } from '../../src/core/analyze/analyze.js';
import type { Analysis, InventoryEntry, ReferenceRecord } from '../../src/core/analyze/model.js';
import type { Diagnostic } from '../../src/core/diagnostics.js';
import { ROOT } from './native.js';

export const enc = new TextEncoder();
export const dec = new TextDecoder();

/** Reads a synthetic media fixture. */
export function media(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'media', name)));
}

/** Reads a real eXeLearning fixture copied from upstream. */
export function upstream(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'upstream', name)));
}

/** Reads a generated .elpx fixture. */
export function elpxFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'test', 'fixtures', 'elpx', name)));
}

const TEXT_EXT = /\.(css|dtd|htm|html|js|json|svg|txt|xhtml|xml|vtt)$/i;

/** Zips files in the given order, deflating text and storing media like eXeLearning. */
export function zipFiles(files: Record<string, Uint8Array | string>): Uint8Array {
  const z: Zippable = {};
  for (const [path, data] of Object.entries(files)) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    z[path] = [bytes, { level: TEXT_EXT.test(path) ? 6 : 0, mtime: new Date('2026-01-15T10:00:00Z') }];
  }
  return zipSync(z);
}

/** One iDevice for the content.xml builder. */
export interface CompSpec {
  id?: string;
  type?: string;
  html?: string;
  /** JSON object (serialized) or raw jsonProperties text. */
  json?: object | string;
}

/** One page for the content.xml builder. */
export interface PageSpec {
  id: string;
  name?: string;
  parent?: string;
  blocks: { id: string; name?: string; components: CompSpec[] }[];
}

export interface OdeSpec {
  /** 'v4' writes DOCTYPE, namespace and CDATA; 'v3' writes a bare <ode> with entity-escaped text. */
  variant?: 'v4' | 'v3';
  pages?: PageSpec[];
  /** Shorthand for a single page with a single block. */
  components?: CompSpec[];
  props?: [string, string][];
  resources?: [string, string][];
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cdata = (s: string): string => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/** Builds an ODE content.xml in the layout of the requested variant. */
export function odeXml(spec: OdeSpec): string {
  const v4 = spec.variant !== 'v3';
  const wrap = (s: string): string => (v4 ? cdata(s) : xmlEscape(s));
  const nl = v4 ? '\n' : '';
  const pages: PageSpec[] = spec.pages ?? [{ id: 'page-1', name: 'Page 1', blocks: [{ id: 'block-1', name: 'Block', components: spec.components ?? [] }] }];
  let x = v4
    ? '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ode SYSTEM "content.dtd">\n<ode xmlns="http://www.intef.es/xsd/ode" version="2.0">\n'
    : '<?xml version="1.0" encoding="UTF-8"?><ode>';
  const resources =
    spec.resources ??
    (v4
      ? [
          ['odeId', '20260115100000TESTAB'],
          ['exe_version', '4.0.5'],
        ]
      : [
          ['odeId', '20251009090601SQPBIF'],
          ['eXeVersion', 'v3.0.2'],
        ]);
  x += `<odeResources>${nl}`;
  for (const [k, v] of resources) x += `<odeResource><key>${k}</key><value>${xmlEscape(v)}</value></odeResource>${nl}`;
  x += `</odeResources>${nl}<odeProperties>${nl}`;
  for (const [k, v] of spec.props ?? [['pp_title', 'Test project']]) x += `<odeProperty><key>${k}</key><value>${xmlEscape(v)}</value></odeProperty>${nl}`;
  x += `</odeProperties>${nl}<odeNavStructures>${nl}`;
  let n = 0;
  pages.forEach((p, pi) => {
    x += `<odeNavStructure><odePageId>${p.id}</odePageId><odeParentPageId>${p.parent ?? ''}</odeParentPageId><pageName>${xmlEscape(p.name ?? p.id)}</pageName><odeNavStructureOrder>${pi}</odeNavStructureOrder><odePagStructures>${nl}`;
    p.blocks.forEach((b, bi) => {
      x += `<odePagStructure><odePageId>${p.id}</odePageId><odeBlockId>${b.id}</odeBlockId><blockName>${xmlEscape(b.name ?? '')}</blockName><odePagStructureOrder>${bi}</odePagStructureOrder><odeComponents>${nl}`;
      b.components.forEach((c, ci) => {
        n++;
        const json = c.json === undefined ? '' : typeof c.json === 'string' ? c.json : JSON.stringify(c.json);
        x += `<odeComponent><odePageId>${p.id}</odePageId><odeBlockId>${b.id}</odeBlockId><odeIdeviceId>${c.id ?? `idevice-${n}`}</odeIdeviceId><odeIdeviceTypeName>${c.type ?? 'text'}</odeIdeviceTypeName>${nl}`;
        x += `<htmlView>${wrap(c.html ?? '')}</htmlView>${nl}`;
        x += json ? `<jsonProperties>${wrap(json)}</jsonProperties>${nl}` : `<jsonProperties></jsonProperties>${nl}`;
        x += `<odeComponentsOrder>${ci}</odeComponentsOrder></odeComponent>${nl}`;
      });
      x += `</odeComponents></odePagStructure>${nl}`;
    });
    x += `</odePagStructures></odeNavStructure>${nl}`;
  });
  return `${x}</odeNavStructures>${nl}</ode>${nl}`;
}

/** Renders htmlView as eXeLearning does: placeholders become page-relative paths. */
export function publishHtml(html: string, base: '' | '../'): string {
  return html.replace(/\{\{context_path\}\}\/(?!content\/resources\/)/g, `${base}content/resources/`).replace(/\{\{context_path\}\}\//g, base);
}

/** Wraps a body in a minimal published page. */
export function page(body: string, title = 'Page'): string {
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>\n`;
}

/** Search index text in the upstream format. */
export function searchIndex(data: unknown): string {
  return `window.exeSearchData = ${JSON.stringify(data)};`;
}

/** Manifest text in the upstream format (the manifest itself is appended last). */
export function manifestText(files: string[], title = 'Test project'): string {
  const list = [...files.filter((f) => f !== 'libs/elpx-manifest.js'), 'libs/elpx-manifest.js'];
  return `/**\n * ELPX Manifest - Auto-generated for download-source-file iDevice\n */\nwindow.__ELPX_MANIFEST__=${JSON.stringify({ version: 1, files: list, projectTitle: title }, null, 2)};\n`;
}

export interface ElpxSpec extends OdeSpec {
  /** Raw content.xml text (overrides the builder). */
  contentXml?: string;
  /** Additional archive entries (assets, pages, runtime files). */
  files?: Record<string, Uint8Array | string>;
  /** Adds content.dtd (default true for v4). */
  dtd?: boolean;
  /** Adds index.html rendered from every htmlView. */
  publish?: boolean;
  /** Adds libs/elpx-manifest.js listing every entry. */
  manifest?: boolean;
}

/** Builds a complete synthetic package. */
export function buildElpx(spec: ElpxSpec): Uint8Array {
  const files: Record<string, Uint8Array | string> = {};
  const xml = spec.contentXml ?? odeXml(spec);
  files['content.xml'] = xml;
  if (spec.dtd ?? spec.variant !== 'v3') files['content.dtd'] = '<!ELEMENT ode ANY>\n';
  if (spec.publish) {
    const comps = (spec.pages ?? [{ id: 'p', blocks: [{ id: 'b', components: spec.components ?? [] }] }]).flatMap((p) => p.blocks.flatMap((b) => b.components));
    files['index.html'] = page(comps.map((c) => publishHtml(c.html ?? '', '')).join('\n'));
  }
  Object.assign(files, spec.files ?? {});
  if (spec.manifest) files['libs/elpx-manifest.js'] = manifestText(Object.keys(files));
  return zipFiles(files);
}

/** Limits used by the tests (native defaults, optionally overridden). */
export function limits(overrides: Partial<Limits> = {}): Limits {
  return resolveLimits(NATIVE_LIMITS, overrides);
}

/** Analyzes in-memory bytes. */
export function analyzeBytes(bytes: Uint8Array, options: Partial<AnalyzeOptions> = {}): Promise<Analysis> {
  return analyzeArchive(new MemoryByteSource(bytes), { limits: NATIVE_LIMITS, inputName: 'test.elpx', ...options });
}

/** Diagnostics with a given code. */
export function diags(a: Analysis, code: string): Diagnostic[] {
  return a.result.diagnostics.filter((d) => d.code === code);
}

/** Codes of every diagnostic (sorted, unique). */
export function codes(a: Analysis): string[] {
  return [...new Set(a.result.diagnostics.map((d) => d.code))].sort();
}

/** The inventory entry of a path (throws when absent). */
export function entry(a: Analysis, path: string): InventoryEntry {
  const e = a.result.entries.find((x) => x.path === path);
  if (!e) throw new Error(`No inventory entry ${path}`);
  return e;
}

/** References whose value contains the given text. */
export function refs(a: Analysis, value: string): ReferenceRecord[] {
  return a.result.references.filter((r) => r.value.includes(value));
}
