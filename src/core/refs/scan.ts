import type { SourceLocation } from '../diagnostics.js';
import { liftEdit, type DecodedText, type TextEdit } from '../parse/text-map.js';
import { escapeJsonString, formatJsonPath, JsonSyntaxError, parseJson, visitJsonStrings, type JsonStyle } from '../parse/json.js';
import {
  encodeHtmlAttributeMinimal,
  encodeHtmlTextMinimal,
  looksLikeHtml,
  parseSrcset,
  scanHtmlDocument,
  scanHtmlFragment,
  type HtmlField,
  type HtmlSpan,
} from '../parse/html.js';
import { escapeCssUrl, scanCss } from '../parse/css.js';
import { decodePercent, encodeComponent, looksPercentEncoded } from '../parse/uri.js';
import { dataGameEncoding, dataGamePrefix, decryptDataGame } from '../format/datagame.js';
import { CONTEXT_PATH } from './resolve.js';

/**
 * Reference discovery over nested encodings. Every layer keeps a `lift`
 * function that maps an edit in its decoded text to an edit in the raw text
 * of the ZIP entry, so a reference can be rewritten by replacing exactly its
 * bytes. Layers we cannot re-encode faithfully (script code, obfuscated
 * DataGame payloads, malformed JSON) produce non-rewritable references.
 */

/** Maps an edit in the current layer to an edit in the entry's raw text. */
export type Lift = (edit: TextEdit) => TextEdit | undefined;

/** How much a found string can be trusted as a reference. */
export type ReferenceKind = 'explicit' | 'dynamic';

/** Which representation of the project a reference belongs to. */
export type Representation = 'editable' | 'published' | 'search-index' | 'resource' | 'runtime';

/** The HTML element an attribute reference belongs to, with the lift of its HTML layer. */
export interface ElementAnchor {
  readonly lift: Lift;
  readonly tag: string;
  /** Start tag span; identifies the element within its entry. */
  readonly key: HtmlSpan;
  /** Span of the whole element when it can be deleted on its own (see HtmlElementInfo.removableSpan). */
  readonly span?: HtmlSpan;
}

/**
 * How a reference could be taken out of its document when its target does
 * not exist. `attribute` and `srcset` edits are expressed in the HTML layer
 * (through the anchor's lift); `json-string` empties the whole string value.
 */
export type RemovalSite =
  | { readonly kind: 'attribute'; readonly attribute: string; readonly span: HtmlSpan }
  | {
      readonly kind: 'srcset';
      readonly attribute: string;
      readonly span: HtmlSpan;
      /** Lift of the attribute value layer, and the decoded value. */
      readonly valueLift: Lift;
      readonly value: string;
      readonly valueLength: number;
      /** Candidate spans (URL plus descriptors) in the attribute value, and this reference's index. */
      readonly candidates: readonly HtmlSpan[];
      readonly index: number;
    }
  | { readonly kind: 'json-string'; readonly lift: Lift; readonly length: number };

export interface ScanContext {
  readonly entry: string;
  readonly representation: Representation;
  readonly location: SourceLocation;
  readonly via: readonly string[];
  readonly lift: Lift | undefined;
  readonly kind: ReferenceKind;
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxJsonDepth: number;
  /** Receives every candidate reference. */
  readonly emit: (found: FoundReference) => void;
  /** Receives malformed-JSON notes (location only). */
  readonly onMalformedJson?: (location: SourceLocation, via: readonly string[]) => void;
  /** Element whose attribute is being scanned (kept through deeper layers of that attribute). */
  readonly element?: ElementAnchor;
  /** Removal site for a reference that is exactly the current layer's whole value (reset by derive). */
  readonly removal?: RemovalSite;
}

export interface FoundReference {
  /** The reference text as it appears after decoding all layers. */
  readonly value: string;
  /** Span of the reference in the innermost decoded text. */
  readonly start: number;
  readonly end: number;
  readonly kind: ReferenceKind;
  readonly representation: Representation;
  readonly location: SourceLocation;
  readonly via: readonly string[];
  readonly lift: Lift | undefined;
  readonly element?: ElementAnchor;
  readonly removal?: RemovalSite;
}

const URL_ATTRIBUTES = new Set([
  'src',
  'href',
  'poster',
  'data',
  'background',
  'longdesc',
  'xlink:href',
  'lowsrc',
  'dynsrc',
  'manifest',
  'codebase',
  'archive',
]);
const PARAM_URL_NAMES = new Set(['movie', 'src', 'url', 'filename', 'file', 'video', 'audio', 'flashvars']);
/** Upstream "unresolved reference" detector (unresolvedAssetRefs.ts:29). */
const CONTEXT_PATH_RE = /\{\{context_path\}\}\/[^"'<>\s\\]+/g;
const PATH_LIKE = /^(?:\.\.?\/)*(?:content\/resources|resources|custom|files\/tmp|content)\/[^\s<>"]+$/;
const MEDIA_EXT =
  /\.(?:jpe?g|png|gif|webp|svg|bmp|ico|avif|mp4|m4v|mov|webm|ogv|ogg|oga|mp3|m4a|wav|flac|opus|vtt|srt|pdf|zip|elpx?|docx?|xlsx?|pptx?|odt|ods|odp|txt|html?|swf|woff2?|ttf|otf|css|js|json|xml|gif)$/i;

/** Composes a child lift through a decoding layer. */
export function childLift(parent: Lift | undefined, layer: DecodedText, rawOffset: number, encode: (t: string) => string): Lift | undefined {
  if (!parent) return undefined;
  return (edit) => {
    let lifted: TextEdit | undefined;
    try {
      lifted = liftEdit(edit, layer, rawOffset, encode);
    } catch {
      return undefined; // the replacement cannot be represented in this layer
    }
    return lifted ? parent(lifted) : undefined;
  };
}

/** Creates a derived context. */
export function derive(ctx: ScanContext, patch: Partial<Omit<ScanContext, 'location'>> & { location?: Partial<SourceLocation>; layer?: string }): ScanContext {
  const { layer, location, ...rest } = patch;
  const { removal, ...base } = ctx;
  void removal;
  return {
    ...base,
    ...rest,
    location: location ? { ...ctx.location, ...location } : ctx.location,
    via: layer ? [...ctx.via, layer] : ctx.via,
    depth: ctx.depth + 1,
  };
}

function emit(ctx: ScanContext, text: string, start: number, end: number, kind: ReferenceKind = ctx.kind, removal?: RemovalSite): void {
  // Trim whitespace around the reference, as browsers do for URL attributes.
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end <= start) return;
  const explicit = kind === 'explicit' && ctx.lift !== undefined;
  // A context removal site applies only to a reference that is the whole (trimmed) value.
  const site = removal ?? (ctx.removal && text.trim() === text.slice(start, end) ? ctx.removal : undefined);
  ctx.emit({
    value: text.slice(start, end),
    start,
    end,
    kind,
    representation: ctx.representation,
    location: ctx.location,
    via: ctx.via,
    lift: kind === 'explicit' ? ctx.lift : undefined,
    ...(ctx.element ? { element: ctx.element } : {}),
    ...(explicit && site ? { removal: site } : {}),
  });
}

/** Scans free text for {{context_path}} placeholders. */
export function scanPlainText(text: string, ctx: ScanContext): void {
  for (const m of text.matchAll(CONTEXT_PATH_RE)) emit(ctx, text, m.index, m.index + m[0].length);
}

/** Scans code (inline scripts, unknown JS) for possible references; results are dynamic. */
export function scanCode(text: string, ctx: ScanContext): void {
  const dyn = derive(ctx, { kind: 'dynamic', lift: undefined, layer: 'code' });
  scanPlainText(text, dyn);
  for (const m of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.){1,512}?)\1/g)) {
    const inner = m[2]!;
    if (inner.includes(CONTEXT_PATH)) continue;
    if (PATH_LIKE.test(inner) || (MEDIA_EXT.test(inner) && !/\s/.test(inner) && inner.length < 300)) {
      emit(dyn, text, m.index + 1, m.index + 1 + inner.length, 'dynamic');
    }
  }
}

/**
 * Scans a string value from JSON or an attribute that may be a URL, an HTML
 * fragment, nested JSON or percent-encoded content.
 */
export function scanValue(value: string, ctx: ScanContext): void {
  if (ctx.depth > ctx.maxDepth) return;
  const t = value.trim();
  if (t === '') return;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    if (scanJson(value, derive(ctx, { layer: 'json' }), true)) return;
  }
  if (looksLikeHtml(value)) {
    scanHtml(value, derive(ctx, { layer: 'html' }), true);
    return;
  }
  // A whole value is one reference; like upstream's import regex ([^"'<>]+) it may contain spaces
  // ("mi mapa.png"), but only when it ends with a file extension, so prose is still cut at whitespace.
  const single = !/\s/.test(t) || (!/[\t\n\r"'<>]/.test(t) && /\.[A-Za-z0-9]{1,8}$/.test(t));
  if (t.startsWith(CONTEXT_PATH) && single && !t.slice(CONTEXT_PATH.length + 1).includes(CONTEXT_PATH)) {
    emit(ctx, value, 0, value.length);
    return;
  }
  if (value.includes(CONTEXT_PATH)) {
    scanPlainText(value, ctx);
    return;
  }
  if (/^asset:\/\//.test(t) || PATH_LIKE.test(t)) {
    emit(ctx, value, 0, value.length);
    return;
  }
  if (looksPercentEncoded(t) && /^%(?:7B|5B|3C)/i.test(t)) {
    const decoded = decodePercent(value);
    if (decoded) {
      const child = derive(ctx, { lift: childLift(ctx.lift, decoded, 0, encodeComponent), layer: 'percent' });
      scanValue(decoded.text, child);
      return;
    }
  }
  if (MEDIA_EXT.test(t) && !/\s/.test(t) && t.length < 300 && !/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    // A bare file name in data: possibly a reference, never certain.
    emit(ctx, value, 0, value.length, 'dynamic');
  }
}

/**
 * Scans JSON text. Returns false when it is not valid JSON (then, unless
 * `quiet`, the text is scanned for placeholders and reported as malformed).
 */
export function scanJson(text: string, ctx: ScanContext, quiet = false): boolean {
  let doc;
  try {
    doc = parseJson(text, ctx.maxJsonDepth);
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    if (!quiet) {
      ctx.onMalformedJson?.(ctx.location, ctx.via);
      scanPlainText(text, derive(ctx, { lift: undefined, layer: 'malformed-json' }));
    }
    return false;
  }
  const style: JsonStyle = doc.style;
  visitJsonStrings(doc.root, (s, path) => {
    const lift = childLift(ctx.lift, s.decoded, s.rawStart, (t) => escapeJsonString(t, style));
    const jsonPath = ctx.location.jsonPath ? ctx.location.jsonPath + formatJsonPath(path).slice(1) : formatJsonPath(path);
    const removal: RemovalSite | undefined = lift ? { kind: 'json-string', lift, length: s.value.length } : undefined;
    scanValue(s.value, derive(ctx, { lift, layer: 'json-string', location: { jsonPath }, ...(removal ? { removal } : {}) }));
  });
  return true;
}

/** Scans CSS text for url()/@import references. */
export function scanCssText(text: string, ctx: ScanContext): void {
  for (const ref of scanCss(text)) {
    const lift = childLift(ctx.lift, ref.decoded, ref.rawStart, (t) => escapeCssUrl(t, ref.quote));
    const child = derive(ctx, { lift, layer: 'css-url' });
    emit(child, ref.decoded.text, 0, ref.decoded.text.length);
  }
}

/** Scans HTML (document or fragment). */
export function scanHtml(html: string, ctx: ScanContext, fragment: boolean): void {
  if (ctx.element) {
    const { element, ...rest } = ctx;
    void element;
    ctx = rest;
  }
  let fields: HtmlField[];
  try {
    fields = fragment ? scanHtmlFragment(html) : scanHtmlDocument(html);
  } catch {
    scanPlainText(html, derive(ctx, { lift: undefined, layer: 'unparsable-html' }));
    return;
  }
  for (const field of fields) scanHtmlField(field, ctx);
}

function scanHtmlField(field: HtmlField, ctx: ScanContext): void {
  const tag = field.element.tagName;
  const cls = field.element.attributes['class'] ?? '';
  const id = field.element.attributes['id'] ?? '';
  if (field.kind === 'attribute') {
    const name = field.name;
    const lift = field.rewritable ? childLift(ctx.lift, field.decoded, field.rawStart, (t) => encodeHtmlAttributeMinimal(t, field.quote)) : undefined;
    const element: ElementAnchor | undefined = ctx.lift
      ? {
          lift: ctx.lift,
          tag,
          key: { start: field.element.startOffset, end: field.element.startOffset },
          ...(field.element.removableSpan ? { span: field.element.removableSpan } : {}),
        }
      : undefined;
    const child = derive(ctx, { lift, layer: 'html-attribute', location: { element: tag, attribute: name }, ...(element ? { element } : {}) });
    const value = field.decoded.text;
    if (name === 'srcset' || name === 'imagesrcset') {
      const candidates = parseSrcset(value);
      candidates.forEach((c, index) => {
        const removal: RemovalSite | undefined = lift
          ? {
              kind: 'srcset',
              attribute: name,
              span: field.span,
              valueLift: lift,
              value,
              valueLength: value.length,
              candidates: candidates.map((x) => ({ start: x.start, end: x.candidateEnd })),
              index,
            }
          : undefined;
        emit(child, value, c.start, c.end, child.kind, removal);
      });
    } else if (name === 'style') {
      scanCssText(value, derive(child, { layer: 'css' }));
    } else if (
      URL_ATTRIBUTES.has(name) ||
      (tag === 'param' && name === 'value' && PARAM_URL_NAMES.has((field.element.attributes['name'] ?? '').toLowerCase()))
    ) {
      if (name === 'href' && tag === 'base') return;
      emit(child, value, 0, value.length, child.kind, { kind: 'attribute', attribute: name, span: field.span });
    } else if (name.startsWith('on')) {
      scanCode(value, child);
    } else if (value.includes(CONTEXT_PATH) || name.startsWith('data-')) {
      scanValue(value, child);
    }
    return;
  }
  // Text nodes.
  const lift = field.rewritable ? childLift(ctx.lift, field.decoded, field.rawStart, field.rawText ? rawTextEncoder(tag) : encodeHtmlTextMinimal) : undefined;
  const child = derive(ctx, { lift, layer: 'html-text', location: { element: tag } });
  const text = field.decoded.text;
  if (tag === 'style') {
    scanCssText(text, derive(child, { layer: 'css' }));
    return;
  }
  if (tag === 'script') {
    const type = (field.element.attributes['type'] ?? '').toLowerCase();
    if (type.includes('json') || id === 'exe-interactive-video-contents') {
      if (!scanJson(text, derive(child, { layer: 'json', location: { field: `${ctx.location.field ?? ''}#${id || 'script-json'}` } }), true)) {
        scanCode(text, child);
      }
    } else if (type === '' || type.includes('javascript') || type === 'module') {
      scanCode(text, child);
    } else {
      scanPlainText(text, derive(child, { lift: undefined }));
    }
    return;
  }
  const prefix = dataGamePrefix(cls);
  if (prefix !== undefined) {
    const encoding = dataGameEncoding(text);
    if (encoding === 'json') {
      if (!scanJson(text, derive(child, { layer: 'datagame-json' }), true)) scanPlainText(text, child);
    } else if (encoding === 'xor') {
      // Obfuscated payloads: decoded for discovery only; media URLs inside are usually stale.
      const clear = decryptDataGame(text.trim());
      const dyn = derive(child, { lift: undefined, kind: 'dynamic', layer: 'datagame-xor' });
      if (!scanJson(clear, dyn, true)) scanPlainText(clear, dyn);
    }
    return;
  }
  if (id === 'exe-interactive-video-contents') {
    if (!scanJson(text, derive(child, { layer: 'json' }), true)) scanPlainText(text, child);
    return;
  }
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    if (scanJson(text, derive(child, { layer: 'json' }), true)) return;
  }
  scanPlainText(text, child);
}

/** Raw text elements cannot contain their own end tag; nothing else needs escaping. */
function rawTextEncoder(tag: string): (t: string) => string {
  return (t) => {
    if (new RegExp(`</${tag}`, 'i').test(t)) throw new Error('Cannot place end tag inside raw text');
    return t;
  };
}
