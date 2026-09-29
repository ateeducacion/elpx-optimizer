import type { Diagnostic, SourceLocation } from '../diagnostics.js';
import { diagnostic } from '../diagnostics.js';
import { componentLocation, type OdeDocument } from '../format/content-xml.js';
import { liftTextContentEdit, type XmlTextContent } from '../parse/xml.js';
import { looksLikeHtml } from '../parse/html.js';
import type { Limits } from '../limits.js';
import { derive, scanCssText, scanHtml, scanJson, scanPlainText, type FoundReference, type Lift, type Representation, type ScanContext } from '../refs/scan.js';

/**
 * Enumerates the text sources of a package and scans them for references:
 * the editable representation (content.xml), the published one (index.html,
 * html/*.html), the search index, stylesheets and HTML/SVG resources.
 */

export interface ScanSink {
  found: FoundReference[];
  diagnostics: Diagnostic[];
}

/** Line number (1-based) of an offset in a text. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function baseContext(
  entry: string,
  representation: Representation,
  location: SourceLocation,
  lift: Lift | undefined,
  limits: Limits,
  sink: ScanSink,
): ScanContext {
  return {
    entry,
    representation,
    location: { entry, ...location },
    via: [],
    lift,
    kind: 'explicit',
    depth: 0,
    maxDepth: limits.maxDecodeLayers * 4,
    maxJsonDepth: limits.maxJsonDepth,
    emit: (f) => sink.found.push(f),
    onMalformedJson: (loc) =>
      sink.diagnostics.push(
        diagnostic('json-properties-malformed', 'JSON data is malformed; it is kept verbatim and scanned only for placeholders', { location: loc }),
      ),
  };
}

/** Lift for an XML element's text content (CDATA or escaped text) in content.xml. */
function xmlLift(content: XmlTextContent): Lift {
  return (edit) => liftTextContentEdit(content, edit);
}

/** Scans every component and HTML-bearing property of content.xml. */
export function scanContentXml(ode: OdeDocument, limits: Limits, sink: ScanSink): void {
  const entry = 'content.xml';
  for (const component of ode.components) {
    const loc = componentLocation(ode, component);
    if (component.htmlView && component.htmlView.text.trim() !== '') {
      const ctx = baseContext(
        entry,
        'editable',
        { ...loc, field: 'htmlView', line: lineAt(ode, component.htmlView) },
        xmlLift(component.htmlView),
        limits,
        sink,
      );
      scanHtml(component.htmlView.text, derive(ctx, { layer: xmlLayer(component.htmlView) }), true);
    }
    if (component.jsonProperties && component.jsonProperties.text.trim() !== '') {
      const ctx = baseContext(
        entry,
        'editable',
        { ...loc, field: 'jsonProperties', line: lineAt(ode, component.jsonProperties) },
        xmlLift(component.jsonProperties),
        limits,
        sink,
      );
      scanJson(component.jsonProperties.text, derive(ctx, { layer: xmlLayer(component.jsonProperties) }));
    }
  }
  for (const prop of ode.properties) {
    if (prop.key === 'pp_screenshot' || prop.value.text.trim() === '') continue;
    const ctx = baseContext(entry, 'editable', { field: `odeProperty:${prop.key}`, line: lineAt(ode, prop.value) }, xmlLift(prop.value), limits, sink);
    const child = derive(ctx, { layer: xmlLayer(prop.value) });
    if (looksLikeHtml(prop.value.text)) scanHtml(prop.value.text, child, true);
    else scanPlainText(prop.value.text, child);
  }
}

function xmlLayer(content: XmlTextContent): string {
  return content.chunks.some((c) => c.chunk.kind === 'cdata') ? 'xml-cdata' : 'xml-text';
}

function lineAt(ode: OdeDocument, content: XmlTextContent): number | undefined {
  const first = content.chunks[0];
  return first ? lineOf(ode.xml.source, first.chunk.rawStart) : undefined;
}

/** Scans a published HTML page or an HTML/SVG resource. */
export function scanHtmlFile(entry: string, text: string, representation: Representation, limits: Limits, sink: ScanSink): void {
  const identity: Lift = (e) => e;
  scanHtml(text, baseContext(entry, representation, {}, identity, limits, sink), false);
}

/** Scans a stylesheet. */
export function scanCssFile(entry: string, text: string, representation: Representation, limits: Limits, sink: ScanSink): void {
  const identity: Lift = (e) => e;
  scanCssText(text, baseContext(entry, representation, {}, identity, limits, sink));
}

const SEARCH_ASSIGNMENT = /^\s*window\.exeSearchData\s*=\s*/;

/** Scans search_index.js (window.exeSearchData = {JSON};). Returns false if the format is unknown. */
export function scanSearchIndex(entry: string, text: string, limits: Limits, sink: ScanSink): boolean {
  const m = SEARCH_ASSIGNMENT.exec(text);
  if (!m) {
    scanPlainText(text, baseContext(entry, 'search-index', {}, undefined, limits, sink));
    return false;
  }
  const start = m[0].length;
  const end = text.replace(/;\s*$/, '').length;
  const json = text.slice(start, end);
  const lift: Lift = (e) => ({ start: e.start + start, end: e.end + start, text: e.text });
  const ctx = baseContext(entry, 'search-index', {}, lift, limits, sink);
  if (!scanJson(json, derive(ctx, { layer: 'json' }), true)) {
    scanPlainText(text, baseContext(entry, 'search-index', {}, undefined, limits, sink));
    return false;
  }
  return true;
}
