import { ElpxError } from '../errors.js';
import { DecodedBuilder, type DecodedText, type TextEdit } from './text-map.js';

/**
 * Minimal, strict XML parser for ODE `content.xml`.
 *
 * - Never resolves external entities or DTDs; a DOCTYPE with an internal
 *   subset that declares entities is rejected (XXE / billion laughs).
 * - Only the five predefined entities and numeric character references are
 *   decoded; any other entity reference is an error.
 * - Keeps raw offsets for attributes, text and CDATA so references can be
 *   rewritten by splicing instead of re-serializing the whole document.
 */

export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
  /** Raw offsets of the value between the quotes. */
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quote: '"' | "'";
  readonly decoded: DecodedText;
}

export interface XmlTextChunk {
  readonly kind: 'text' | 'cdata';
  /** Raw offsets of the content (for CDATA, excluding the markers). */
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly decoded: DecodedText;
}

export interface XmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
  readonly start: number;
  readonly end: number;
  readonly parent: XmlElement | undefined;
}

export type XmlNode = XmlElement | XmlTextChunk;

export interface XmlDocument {
  readonly root: XmlElement;
  readonly doctype: { name: string; externalId?: string } | undefined;
  readonly source: string;
}

/** Parser options. */
export interface XmlParseOptions {
  maxDepth: number;
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/;

/** Parses an XML document string into a tree with raw offsets. */
export function parseXml(source: string, options: XmlParseOptions): XmlDocument {
  return new XmlParser(source, options).parse();
}

class XmlParser {
  private pos = 0;
  private doctype: XmlDocument['doctype'];

  constructor(
    private readonly src: string,
    private readonly options: XmlParseOptions,
  ) {}

  parse(): XmlDocument {
    if (this.src.includes('\u0000')) this.fail('NUL character in XML');
    if (this.src.charCodeAt(0) === 0xfeff) this.pos = 1;
    this.prolog();
    if (!this.src.startsWith('<', this.pos)) this.fail('Missing root element');
    const root = this.element(undefined, 1);
    this.misc();
    if (this.pos < this.src.length) this.fail('Content after the root element');
    return { root, doctype: this.doctype, source: this.src };
  }

  private fail(message: string, code: 'content-xml-invalid' | 'xml-security' = 'content-xml-invalid'): never {
    const line = this.src.slice(0, this.pos).split('\n').length;
    throw new ElpxError(code, `${message} (line ${line})`, { offset: this.pos, line });
  }

  private prolog(): void {
    if (this.src.startsWith('<?xml', this.pos)) this.processingInstruction();
    this.misc();
    if (this.src.startsWith('<!DOCTYPE', this.pos)) {
      this.doctypeDecl();
      this.misc();
    }
  }

  /** Skips whitespace, comments and processing instructions. */
  private misc(): void {
    for (;;) {
      this.skipSpace();
      if (this.src.startsWith('<!--', this.pos)) this.comment();
      else if (this.src.startsWith('<?', this.pos)) this.processingInstruction();
      else return;
    }
  }

  private skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  private comment(): void {
    const end = this.src.indexOf('-->', this.pos + 4);
    if (end < 0) this.fail('Unterminated comment');
    this.pos = end + 3;
  }

  private processingInstruction(): void {
    const end = this.src.indexOf('?>', this.pos + 2);
    if (end < 0) this.fail('Unterminated processing instruction');
    this.pos = end + 2;
  }

  private doctypeDecl(): void {
    const start = this.pos;
    this.pos += '<!DOCTYPE'.length;
    this.skipSpace();
    const name = this.name();
    this.skipSpace();
    let externalId: string | undefined;
    if (this.src.startsWith('SYSTEM', this.pos) || this.src.startsWith('PUBLIC', this.pos)) {
      const close = this.findDoctypeEnd();
      externalId = this.src
        .slice(this.pos, close)
        .replace(/\s*\[[\s\S]*$/, '')
        .trim();
    }
    const bracket = this.src.indexOf('[', start);
    const close = this.findDoctypeEnd();
    if (bracket >= 0 && bracket < close) {
      const subset = this.src.slice(bracket + 1, this.src.lastIndexOf(']', close));
      if (/<!ENTITY/i.test(subset)) this.fail('DOCTYPE declares entities (not allowed)', 'xml-security');
      if (subset.trim().length > 0) this.fail('DOCTYPE internal subset is not allowed', 'xml-security');
    }
    this.pos = close + 1;
    this.doctype = externalId === undefined ? { name } : { name, externalId };
  }

  /** Finds the '>' closing a DOCTYPE, honouring quoted strings and a bracketed subset. */
  private findDoctypeEnd(): number {
    let depth = 0;
    let quote: string | undefined;
    for (let i = this.pos; i < this.src.length; i++) {
      const c = this.src[i]!;
      if (quote) {
        if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth <= 0) return i;
    }
    return this.fail('Unterminated DOCTYPE');
  }

  private name(): string {
    const start = this.pos;
    if (!NAME_START.test(this.src[this.pos] ?? '')) this.fail('Invalid name');
    this.pos++;
    while (this.pos < this.src.length && NAME_CHAR.test(this.src[this.pos]!)) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private element(parent: XmlElement | undefined, depth: number): XmlElement {
    if (depth > this.options.maxDepth) this.fail('XML nesting is too deep', 'xml-security');
    const start = this.pos;
    this.pos++; // '<'
    const name = this.name();
    const attributes: XmlAttribute[] = [];
    const children: XmlNode[] = [];
    const el: XmlElement = { kind: 'element', name, attributes, children, start, end: start, parent };
    const seen = new Set<string>();
    for (;;) {
      const before = this.pos;
      this.skipSpace();
      const c = this.src[this.pos];
      if (c === '/') {
        if (this.src[this.pos + 1] !== '>') this.fail('Malformed empty element');
        this.pos += 2;
        (el as { end: number }).end = this.pos;
        return el;
      }
      if (c === '>') {
        this.pos++;
        break;
      }
      if (c === undefined) this.fail('Unterminated start tag');
      if (before === this.pos) this.fail('Missing whitespace between attributes');
      const attr = this.attribute();
      if (seen.has(attr.name)) this.fail(`Duplicate attribute ${attr.name}`);
      seen.add(attr.name);
      attributes.push(attr);
    }
    for (;;) {
      if (this.pos >= this.src.length) this.fail(`Unclosed element <${name}>`);
      if (this.src.startsWith('</', this.pos)) {
        this.pos += 2;
        const closing = this.name();
        if (closing !== name) this.fail(`Mismatched closing tag </${closing}> for <${name}>`);
        this.skipSpace();
        if (this.src[this.pos] !== '>') this.fail('Malformed closing tag');
        this.pos++;
        (el as { end: number }).end = this.pos;
        return el;
      }
      if (this.src.startsWith('<![CDATA[', this.pos)) {
        const contentStart = this.pos + 9;
        const close = this.src.indexOf(']]>', contentStart);
        if (close < 0) this.fail('Unterminated CDATA section');
        const raw = this.src.slice(contentStart, close);
        const b = new DecodedBuilder();
        b.pushVerbatim(raw, 0);
        children.push({ kind: 'cdata', rawStart: contentStart, rawEnd: close, decoded: b.finish(raw.length) });
        this.pos = close + 3;
      } else if (this.src.startsWith('<!--', this.pos)) {
        this.comment();
      } else if (this.src.startsWith('<?', this.pos)) {
        this.processingInstruction();
      } else if (this.src.startsWith('<!', this.pos)) {
        this.fail('Unexpected markup declaration inside content', 'xml-security');
      } else if (this.src[this.pos] === '<') {
        children.push(this.element(el, depth + 1));
      } else {
        const textStart = this.pos;
        const next = this.src.indexOf('<', this.pos);
        const textEnd = next < 0 ? this.src.length : next;
        const raw = this.src.slice(textStart, textEnd);
        if (raw.includes(']]>')) this.fail('"]]>" is not allowed in text');
        children.push({ kind: 'text', rawStart: textStart, rawEnd: textEnd, decoded: this.decodeRefs(raw, textStart, false) });
        this.pos = textEnd;
      }
    }
  }

  private attribute(): XmlAttribute {
    const name = this.name();
    this.skipSpace();
    if (this.src[this.pos] !== '=') this.fail(`Attribute ${name} without value`);
    this.pos++;
    this.skipSpace();
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") this.fail(`Unquoted attribute ${name}`);
    const valueStart = this.pos + 1;
    const valueEnd = this.src.indexOf(quote, valueStart);
    if (valueEnd < 0) this.fail(`Unterminated attribute ${name}`);
    const raw = this.src.slice(valueStart, valueEnd);
    if (raw.includes('<')) this.fail(`"<" in attribute ${name}`);
    const decoded = this.decodeRefs(raw, valueStart, true);
    this.pos = valueEnd + 1;
    return { name, value: decoded.text, valueStart, valueEnd, quote, decoded };
  }

  /** Decodes predefined entities and character references with an offset map. */
  private decodeRefs(raw: string, absoluteStart: number, attribute: boolean): DecodedText {
    const b = new DecodedBuilder();
    let i = 0;
    while (i < raw.length) {
      const amp = raw.indexOf('&', i);
      const stop = amp < 0 ? raw.length : amp;
      if (stop > i) {
        const chunk = raw.slice(i, stop);
        b.pushVerbatim(attribute ? chunk.replace(/[\t\n\r]/g, ' ') : chunk, i);
      }
      if (amp < 0) break;
      const semi = raw.indexOf(';', amp);
      if (semi < 0) {
        this.pos = absoluteStart + amp;
        this.fail('Unterminated entity reference');
      }
      const ref = raw.slice(amp + 1, semi);
      let value: string | undefined;
      if (ref.startsWith('#x') || ref.startsWith('#X')) {
        value = codePoint(Number.parseInt(ref.slice(2), 16), /^[0-9a-fA-F]+$/.test(ref.slice(2)));
      } else if (ref.startsWith('#')) {
        value = codePoint(Number.parseInt(ref.slice(1), 10), /^[0-9]+$/.test(ref.slice(1)));
      } else {
        value = PREDEFINED[ref];
      }
      if (value === undefined) {
        this.pos = absoluteStart + amp;
        this.fail(`Undefined entity &${ref.slice(0, 32)};`, 'xml-security');
      }
      b.push(value, amp);
      i = semi + 1;
    }
    return b.finish(raw.length);
  }
}

/** Converts a numeric character reference to a string, or undefined when invalid. */
function codePoint(value: number, valid: boolean): string | undefined {
  if (!valid || !Number.isFinite(value) || value <= 0 || value > 0x10ffff) return undefined;
  if (value >= 0xd800 && value <= 0xdfff) return undefined;
  return String.fromCodePoint(value);
}

/** Escapes text for use inside an XML text node. */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes text for use inside an XML attribute delimited by `quote`. */
export function escapeXmlAttribute(text: string, quote: '"' | "'"): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
  return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&apos;');
}

/** Encodes text for a CDATA section; throws when it cannot be represented. */
export function encodeCdata(text: string): string {
  if (text.includes(']]>')) throw new ElpxError('internal', 'Text cannot be placed in a CDATA section');
  return text;
}

/** Concatenated text content of an element with per-chunk raw mapping. */
export interface XmlTextContent {
  readonly text: string;
  readonly chunks: readonly { chunk: XmlTextChunk; offset: number }[];
}

/** Returns the concatenated text/CDATA content of an element (direct children only). */
export function textContent(el: XmlElement): XmlTextContent {
  let text = '';
  const chunks: { chunk: XmlTextChunk; offset: number }[] = [];
  for (const child of el.children) {
    if (child.kind === 'element') continue;
    chunks.push({ chunk: child, offset: text.length });
    text += child.decoded.text;
  }
  return { text, chunks };
}

/**
 * Lifts an edit on an element's text content to absolute raw offsets.
 * Returns undefined when the edit spans several text/CDATA chunks or splits
 * an entity reference.
 */
export function liftTextContentEdit(content: XmlTextContent, edit: TextEdit): TextEdit | undefined {
  for (const { chunk, offset } of content.chunks) {
    const len = chunk.decoded.text.length;
    if (edit.start < offset || edit.end > offset + len) continue;
    const local = { start: edit.start - offset, end: edit.end - offset, text: edit.text };
    const map = chunk.decoded.map;
    if (local.start > 0 && map[local.start - 1] === map[local.start]) return undefined;
    if (local.end > 0 && local.end < len && map[local.end - 1] === map[local.end]) return undefined;
    let text: string;
    if (chunk.kind === 'cdata') {
      if (edit.text.includes(']]>')) return undefined;
      text = edit.text;
    } else {
      text = escapeXmlText(edit.text);
    }
    return { start: chunk.rawStart + map[local.start]!, end: chunk.rawStart + map[local.end]!, text };
  }
  return undefined;
}

/** Returns the first direct child element with the given local name. */
export function childElement(el: XmlElement, name: string): XmlElement | undefined {
  for (const child of el.children) if (child.kind === 'element' && localName(child.name) === name) return child;
  return undefined;
}

/** Returns all direct child elements with the given local name. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) {
    if (child.kind === 'element' && (name === undefined || localName(child.name) === name)) out.push(child);
  }
  return out;
}

/** Strips a namespace prefix ("ode:page" -> "page"). */
export function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** Returns the value of an attribute by name. */
export function attributeValue(el: XmlElement, name: string): string | undefined {
  return el.attributes.find((a) => a.name === name)?.value;
}
