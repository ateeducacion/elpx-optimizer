import { DecodedBuilder, type DecodedText } from './text-map.js';

/**
 * JSON scanner that keeps raw offsets of string literals so that values can
 * be rewritten in place, preserving the original formatting and escaping of
 * every other byte. It accepts strict JSON only.
 */

export interface JsonString {
  readonly kind: 'string';
  readonly value: string;
  /** Raw offsets of the literal content, excluding the quotes. */
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly decoded: DecodedText;
}
export interface JsonObject {
  readonly kind: 'object';
  readonly entries: readonly { key: JsonString; value: JsonValue }[];
}
export interface JsonArray {
  readonly kind: 'array';
  readonly items: readonly JsonValue[];
}
export interface JsonPrimitive {
  readonly kind: 'number' | 'boolean' | 'null';
  readonly raw: string;
}
export type JsonValue = JsonObject | JsonArray | JsonString | JsonPrimitive;

/** Escaping conventions observed in a JSON document. */
export interface JsonStyle {
  /** The document escapes "/" as "\/" (e.g. PHP json_encode). */
  escapedSlash: boolean;
  /** The document escapes non-ASCII characters as \uXXXX. */
  asciiOnly: boolean;
}

export interface JsonDocument {
  readonly root: JsonValue;
  readonly style: JsonStyle;
}

/** Error raised when text is not valid JSON. */
export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'JsonSyntaxError';
  }
}

/** Parses strict JSON; throws JsonSyntaxError on invalid input or excessive depth. */
export function parseJson(text: string, maxDepth: number): JsonDocument {
  const state = { escapedSlash: false, rawNonAscii: false, escapedNonAscii: false };
  let pos = 0;
  const fail = (message: string): never => {
    throw new JsonSyntaxError(message, pos);
  };
  const ws = (): void => {
    while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) pos++;
  };
  const str = (): JsonString => {
    pos++; // opening quote
    const rawStart = pos;
    const b = new DecodedBuilder();
    for (;;) {
      if (pos >= text.length) fail('Unterminated string');
      const c = text.charCodeAt(pos);
      if (c === 0x22) break;
      if (c < 0x20) fail('Control character in string');
      if (c === 0x5c) {
        const e = text[pos + 1];
        const at = pos - rawStart;
        switch (e) {
          case '"':
          case '\\':
            b.push(e, at);
            pos += 2;
            break;
          case '/':
            state.escapedSlash = true;
            b.push('/', at);
            pos += 2;
            break;
          case 'b':
            b.push('\b', at);
            pos += 2;
            break;
          case 'f':
            b.push('\f', at);
            pos += 2;
            break;
          case 'n':
            b.push('\n', at);
            pos += 2;
            break;
          case 'r':
            b.push('\r', at);
            pos += 2;
            break;
          case 't':
            b.push('\t', at);
            pos += 2;
            break;
          case 'u': {
            const hex = text.slice(pos + 2, pos + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Invalid unicode escape');
            const code = Number.parseInt(hex, 16);
            if (code >= 0x80) state.escapedNonAscii = true;
            b.push(String.fromCharCode(code), at);
            pos += 6;
            break;
          }
          default:
            fail('Invalid escape');
        }
      } else {
        const runStart = pos;
        while (pos < text.length) {
          const d = text.charCodeAt(pos);
          if (d === 0x22 || d === 0x5c || d < 0x20) break;
          if (d >= 0x80) state.rawNonAscii = true;
          pos++;
        }
        b.pushVerbatim(text.slice(runStart, pos), runStart - rawStart);
      }
    }
    const rawEnd = pos;
    pos++;
    const decoded = b.finish(rawEnd - rawStart);
    return { kind: 'string', value: decoded.text, rawStart, rawEnd, decoded };
  };
  const value = (depth: number): JsonValue => {
    if (depth > maxDepth) fail('JSON nesting is too deep');
    ws();
    const c = text[pos];
    if (c === '{') {
      pos++;
      const entries: { key: JsonString; value: JsonValue }[] = [];
      ws();
      if (text[pos] === '}') {
        pos++;
        return { kind: 'object', entries };
      }
      for (;;) {
        ws();
        if (text[pos] !== '"') fail('Expected property name');
        const key = str();
        ws();
        if (text[pos] !== ':') fail('Expected ":"');
        pos++;
        entries.push({ key, value: value(depth + 1) });
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return { kind: 'object', entries };
        }
        fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      pos++;
      const items: JsonValue[] = [];
      ws();
      if (text[pos] === ']') {
        pos++;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return { kind: 'array', items };
        }
        fail('Expected "," or "]"');
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(pos, pos + 64));
    if (!m) return fail('Unexpected token');
    pos += m[0].length;
    const raw = m[0];
    return { kind: raw === 'true' || raw === 'false' ? 'boolean' : raw === 'null' ? 'null' : 'number', raw };
  };
  const root = value(1);
  ws();
  if (pos !== text.length) fail('Unexpected trailing content');
  return {
    root,
    style: { escapedSlash: state.escapedSlash, asciiOnly: state.escapedNonAscii && !state.rawNonAscii },
  };
}

/** Escapes a string for insertion inside an existing JSON string literal. */
export function escapeJsonString(text: string, style: JsonStyle): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '/' && style.escapedSlash) out += '\\/';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code >= 0x80 && style.asciiOnly) {
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return out;
}

/** Visits every string value (not keys) with its key path. */
export function visitJsonStrings(value: JsonValue, visit: (s: JsonString, path: readonly (string | number)[]) => void, path: (string | number)[] = []): void {
  if (value.kind === 'string') visit(value, path);
  else if (value.kind === 'object') {
    for (const { key, value: v } of value.entries) visitJsonStrings(v, visit, [...path, key.value]);
  } else if (value.kind === 'array') {
    value.items.forEach((item, i) => visitJsonStrings(item, visit, [...path, i]));
  }
}

/** Formats a key path as a JSONPath-like string ("$.a[0].b"). */
export function formatJsonPath(path: readonly (string | number)[]): string {
  let out = '$';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][\w$]*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`;
  return out;
}
