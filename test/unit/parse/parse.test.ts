import { describe, expect, it } from 'vitest';
import { applyEdits, identity, liftEdit, DecodedBuilder } from '../../../src/core/parse/text-map.js';
import {
  attributeValue,
  childElement,
  childElements,
  encodeCdata,
  escapeXmlAttribute,
  liftTextContentEdit,
  localName,
  parseXml,
  textContent,
} from '../../../src/core/parse/xml.js';
import { escapeJsonString, formatJsonPath, JsonSyntaxError, parseJson, visitJsonStrings } from '../../../src/core/parse/json.js';
import { decodePercent, encodeComponent, encodePathLike, looksPercentEncoded } from '../../../src/core/parse/uri.js';
import { escapeCssUrl, scanCss } from '../../../src/core/parse/css.js';
import {
  decodeHtmlRefs,
  escapeHtmlAttribute,
  escapeHtmlText,
  looksLikeHtml,
  parseSrcset,
  scanHtmlDocument,
  scanHtmlFragment,
} from '../../../src/core/parse/html.js';
import { DecodingMode } from 'entities/decode';
import { ElpxError } from '../../../src/core/errors.js';

const X = { maxDepth: 50 };

describe('text-map', () => {
  it('lifts and applies edits', () => {
    const b = new DecodedBuilder();
    b.pushVerbatim('ab', 0);
    b.push('&', 2); // raw "&amp;" at 2..7
    b.pushVerbatim('cd', 7);
    const layer = b.finish(9);
    expect(layer.text).toBe('ab&cd');
    const lifted = liftEdit({ start: 3, end: 5, text: 'X"' }, layer, 10, (t) => t.replace(/"/g, '&quot;'));
    expect(lifted).toEqual({ start: 17, end: 19, text: 'X&quot;' });
    expect(liftEdit({ start: 0, end: 9, text: '' }, layer, 0, (t) => t)).toBeUndefined();
    expect(
      applyEdits('0123456789', [
        { start: 5, end: 7, text: 'x' },
        { start: 1, end: 2, text: 'yy' },
      ]),
    ).toBe('0yy234x789');
    expect(() =>
      applyEdits('0123', [
        { start: 0, end: 2, text: '' },
        { start: 1, end: 3, text: '' },
      ]),
    ).toThrow(/Overlapping/);
    expect(identity('abc').map).toEqual([0, 1, 2, 3]);
  });

  it('refuses to split a multi-unit escape', () => {
    const b = new DecodedBuilder();
    b.push('\u{1F600}', 0); // two code units from one raw escape
    const layer = b.finish(8);
    expect(liftEdit({ start: 1, end: 2, text: 'x' }, layer, 0, (t) => t)).toBeUndefined();
    expect(liftEdit({ start: 0, end: 1, text: 'x' }, layer, 0, (t) => t)).toBeUndefined();
    expect(liftEdit({ start: 0, end: 2, text: 'x' }, layer, 0, (t) => t)).toEqual({ start: 0, end: 8, text: 'x' });
  });
});

describe('parseXml', () => {
  const xml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ode SYSTEM "content.dtd">
<!-- c -->
<ode xmlns="http://www.intef.es/xsd/ode" version='2.0'>
  <odeNavStructures>
    <odeNavStructure><odePageId>p1</odePageId><pageName>Caf&#233; &amp; t&#xE9;</pageName></odeNavStructure>
  </odeNavStructures>
  <htmlView><![CDATA[<p><img src="{{context_path}}/a.png"></p>]]></htmlView>
  <jsonProperties>{&quot;src&quot;:&quot;res/a b.png&quot;}</jsonProperties>
  <empty a="x&lt;y" b = "1"/>
  <?pi ok?>
</ode>`;

  it('parses elements, attributes, text and CDATA with offsets', () => {
    const doc = parseXml(xml, X);
    expect(doc.doctype).toEqual({ name: 'ode', externalId: 'SYSTEM "content.dtd"' });
    expect(doc.root.name).toBe('ode');
    expect(attributeValue(doc.root, 'version')).toBe('2.0');
    const nav = childElement(childElement(doc.root, 'odeNavStructures')!, 'odeNavStructure')!;
    expect(textContent(childElement(nav, 'pageName')!).text).toBe('Café & té');
    const html = textContent(childElement(doc.root, 'htmlView')!);
    expect(html.text).toContain('{{context_path}}/a.png');
    const empty = childElement(doc.root, 'empty')!;
    expect(attributeValue(empty, 'a')).toBe('x<y');
    expect(empty.attributes[0]!.quote).toBe('"');
    expect(childElements(doc.root).length).toBe(4);
    expect(localName('ode:page')).toBe('page');
  });

  it('lifts edits in text and CDATA chunks back to raw XML', () => {
    const doc = parseXml(xml, X);
    const json = textContent(childElement(doc.root, 'jsonProperties')!);
    const idx = json.text.indexOf('res/a b.png');
    const e1 = liftTextContentEdit(json, { start: idx, end: idx + 11, text: 'res/<b>&c.png' })!;
    const cdata = textContent(childElement(doc.root, 'htmlView')!);
    const j = cdata.text.indexOf('a.png');
    const e2 = liftTextContentEdit(cdata, { start: j, end: j + 5, text: 'b.png' })!;
    const out = applyEdits(xml, [e1, e2]);
    expect(out).toContain('{&quot;src&quot;:&quot;res/&lt;b&gt;&amp;c.png&quot;}');
    expect(out).toContain('{{context_path}}/b.png');
    const again = parseXml(out, X);
    expect(textContent(childElement(again.root, 'jsonProperties')!).text).toBe('{"src":"res/<b>&c.png"}');
    // edits crossing an entity or CDATA with "]]>" are refused
    const k = json.text.indexOf('"src');
    expect(liftTextContentEdit(json, { start: k + 1, end: k + 2, text: 'x' })).toBeDefined();
    expect(liftTextContentEdit(json, { start: 0, end: json.text.length + 5, text: 'x' })).toBeUndefined();
    expect(liftTextContentEdit(cdata, { start: 0, end: 1, text: ']]>' })).toBeUndefined();
  });

  it('refuses edits that split an entity reference', () => {
    const doc = parseXml('<a>x&#x1F600;y</a>', X);
    const content = textContent(doc.root);
    expect(content.text).toBe('x\u{1F600}y');
    expect(liftTextContentEdit(content, { start: 1, end: 2, text: 'z' })).toBeUndefined();
    expect(liftTextContentEdit(content, { start: 2, end: 3, text: 'z' })).toBeUndefined();
  });

  it.each([
    ['<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>', 'xml-security', /entities/],
    ['<!DOCTYPE x [<!ELEMENT x ANY>]><x/>', 'xml-security', /internal subset/],
    ['<!DOCTYPE x SYSTEM "http://evil/x.dtd"><x>&ext;</x>', 'xml-security', /Undefined entity/],
    ['<x>&nbsp;</x>', 'xml-security', /Undefined entity/],
    ['<x><![CDATA[a</x>', 'content-xml-invalid', /CDATA/],
    ['<x><y></x>', 'content-xml-invalid', /Mismatched/],
    ['<x a="1" a="2"/>', 'content-xml-invalid', /Duplicate attribute/],
    ['<x a=1/>', 'content-xml-invalid', /Unquoted/],
    ['<x>a</x><y/>', 'content-xml-invalid', /after the root/],
    ['', 'content-xml-invalid', /root/],
    ['<x>\u0000</x>', 'content-xml-invalid', /NUL/],
    ['<x>&#0;</x>', 'xml-security', /Undefined entity/],
    ['<x>&#xD800;</x>', 'xml-security', /Undefined entity/],
    ['<x>&amp</x>', 'content-xml-invalid', /Unterminated entity/],
    ['<x><!ENTITY a "b"></x>', 'xml-security', /markup declaration/],
    ['<x><!-- open </x>', 'content-xml-invalid', /comment/],
    ['<x a="<"/>', 'content-xml-invalid', /"<"/],
    ['<x a="1"b="2"/>', 'content-xml-invalid', /whitespace/],
    ['<x a/>', 'content-xml-invalid', /without value/],
    ['<x', 'content-xml-invalid', /Unterminated start tag/],
    ['<x/ >', 'content-xml-invalid', /Malformed empty/],
    ['<x></x >', 'content-xml-invalid', /./],
    ['<x>]]></x>', 'content-xml-invalid', /not allowed/],
    ['<1x/>', 'content-xml-invalid', /Invalid name/],
    ['<x a="1/>', 'content-xml-invalid', /Unterminated attribute/],
    ['<?xml version="1.0"', 'content-xml-invalid', /processing instruction/],
    ['<!DOCTYPE x', 'content-xml-invalid', /DOCTYPE/],
    ['<x></x', 'content-xml-invalid', /Malformed closing/],
    ['<x><y>', 'content-xml-invalid', /Unclosed/],
  ])('rejects %j', (input, code, message) => {
    let error: unknown;
    try {
      parseXml(input, X);
    } catch (e) {
      error = e;
    }
    if (input === '<x></x >') {
      expect(error).toBeUndefined();
      return;
    }
    expect(error).toBeInstanceOf(ElpxError);
    expect((error as ElpxError).code).toBe(code);
    expect((error as ElpxError).message).toMatch(message);
  });

  it('enforces the depth limit', () => {
    const deep = '<a>'.repeat(20) + '</a>'.repeat(20);
    expect(() => parseXml(deep, { maxDepth: 10 })).toThrow(/too deep/);
    expect(parseXml(deep, { maxDepth: 30 }).root.name).toBe('a');
  });

  it('escapes attributes and CDATA', () => {
    expect(escapeXmlAttribute('a"b\'<&\n', '"')).toBe("a&quot;b'&lt;&amp;&#10;");
    expect(escapeXmlAttribute("a'b", "'")).toBe('a&apos;b');
    expect(encodeCdata('ok')).toBe('ok');
    expect(() => encodeCdata('a]]>b')).toThrow();
  });

  it('normalizes attribute whitespace', () => {
    const doc = parseXml('<x a="1\n2&#10;3"/>', X);
    expect(attributeValue(doc.root, 'a')).toBe('1 2\n3');
  });
});

describe('parseJson', () => {
  it('parses strict JSON and keeps literal offsets', () => {
    const text = '{"a": "x\\/y\\u00e9\\n", "b": [1, -2.5e3, true, false, null, {"c": "d"}], "": {}, "e": []}';
    const doc = parseJson(text, 20);
    expect(doc.style.escapedSlash).toBe(true);
    expect(doc.style.asciiOnly).toBe(true);
    const strings: [string, string][] = [];
    visitJsonStrings(doc.root, (s, p) => strings.push([formatJsonPath(p), s.value]));
    expect(strings).toEqual([
      ['$.a', 'x/yé\n'],
      ['$.b[5].c', 'd'],
    ]);
    expect(formatJsonPath(['a b', 0, 'ok_1'])).toBe('$["a b"][0].ok_1');
    const a = (doc.root as unknown as { entries: { value: { rawStart: number; rawEnd: number } }[] }).entries[0]!.value;
    expect(text.slice(a.rawStart, a.rawEnd)).toBe('x\\/y\\u00e9\\n');
  });

  it('round-trips edits with preserved escaping', () => {
    const text = '{"src":"res\\/a.png","t":"\\u00e1"}';
    const doc = parseJson(text, 5);
    const s = (doc.root as unknown as { entries: { value: { rawStart: number; decoded: { text: string; map: number[] } } }[] }).entries[0]!.value;
    const lifted = liftEdit({ start: 4, end: 9, text: 'ñ/b".png' }, s.decoded as never, s.rawStart, (t) => escapeJsonString(t, doc.style))!;
    const out = applyEdits(text, [lifted]);
    expect(out).toBe('{"src":"res\\/\\u00f1\\/b\\".png","t":"\\u00e1"}');
    expect(JSON.parse(out)).toEqual({ src: 'res/ñ/b".png', t: 'á' });
  });

  it('escapes control and separator characters', () => {
    expect(escapeJsonString('a\u0001 \t\b\f\r\\', { escapedSlash: false, asciiOnly: false })).toBe('a\\u0001\\u2028\\t\\b\\f\\r\\\\');
    expect(escapeJsonString('😀/', { escapedSlash: false, asciiOnly: true })).toBe('\\ud83d\\ude00/');
  });

  it.each(['{', '{"a" 1}', '{"a":1,}', '[1 2]', '"abc', '"a\\x"', '"\\u12"', 'tru', '{1:2}', '[1]x', '"a\u0001"'])('rejects %j', (bad) => {
    expect(() => parseJson(bad, 10)).toThrow(JsonSyntaxError);
  });

  it('enforces depth', () => {
    expect(() => parseJson('[[[[1]]]]', 3)).toThrow(/too deep/);
  });
});

describe('percent decoding', () => {
  it('decodes UTF-8 runs with a map', () => {
    const d = decodePercent('a%20b%C3%A9%F0%9F%98%80c')!;
    expect(d.text).toBe('a bé\u{1F600}c');
    expect(d.map.slice(0, 5)).toEqual([0, 1, 4, 5, 11]);
    expect(decodePercent('%zz')).toBeUndefined();
    expect(decodePercent('%C3')).toBeUndefined();
    expect(decodePercent('%C0%80')).toBeUndefined();
    expect(decodePercent('%ED%A0%80')).toBeUndefined();
    expect(decodePercent('%E0%80%80')).toBeUndefined();
    expect(decodePercent('%FF')).toBeUndefined();
    expect(decodePercent('%C3%28')).toBeUndefined();
  });

  it('detects and encodes components and paths', () => {
    expect(looksPercentEncoded(encodeComponent('{"a":"b c"}'))).toBe(true);
    expect(looksPercentEncoded('{"a"}')).toBe(false);
    expect(looksPercentEncoded('abc')).toBe(false);
    expect(encodePathLike('content/resources/a b/ñ#?.png', false)).toBe('content/resources/a%20b/ñ%23%3F.png');
    expect(encodePathLike('ñ', true)).toBe('%C3%B1');
  });
});

describe('scanCss', () => {
  it('finds url() and @import references with escapes', () => {
    const css = `/* url(ignored.png) */ @import "base.css"; @import url(x.css);
      .a { background: url( 'img/a\\ b.png' ) } .b{background:URL(img/c\\).png)} .c{content:"url(nope)"} .d{b:myurl(no.png)}
      @font-face{src:url("f.woff2") format("woff2")}`;
    const refs = scanCss(css);
    expect(refs.map((r) => [r.kind, r.decoded.text, r.quote])).toEqual([
      ['import', 'base.css', '"'],
      ['url', 'x.css', null],
      ['url', 'img/a b.png', "'"],
      ['url', 'img/c).png', null],
      ['url', 'f.woff2', '"'],
    ]);
    const r = refs[2]!;
    expect(css.slice(r.rawStart, r.rawEnd)).toBe('img/a\\ b.png');
  });

  it('decodes hex escapes and rejects malformed urls', () => {
    const refs = scanCss('a{b:url(\\31 .png)} c{d:url(a b)} i{j:url(\\0)} k{l:url(x"y)}');
    expect(refs.map((r) => r.decoded.text)).toEqual(['1.png', '�']);
    expect(scanCss('e{f:url("x" y)}')).toEqual([]);
    expect(scanCss('@import url("u.css"); @import foo;')[0]!.decoded.text).toBe('u.css');
    expect(scanCss('a{b:url(x')).toEqual([]);
    expect(scanCss('"unterminated\n url(a.png)').map((r) => r.decoded.text)).toEqual(['a.png']);
    expect(scanCss('x{y:url("a\\\nb")}')[0]!.decoded.text).toBe('ab');
    expect(scanCss('x{y:url(\\41\r\nB)}')[0]!.decoded.text).toBe('AB');
  });

  it('escapes urls for each quoting style', () => {
    expect(escapeCssUrl('a"b\\c\n', '"')).toBe('a\\"b\\\\c\\a ');
    expect(escapeCssUrl('a b(c)', null)).toBe('a\\20 b\\28 c\\29 ');
  });
});

describe('html scanning', () => {
  it('extracts attributes and text with raw spans', () => {
    const html = `<!doctype html><html><head><title>T &amp; U</title><style>.a{background:url(a.png)}</style></head>
<body><img src="res/a&amp;b.png" srcset='x.png 1x, y%20z.png 2x' alt=hi data-x=unquoted>
<video poster="p.jpg"><source src="v.mp4"><track src="s.vtt"></video>
<div class="exe-DataGame js-hidden">%7B%22a%22%3A1%7D</div><template><img src="t.png"></template>
<p title="&notit; &copy">x&#65;y&ampz</p><input disabled></body></html>`;
    const fields = scanHtmlDocument(html);
    const src = fields.find((f) => f.kind === 'attribute' && f.name === 'src' && f.element.tagName === 'img')!;
    expect(src.kind === 'attribute' && src.decoded.text).toBe('res/a&b.png');
    expect(html.slice(src.rawStart, src.rawEnd)).toBe('res/a&amp;b.png');
    expect(src.rewritable).toBe(true);
    const unq = fields.find((f) => f.kind === 'attribute' && f.name === 'data-x')!;
    expect(unq.kind === 'attribute' && unq.quote).toBeNull();
    expect(fields.some((f) => f.kind === 'attribute' && f.value === 't.png')).toBe(true);
    const style = fields.find((f) => f.kind === 'text' && f.element.tagName === 'style')!;
    expect(style.kind === 'text' && style.rawText).toBe(true);
    const dg = fields.find((f) => f.kind === 'text' && f.element.attributes['class']?.includes('DataGame'))!;
    expect(dg.value).toBe('%7B%22a%22%3A1%7D');
    const p = fields.find((f) => f.kind === 'text' && f.element.tagName === 'p')!;
    expect(p.value).toBe('xAy&z');
    expect(p.rewritable).toBe(true);
    const title = fields.find((f) => f.kind === 'attribute' && f.name === 'title')!;
    expect(title.rewritable).toBe(true);
    expect(title.value).toBe('&notit; ©');
    expect(fields.find((f) => f.kind === 'attribute' && f.name === 'src' && f.element.tagName === 'source')!.element.ancestors).toContain('video');
  });

  it('scans fragments and handles CRLF', () => {
    const fields = scanHtmlFragment('<p a="1\r\n2">l1\r\nl2</p><script>var a = "b.png";</script>');
    const attr = fields.find((f) => f.kind === 'attribute')!;
    expect(attr.value).toBe('1\n2');
    expect(attr.rewritable).toBe(true);
    const text = fields.find((f) => f.kind === 'text' && f.element.tagName === 'p')!;
    expect(text.value).toBe('l1\nl2');
    expect(text.rewritable).toBe(true);
    const script = fields.find((f) => f.kind === 'text' && f.element.tagName === 'script')!;
    expect(script.kind === 'text' && script.rawText).toBe(true);
  });

  it('decodes references in isolation', () => {
    expect(decodeHtmlRefs('&amp;&lt;&#x41;&foo;&', DecodingMode.Legacy).text).toBe('&<A&foo;&');
    expect(decodeHtmlRefs('a&ampb', DecodingMode.Attribute).text).toBe('a&ampb');
    expect(decodeHtmlRefs('a &amp', DecodingMode.Attribute).text).toBe('a &');
  });

  it('parses srcset candidates', () => {
    expect(parseSrcset('a.png 1x, b.png 2x,c.png,  d(1).png 100w').map((c) => c.url)).toEqual(['a.png', 'b.png', 'c.png', 'd(1).png']);
    // Per the HTML spec a comma without whitespace does not split URLs.
    expect(parseSrcset('a.png,b.png')).toEqual([{ start: 0, end: 11, url: 'a.png,b.png', candidateEnd: 11 }]);
    expect(parseSrcset('a.png, b.png')).toEqual([
      { start: 0, end: 5, url: 'a.png', candidateEnd: 5 },
      { start: 7, end: 12, url: 'b.png', candidateEnd: 12 },
    ]);
    // candidateEnd covers the descriptors, without the separator or trailing spaces.
    expect(parseSrcset('a.png 1x , b.png, c.png 2x ').map((c) => [c.url, c.candidateEnd])).toEqual([
      ['a.png', 8],
      ['b.png', 16],
      ['c.png', 26],
    ]);
    expect(parseSrcset('')).toEqual([]);
    expect(parseSrcset('img.png 1x (foo, bar), c.png').map((c) => c.url)).toEqual(['img.png', 'c.png']);
  });

  it('escapes html', () => {
    expect(escapeHtmlAttribute('a&"\'b', '"')).toBe("a&amp;&quot;'b");
    expect(escapeHtmlAttribute("a'b", "'")).toBe('a&#39;b');
    expect(escapeHtmlAttribute('a b=c', null)).toBe('a&#32;b&#61;c');
    expect(escapeHtmlText('<a&b>')).toBe('&lt;a&amp;b&gt;');
    expect(looksLikeHtml('<p class="x">hi</p>')).toBe(true);
    expect(looksLikeHtml('a < b > c')).toBe(false);
  });
});
