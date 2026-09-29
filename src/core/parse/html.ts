import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { DecodingMode, EntityDecoder, htmlDecodeTree } from 'entities/decode';
import { DecodedBuilder, type DecodedText } from './text-map.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

/**
 * HTML scanning on top of parse5 with source locations. Produces a flat list
 * of attribute values and text nodes with raw offsets and decoded text, so
 * references can be found and rewritten without re-serializing the markup.
 * Nothing is rendered or executed.
 */

/** Element context for a field. */
export interface HtmlElementInfo {
  readonly tagName: string;
  /** Decoded attribute values keyed by lower-case name. */
  readonly attributes: Readonly<Record<string, string>>;
  /** Tag names of ancestors, outermost first. */
  readonly ancestors: readonly string[];
  readonly startOffset: number;
}

export interface HtmlAttributeField {
  readonly kind: 'attribute';
  readonly element: HtmlElementInfo;
  readonly name: string;
  readonly value: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly quote: '"' | "'" | null;
  readonly decoded: DecodedText;
  /** False when our decoding does not reproduce parse5's value exactly. */
  readonly rewritable: boolean;
}

export interface HtmlTextField {
  readonly kind: 'text';
  readonly element: HtmlElementInfo;
  readonly value: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  /** True for raw text elements (script, style) where references are not decoded. */
  readonly rawText: boolean;
  /**
   * True when the field is the raw inner source of a data container (a
   * `*-DataGame` div or the interactive-video contents) whose JSON embeds
   * raw HTML: eXeLearning's importer and renderer read that source as text,
   * while an HTML parser would turn the embedded tags into elements.
   */
  readonly rawSource?: boolean;
  readonly decoded: DecodedText;
  readonly rewritable: boolean;
}

export type HtmlField = HtmlAttributeField | HtmlTextField;

const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const RCDATA = new Set(['textarea', 'title']);

/** Scans a full HTML document. */
export function scanHtmlDocument(html: string): HtmlField[] {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const out: HtmlField[] = [];
  walk(doc.childNodes, html, [], out);
  return out;
}

/** Element context for text placed directly at the top level of a fragment. */
const FRAGMENT_ROOT: HtmlElementInfo = { tagName: '#document-fragment', attributes: {}, ancestors: [], startOffset: 0 };

/** Scans an HTML fragment (e.g. an iDevice htmlView). */
export function scanHtmlFragment(html: string): HtmlField[] {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const out: HtmlField[] = [];
  walk(frag.childNodes, html, [], out);
  // Top-level text (e.g. an htmlView starting with plain text) has no parent element but may hold references.
  for (const child of frag.childNodes) {
    if (isText(child)) {
      const field = textField(html, FRAGMENT_ROOT, child);
      if (field) out.push(field);
    }
  }
  return out;
}

/** Heuristic: does the text look like HTML markup worth parsing? */
export function looksLikeHtml(text: string): boolean {
  return /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?\/?>/.test(text);
}

/** Recursively collects fields from parse5 nodes. */
function walk(nodes: readonly Node[], html: string, ancestors: string[], out: HtmlField[]): void {
  for (const node of nodes) {
    if (isElement(node)) {
      const info: HtmlElementInfo = {
        tagName: node.tagName,
        attributes: Object.fromEntries(node.attrs.map((a) => [a.name, a.value])),
        ancestors: [...ancestors],
        startOffset: node.sourceCodeLocation?.startOffset ?? -1,
      };
      const locs = node.sourceCodeLocation?.attrs;
      for (const attr of node.attrs) {
        // parse5 splits foreign attributes (SVG xlink:href) into prefix and name; locations use the raw name.
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        const loc = locs?.[name];
        if (!loc) continue;
        const field = attributeField(html, info, name, attr.value, loc.startOffset, loc.endOffset);
        if (field) out.push(field);
      }
      const childAncestors = [...ancestors, node.tagName];
      const inner = dataContainerSource(html, node, info);
      if (inner) {
        out.push(inner);
        continue;
      }
      const content = (node as Element & { content?: { childNodes: Node[] } }).content;
      if (content) walk(content.childNodes, html, childAncestors, out);
      walk(node.childNodes, html, childAncestors, out);
      // Text inside <template> lives in its content fragment, not in childNodes.
      for (const child of [...(content?.childNodes ?? []), ...node.childNodes]) {
        if (isText(child)) {
          const field = textField(html, info, child);
          if (field) out.push(field);
        }
      }
    }
  }
}

/** Class tokens and ids of elements whose text is JSON data read by eXeLearning as raw text. */
function isDataContainer(node: Element): boolean {
  const cls = node.attrs.find((a) => a.name === 'class')?.value ?? '';
  const id = node.attrs.find((a) => a.name === 'id')?.value ?? '';
  return id === 'exe-interactive-video-contents' || cls.split(/\s+/).some((t) => /-DataGame$/.test(t));
}

/**
 * For a data container that holds child elements (JSON with raw HTML inside
 * its strings), returns its raw inner source as a single text field.
 */
function dataContainerSource(html: string, node: Element, element: HtmlElementInfo): HtmlTextField | undefined {
  if (node.tagName === 'script' || !isDataContainer(node) || !node.childNodes.some((c) => isElement(c))) return undefined;
  const loc = node.sourceCodeLocation;
  if (!loc?.startTag || !loc.endTag) return undefined;
  const start = loc.startTag.endOffset;
  const end = loc.endTag.startOffset;
  const raw = html.slice(start, end);
  return { kind: 'text', element, value: raw, rawStart: start, rawEnd: end, rawText: true, rawSource: true, decoded: normalizeNewlines(raw), rewritable: true };
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function isText(node: Node): node is TextNode {
  return node.nodeName === '#text';
}

/** Locates the raw value inside an attribute's source span. */
function attributeField(html: string, element: HtmlElementInfo, name: string, value: string, start: number, end: number): HtmlAttributeField | undefined {
  const raw = html.slice(start, end);
  const eq = raw.indexOf('=');
  if (eq < 0) return undefined;
  let p = eq + 1;
  while (p < raw.length && /\s/.test(raw[p]!)) p++;
  let quote: '"' | "'" | null = null;
  let valueStart = start + p;
  let valueEnd = end;
  if (raw[p] === '"' || raw[p] === "'") {
    quote = raw[p] as '"' | "'";
    valueStart = start + p + 1;
    valueEnd = end - 1;
  }
  const decoded = decodeHtmlRefs(html.slice(valueStart, valueEnd), DecodingMode.Attribute);
  return {
    kind: 'attribute',
    element,
    name,
    value,
    rawStart: valueStart,
    rawEnd: valueEnd,
    quote,
    decoded,
    rewritable: decoded.text === value,
  };
}

/** Builds a text field for a text node. */
function textField(html: string, element: HtmlElementInfo, node: TextNode): HtmlTextField | undefined {
  const loc = node.sourceCodeLocation;
  if (!loc) return undefined;
  const raw = html.slice(loc.startOffset, loc.endOffset);
  const rawText = RAW_TEXT.has(element.tagName);
  const decoded = rawText ? normalizeNewlines(raw) : decodeHtmlRefs(raw, RCDATA.has(element.tagName) ? DecodingMode.Legacy : DecodingMode.Legacy);
  return {
    kind: 'text',
    element,
    value: node.value,
    rawStart: loc.startOffset,
    rawEnd: loc.endOffset,
    rawText,
    decoded,
    rewritable: decoded.text === node.value,
  };
}

/** Maps CRLF and lone CR to LF, as the HTML input stream preprocessor does. */
function normalizeNewlines(raw: string): DecodedText {
  const b = new DecodedBuilder();
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\r') {
      b.push('\n', i);
      if (raw[i + 1] === '\n') i++;
    } else b.pushVerbatim(c, i);
  }
  return b.finish(raw.length);
}

/** Decodes HTML character references with an offset map. */
export function decodeHtmlRefs(raw: string, mode: DecodingMode): DecodedText {
  const b = new DecodedBuilder();
  let emitted = '';
  const decoder = new EntityDecoder(htmlDecodeTree, (cp) => {
    emitted += String.fromCodePoint(cp);
  });
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '&') {
      emitted = '';
      decoder.startEntity(mode);
      let consumed = decoder.write(raw, i + 1);
      if (consumed < 0) consumed = decoder.end();
      if (consumed > 0) {
        b.push(emitted, i);
        i += consumed;
        continue;
      }
      b.pushVerbatim('&', i);
      i++;
      continue;
    }
    if (c === '\r') {
      b.push('\n', i);
      i += raw[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    b.pushVerbatim(c, i);
    i++;
  }
  return b.finish(raw.length);
}

/**
 * Encodes a replacement for an HTML attribute with as little escaping as
 * possible: "&" stays raw unless it would be read as a character reference.
 * eXeLearning resolves {{context_path}} references by literal text matching,
 * so "foto&amp;x.jpg" would not resolve there while "foto&x.jpg" does, and
 * browsers read both the same. Falls back to full escaping when the minimal
 * form would not decode back to the same text.
 */
export function encodeHtmlAttributeMinimal(text: string, quote: '"' | "'" | null): string {
  let candidate = text;
  if (quote === '"') candidate = candidate.replace(/"/g, '&quot;');
  else if (quote === "'") candidate = candidate.replace(/'/g, '&#39;');
  else candidate = candidate.replace(/[\s"'=<>`]/g, (c) => `&#${c.codePointAt(0)};`);
  return decodeHtmlRefs(candidate, DecodingMode.Attribute).text === text ? candidate : escapeHtmlAttribute(text, quote);
}

/** Encodes a replacement for an HTML text node with minimal escaping (see encodeHtmlAttributeMinimal). */
export function encodeHtmlTextMinimal(text: string): string {
  const candidate = text.replace(/</g, '&lt;');
  return decodeHtmlRefs(candidate, DecodingMode.Legacy).text === text ? candidate : escapeHtmlText(text);
}

/** Escapes text for an HTML attribute value with the given quoting. */
export function escapeHtmlAttribute(text: string, quote: '"' | "'" | null): string {
  let out = text.replace(/&/g, '&amp;');
  if (quote === '"') out = out.replace(/"/g, '&quot;');
  else if (quote === "'") out = out.replace(/'/g, '&#39;');
  else out = out.replace(/[\s"'=<>`]/g, (c) => `&#${c.codePointAt(0)};`);
  return out;
}

/** Escapes text for an HTML text node. */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Parses a srcset attribute into candidate URL spans (decoded coordinates). */
export function parseSrcset(value: string): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i]!)) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !/\s/.test(value[i]!)) i++;
    let end = i;
    // A trailing comma belongs to the separator, not the URL.
    while (end > start && value[end - 1] === ',') end--;
    out.push({ start, end, url: value.slice(start, end) });
    if (end < i) continue;
    // skip descriptors up to the next comma
    let depth = 0;
    while (i < value.length) {
      const c = value[i]!;
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) break;
      i++;
    }
  }
  return out;
}
