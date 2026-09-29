import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../../src/core/parse/text-map.js';
import { childElement, childElements, parseXml, textContent } from '../../../src/core/parse/xml.js';
import { escapeJsonString, JsonSyntaxError, parseJson, visitJsonStrings } from '../../../src/core/parse/json.js';
import { scanCss } from '../../../src/core/parse/css.js';
import { encodeHtmlAttributeMinimal, encodeHtmlTextMinimal, parseSrcset, scanHtmlDocument, scanHtmlFragment } from '../../../src/core/parse/html.js';
import type { ElpxError } from '../../../src/core/errors.js';

const X = { maxDepth: 50 };

/** Returns the error thrown by parseXml, if any. */
function xmlError(input: string): ElpxError | undefined {
  try {
    parseXml(input, X);
  } catch (e) {
    return e as ElpxError;
  }
  return undefined;
}

describe('text-map edge cases', () => {
  it('orders edits with the same start by their end', () => {
    expect(
      applyEdits('abcdef', [
        { start: 2, end: 4, text: 'X' },
        { start: 2, end: 2, text: 'I' },
      ]),
    ).toBe('abIXef');
  });
});

describe('parseXml edge cases', () => {
  it('skips processing instructions and comments around the root', () => {
    const doc = parseXml('<?xml version="1.0"?>\n<?xml-stylesheet href="a.xsl"?><!-- c --><x/>\n<?after?>\n<!-- end -->\n', X);
    expect(doc.root.name).toBe('x');
    expect(doc.doctype).toBeUndefined();
  });

  it('records a DOCTYPE without an external identifier', () => {
    expect(parseXml('<!DOCTYPE ode><ode/>', X).doctype).toEqual({ name: 'ode' });
    expect(parseXml('<!DOCTYPE ode PUBLIC "-//X//EN" "x.dtd" [ ]><ode/>', X).doctype).toEqual({ name: 'ode', externalId: 'PUBLIC "-//X//EN" "x.dtd"' });
  });

  it('reports truncated names and text at the end of input', () => {
    expect(xmlError('<')?.message).toMatch(/Invalid name/);
    expect(xmlError('<x>abc')?.message).toMatch(/Unclosed element <x>/);
    expect(xmlError('<x>abc')?.details).toMatchObject({ line: 1 });
    expect(xmlError('<a>\n\n<b>')?.details).toMatchObject({ line: 3 });
  });

  it('collects only text and CDATA children in textContent', () => {
    const doc = parseXml('<a>one<b>skip</b><![CDATA[two]]>three</a>', X);
    const content = textContent(doc.root);
    expect(content.text).toBe('onetwothree');
    expect(content.chunks.map((c) => [c.chunk.kind, c.offset])).toEqual([
      ['text', 0],
      ['cdata', 3],
      ['text', 6],
    ]);
  });

  it('finds child elements by local name', () => {
    const doc = parseXml('<ode:root xmlns:ode="u"><ode:page id="1"/><page id="2"/><other/></ode:root>', X);
    expect(childElements(doc.root, 'page').map((e) => e.attributes[0]!.value)).toEqual(['1', '2']);
    expect(childElements(doc.root, 'missing')).toEqual([]);
    expect(childElements(doc.root)).toHaveLength(3);
    expect(childElement(doc.root, 'missing')).toBeUndefined();
    expect(childElement(doc.root, 'other')?.name).toBe('other');
  });
});

describe('parseJson edge cases', () => {
  it('decodes every simple escape with an offset map', () => {
    const text = '["\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041ñ"]';
    const doc = parseJson(text, 5);
    const values: string[] = [];
    visitJsonStrings(doc.root, (s) => {
      values.push(s.value);
      expect(s.decoded.map).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 22, 23]);
    });
    expect(values).toEqual(['"\\/\b\f\n\r\tAñ']);
    expect(doc.style).toEqual({ escapedSlash: true, asciiOnly: false });
  });

  it('treats raw non-ASCII as not ASCII-only even with \\u escapes', () => {
    expect(parseJson('"\\u00e9é"', 2).style.asciiOnly).toBe(false);
    expect(parseJson('"\\u00e9"', 2).style.asciiOnly).toBe(true);
    expect(parseJson('"\\u0041"', 2).style.asciiOnly).toBe(false);
  });

  it('reports the offset of a missing separator', () => {
    let error: unknown;
    try {
      parseJson('{"a":1 "b":2}', 5);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(JsonSyntaxError);
    expect((error as JsonSyntaxError).message).toBe('Expected "," or "}"');
    expect((error as JsonSyntaxError).offset).toBe(7);
    expect((error as JsonSyntaxError).name).toBe('JsonSyntaxError');
    expect(() => parseJson('{"a":1', 5)).toThrow(/Expected "," or "}"/);
    expect(() => parseJson('', 5)).toThrow(/Unexpected token/);
  });

  it('escapes quotes, newlines and code points that need escaping', () => {
    expect(escapeJsonString('a"b\nc/', { escapedSlash: true, asciiOnly: false })).toBe('a\\"b\\nc\\/');
    expect(escapeJsonString(' é', { escapedSlash: false, asciiOnly: false })).toBe('\\u2029é');
    expect(escapeJsonString('é', { escapedSlash: false, asciiOnly: true })).toBe('\\u00e9');
  });
});

describe('scanCss edge cases', () => {
  it('stops at an unterminated comment', () => {
    expect(scanCss('a{background:url(a.png)} /* url(b.png)')).toHaveLength(1);
  });

  it('ignores unterminated @import strings and escapes at the end of input', () => {
    expect(scanCss('@import "a.css\n; b{c:url(d.png)}').map((r) => r.decoded.text)).toEqual(['d.png']);
    expect(scanCss('@import "a\\')).toEqual([]);
    expect(scanCss('a{b:url(x\\')).toEqual([]);
    expect(scanCss('a{b:url("x.png\n)}')).toEqual([]);
  });

  it('replaces out-of-range and surrogate code points', () => {
    expect(scanCss('a{b:url(\\110000 x)}').map((r) => r.decoded.text)).toEqual(['�x']);
    expect(scanCss('a{b:url(\\d800 x)}').map((r) => r.decoded.text)).toEqual(['�x']);
    expect(scanCss('a{b:url(\\10FFFF)}').map((r) => r.decoded.text)).toEqual(['\u{10FFFF}']);
  });
});

describe('html scanning edge cases', () => {
  it('handles parser-created elements and attributes without source locations', () => {
    const fields = scanHtmlDocument('<body a="1"><p title=x>y</p><body b="2"><p>z</p><html lang="es">');
    const attrs = fields.filter((f) => f.kind === 'attribute').map((f) => (f.kind === 'attribute' ? f.name : ''));
    // "b" and "lang" are merged into existing elements by the parser and have no location.
    expect(attrs).toEqual(['a', 'title']);
    const p = fields.find((f) => f.kind === 'text' && f.value === 'y')!;
    expect(p.element.ancestors).toEqual(['html', 'body']);
    const implied = scanHtmlDocument('<p>x</p>').find((f) => f.kind === 'text')!;
    expect(implied.element.startOffset).toBe(0);
    expect(implied.element.ancestors).toEqual(['html', 'body']);
  });

  it('marks foster-parented text as not rewritable', () => {
    const fields = scanHtmlFragment('<table>a<tr><td>b</td></tr>c</table>');
    // The parser merges "a" and "c" into one node whose source span also covers the table.
    const moved = fields.find((f) => f.kind === 'text' && f.value === 'ac')!;
    expect(moved.rewritable).toBe(false);
    expect(fields.find((f) => f.kind === 'text' && f.value === 'b')!.rewritable).toBe(true);
  });

  it('scans text placed directly at the top level of a fragment', () => {
    const html = 'Descarga {{context_path}}/content/resources/doc.pdf <b>x</b> fin';
    const fields = scanHtmlFragment(html);
    const top = fields.filter((f) => f.kind === 'text' && f.element.tagName === '#document-fragment');
    expect(top.map((f) => f.value)).toEqual(['Descarga {{context_path}}/content/resources/doc.pdf ', ' fin']);
    expect(top[0]!.element.ancestors).toEqual([]);
    expect(html.slice(top[0]!.rawStart, top[0]!.rawEnd)).toBe(top[0]!.value);
    expect(top.every((f) => f.rewritable)).toBe(true);
    expect(fields.find((f) => f.element.tagName === 'b')!.value).toBe('x');
    expect(scanHtmlFragment('')).toEqual([]);
  });

  it('scans text inside template content', () => {
    const fields = scanHtmlFragment('<template>{{context_path}}/a.png<img src="t.png"></template>');
    const text = fields.find((f) => f.kind === 'text')!;
    expect(text.value).toBe('{{context_path}}/a.png');
    expect(text.element.tagName).toBe('template');
    expect(fields.find((f) => f.kind === 'attribute')!.element.ancestors).toEqual(['template']);
  });

  it('locates values after whitespace around "=" and maps carriage returns', () => {
    const html = '<a href =  "x.png" title="1\r2">t</a><script>a\r\nb\rc</script>';
    const fields = scanHtmlFragment(html);
    const href = fields.find((f) => f.kind === 'attribute' && f.name === 'href')!;
    expect(html.slice(href.rawStart, href.rawEnd)).toBe('x.png');
    const title = fields.find((f) => f.kind === 'attribute' && f.name === 'title')!;
    expect(title.value).toBe('1\n2');
    expect(title.rewritable).toBe(true);
    const script = fields.find((f) => f.kind === 'text' && f.element.tagName === 'script')!;
    expect(script.value).toBe('a\nb\nc');
    expect(script.decoded.map).toEqual([0, 1, 3, 4, 5, 6]);
    expect(script.rewritable).toBe(true);
  });

  it('parses srcset values with trailing separators', () => {
    expect(parseSrcset('a.png 1x, ').map((c) => c.url)).toEqual(['a.png']);
    expect(parseSrcset(' ,  ')).toEqual([]);
  });

  it('encodes attribute replacements with minimal escaping', () => {
    expect(encodeHtmlAttributeMinimal('foto&paisaje.jpg', '"')).toBe('foto&paisaje.jpg');
    expect(encodeHtmlAttributeMinimal('say "hi" & go', '"')).toBe('say &quot;hi&quot; & go');
    expect(encodeHtmlAttributeMinimal("it's", "'")).toBe('it&#39;s');
    expect(encodeHtmlAttributeMinimal('a b', null)).toBe('a&#32;b');
    // Text that would be read as a character reference falls back to full escaping.
    expect(encodeHtmlAttributeMinimal('a&amp;b', '"')).toBe('a&amp;amp;b');
    expect(encodeHtmlAttributeMinimal('x&copy', null)).toBe('x&amp;copy');
  });

  it('encodes text replacements with minimal escaping', () => {
    expect(encodeHtmlTextMinimal('a<b & c>')).toBe('a&lt;b & c>');
    expect(encodeHtmlTextMinimal('a&lt;')).toBe('a&amp;lt;');
  });
});
