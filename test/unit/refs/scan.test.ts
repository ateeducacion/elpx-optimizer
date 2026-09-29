import { describe, expect, it } from 'vitest';
import { applyEdits, identity } from '../../../src/core/parse/text-map.js';
import {
  childLift,
  derive,
  scanCode,
  scanCssText,
  scanHtml,
  scanJson,
  scanPlainText,
  scanValue,
  type FoundReference,
  type ScanContext,
} from '../../../src/core/refs/scan.js';
import { encryptDataGame } from '../../../src/core/format/datagame.js';

/** A scan context over a raw text whose lift is the identity. */
function collect(patch: Partial<ScanContext> = {}): { ctx: ScanContext; found: FoundReference[]; malformed: string[] } {
  const found: FoundReference[] = [];
  const malformed: string[] = [];
  const ctx: ScanContext = {
    entry: 'content.xml',
    representation: 'editable',
    location: { entry: 'content.xml' },
    via: [],
    lift: (e) => e,
    kind: 'explicit',
    depth: 0,
    maxDepth: 24,
    maxJsonDepth: 64,
    emit: (f) => found.push(f),
    onMalformedJson: (_loc, via) => malformed.push(via.join('>')),
    ...patch,
  };
  return { ctx, found, malformed };
}

/** Rewrites one found reference in the raw text through its lift chain. */
function rewrite(raw: string, f: FoundReference | undefined, text: string): string | undefined {
  const edit = f?.lift?.({ start: f.start, end: f.end, text });
  return edit ? applyEdits(raw, [edit]) : undefined;
}

/** Finds the reference with the given value. */
function byValue(found: readonly FoundReference[], value: string): FoundReference {
  const f = found.find((x) => x.value === value);
  if (!f) throw new Error(`no reference ${value} in ${found.map((x) => x.value).join(', ')}`);
  return f;
}

describe('context helpers', () => {
  it('derives contexts and composes lifts', () => {
    const { ctx } = collect({ location: { entry: 'content.xml', field: 'htmlView' } });
    const child = derive(ctx, { layer: 'json', location: { jsonPath: '$.a' }, kind: 'dynamic' });
    expect(child).toMatchObject({ depth: 1, via: ['json'], kind: 'dynamic', location: { entry: 'content.xml', field: 'htmlView', jsonPath: '$.a' } });
    expect(derive(ctx, {}).via).toEqual([]);
    expect(childLift(undefined, identity('x'), 0, (t) => t)).toBeUndefined();
    const lift = childLift(ctx.lift, identity('abc'), 10, () => {
      throw new Error('cannot encode');
    })!;
    expect(lift({ start: 0, end: 1, text: 'z' })).toBeUndefined();
    expect(childLift(ctx.lift, identity('abc'), 10, (t) => t)!({ start: 2, end: 9, text: 'z' })).toBeUndefined();
  });
});

describe('scanPlainText and scanCode', () => {
  it('finds placeholders the way upstream detects unresolved references', () => {
    const { ctx, found } = collect();
    const raw = 'see {{context_path}}/a b.png and "{{context_path}}/c.png" \\"{{context_path}}/d.png\\"';
    scanPlainText(raw, ctx);
    expect(found.map((f) => f.value)).toEqual(['{{context_path}}/a', '{{context_path}}/c.png', '{{context_path}}/d.png']);
    expect(rewrite(raw, found[1], '{{context_path}}/X.png')).toBe(raw.replace('/c.png', '/X.png'));
  });

  it('marks strings in code as dynamic, non-rewritable references', () => {
    const { ctx, found } = collect();
    const code =
      `var a = "content/resources/x.png"; b = '{{context_path}}/y.jpg'; c = \`foto.JPG\`; d = "not a path"; e = "https://h/z.png"; f = 'with space.png';` +
      ` g = "content/resources/mis fotos/Año 1.png"; h = 'tab\there.png'; i = "content/resources/sin extension";`;
    scanCode(code, ctx);
    // Names with spaces count too (a false positive only protects a file); tabs and extensionless paths do not.
    expect(found.map((f) => [f.value, f.kind, f.lift, f.via.join('>')])).toEqual([
      ['{{context_path}}/y.jpg', 'dynamic', undefined, 'code'],
      ['content/resources/x.png', 'dynamic', undefined, 'code'],
      ['foto.JPG', 'dynamic', undefined, 'code'],
      ['https://h/z.png', 'dynamic', undefined, 'code'],
      ['with space.png', 'dynamic', undefined, 'code'],
      ['content/resources/mis fotos/Año 1.png', 'dynamic', undefined, 'code'],
    ]);
  });
});

describe('scanValue', () => {
  it('recognizes whole placeholders, internal URIs and archive paths', () => {
    for (const v of ['{{context_path}}/a.png', ' asset://abc.png ', 'content/resources/a.png', '../resources/a.png', 'files/tmp/1/2/a.png']) {
      const { ctx, found } = collect();
      scanValue(v, ctx);
      expect(found.map((f) => f.value)).toEqual([v.trim()]);
      expect(found[0]!.kind).toBe('explicit');
    }
  });

  it('scans placeholders embedded in longer text', () => {
    const { ctx, found } = collect();
    scanValue('Mira {{context_path}}/a.png y {{context_path}}/b.png', ctx);
    expect(found.map((f) => f.value)).toEqual(['{{context_path}}/a.png', '{{context_path}}/b.png']);
    const two = collect();
    scanValue('{{context_path}}/a.png{{context_path}}/b.png', two.ctx);
    expect(two.found.map((f) => f.value)).toEqual(['{{context_path}}/a.png{{context_path}}/b.png']);
  });

  it('keeps a whole placeholder with spaces as one reference, but cuts prose at whitespace', () => {
    const one = collect();
    scanValue('{{context_path}}/content/resources/mi mapa.png', one.ctx);
    expect(one.found.map((f) => f.value)).toEqual(['{{context_path}}/content/resources/mi mapa.png']);
    const prose = collect();
    scanValue('{{context_path}}/content/resources/fondo.png es el fondo', prose.ctx);
    expect(prose.found.map((f) => f.value)).toEqual(['{{context_path}}/content/resources/fondo.png']);
    const quoted = collect();
    scanValue('{{context_path}}/content/resources/a b"c.png', quoted.ctx);
    expect(quoted.found.map((f) => f.value)).toEqual(['{{context_path}}/content/resources/a']);
  });

  it('treats bare media names as possible references and ignores other text', () => {
    const { ctx, found } = collect();
    for (const v of ['foto.png', 'https://example.org/foto.png', 'mailto:x@y.png', 'two words.png', '', '   ', 'plain text']) scanValue(v, ctx);
    expect(found.map((f) => [f.value, f.kind, f.lift])).toEqual([['foto.png', 'dynamic', undefined]]);
  });

  it('decodes nested JSON and HTML values and lifts edits through them', () => {
    const raw = '{"slides":[{"url":"{{context_path}}/content/resources/s.png"}],"html":"<img src=\\"{{context_path}}/content/resources/i.png\\">"}';
    const { ctx, found } = collect();
    scanValue(raw, ctx);
    const slide = byValue(found, '{{context_path}}/content/resources/s.png');
    expect(slide.via).toEqual(['json', 'json-string']);
    expect(slide.location.jsonPath).toBe('$.slides[0].url');
    const img = byValue(found, '{{context_path}}/content/resources/i.png');
    expect(img.via).toEqual(['json', 'json-string', 'html', 'html-attribute']);
    const out = rewrite(raw, img, '{{context_path}}/content/resources/"q".png')!;
    expect(JSON.parse(out).html).toBe('<img src="{{context_path}}/content/resources/&quot;q&quot;.png">');
    // A brace-wrapped value that is not JSON is still scanned as text.
    const loose = collect();
    scanValue('{not json {{context_path}}/z.png}', loose.ctx);
    expect(loose.found.map((f) => f.value)).toEqual(['{{context_path}}/z.png}']);
  });

  it('decodes percent-encoded JSON (flipcards/dragdrop style) and re-encodes edits', () => {
    const inner = JSON.stringify({ url: 'content/resources/caña.png' });
    const raw = encodeURIComponent(inner);
    const { ctx, found } = collect();
    scanValue(raw, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.via).toEqual(['percent', 'json', 'json-string']);
    const out = rewrite(raw, found[0], 'content/resources/año.png')!;
    expect(JSON.parse(decodeURIComponent(out))).toEqual({ url: 'content/resources/año.png' });
    // Percent-encoded text that does not start like JSON/HTML is not decoded.
    const other = collect();
    scanValue('abc%20def', other.ctx);
    expect(other.found).toEqual([]);
    const broken = collect();
    scanValue('%7B%ZZ', broken.ctx);
    expect(broken.found).toEqual([]);
  });

  it('stops at the configured decoding depth', () => {
    const { ctx, found } = collect({ depth: 25 });
    scanValue('{{context_path}}/a.png', ctx);
    expect(found).toEqual([]);
  });
});

describe('scanJson', () => {
  it('reports malformed JSON and still finds placeholders, without a lift', () => {
    const { ctx, found, malformed } = collect({ via: ['xml-cdata'] });
    expect(scanJson('{"textTextarea": "<img src=\\"{{context_path}}/a.png\\"', ctx)).toBe(false);
    expect(malformed).toEqual(['xml-cdata']);
    expect(found.map((f) => [f.value, f.lift, f.via.at(-1)])).toEqual([['{{context_path}}/a.png', undefined, 'malformed-json']]);
    const quiet = collect();
    expect(scanJson('{bad', quiet.ctx, true)).toBe(false);
    expect(quiet.malformed).toEqual([]);
  });

  it('keeps PHP-style escaped slashes and ASCII-only escaping when rewriting', () => {
    const raw = '{"a":"{{context_path}}\\/content\\/resources\\/x.png","t":"\\u00e1"}';
    const { ctx, found } = collect({ location: { entry: 'content.xml', jsonPath: '$.outer' } });
    scanJson(raw, ctx);
    expect(found[0]!.location.jsonPath).toBe('$.outer.a');
    expect(rewrite(raw, found[0], '{{context_path}}/content/resources/ñ.png')).toBe(
      '{"a":"{{context_path}}\\/content\\/resources\\/\\u00f1.png","t":"\\u00e1"}',
    );
  });

  it('propagates unexpected errors', () => {
    const { ctx } = collect({
      maxJsonDepth: Number.NaN,
      emit: () => {
        throw new RangeError('boom');
      },
    });
    expect(() => scanJson('{"a":"content/resources/a.png"}', ctx)).toThrow(RangeError);
  });
});

describe('scanCssText', () => {
  it('finds url() and @import with lifts that keep the quoting style', () => {
    const css = '@import "base.css"; .a{background:url(img/a\\ b.png)} .b{background:url(\'img/c.png\')}';
    const { ctx, found } = collect({ representation: 'resource' });
    scanCssText(css, ctx);
    expect(found.map((f) => [f.value, f.via.join('>')])).toEqual([
      ['base.css', 'css-url'],
      ['img/a b.png', 'css-url'],
      ['img/c.png', 'css-url'],
    ]);
    expect(rewrite(css, found[1], 'img/d (1).png')).toBe('@import "base.css"; .a{background:url(img/d\\20 \\28 1\\29 .png)} .b{background:url(\'img/c.png\')}');
    expect(rewrite(css, found[2], "img/it's.png")).toContain("url('img/it\\'s.png')");
  });
});

describe('scanHtml', () => {
  it('extracts URL attributes, srcset candidates, styles and poster/track sources', () => {
    const html =
      '<video poster="p.jpg"><source src="v.mp4"><track kind="captions" src="c.vtt"></video>' +
      '<img src="a&amp;b.jpg" srcset="x.png 1x, y.png 2x" style="background:url(s.png)" data-src="lazy.png" title="{{context_path}}/t.png" alt="foto.png">' +
      '<object data="o.swf"><param name="movie" value="m.swf"><param name="quality" value="q.png"></object>' +
      '<base href="https://example.org/"><a href="d.pdf" onclick="open(\'content/resources/w.pdf\')">d</a>';
    const { ctx, found } = collect();
    scanHtml(html, ctx, true);
    const values = found.map((f) => f.value);
    expect(values).toEqual([
      'p.jpg',
      'v.mp4',
      'c.vtt',
      'a&b.jpg',
      'x.png',
      'y.png',
      's.png',
      'lazy.png',
      '{{context_path}}/t.png',
      'o.swf',
      'm.swf',
      'd.pdf',
      'content/resources/w.pdf',
    ]);
    expect(byValue(found, 'lazy.png').kind).toBe('dynamic');
    expect(byValue(found, 'content/resources/w.pdf').kind).toBe('dynamic');
    expect(byValue(found, 's.png').via).toEqual(['html-attribute', 'css', 'css-url']);
    expect(byValue(found, 'c.vtt').location).toMatchObject({ element: 'track', attribute: 'src' });
    // "&" stays raw unless it would be read as a character reference (eXeLearning matches literally).
    expect(rewrite(html, byValue(found, 'a&b.jpg'), 'c&d.jpg')).toContain('src="c&d.jpg"');
    expect(rewrite(html, byValue(found, 'a&b.jpg'), 'c&amp;"d.jpg')).toContain('src="c&amp;amp;&quot;d.jpg"');
    expect(rewrite(html, byValue(found, 'y.png'), 'z z.png')).toContain('srcset="x.png 1x, z z.png 2x"');
  });

  it('reads SVG xlink:href attributes of inline SVG', () => {
    const html = `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="{{context_path}}/content/resources/i.png"/><use xlink:href="#icon"/></svg>`;
    const { ctx, found } = collect();
    scanHtml(html, ctx, true);
    expect(found.map((f) => [f.value, f.location.attribute])).toEqual([
      ['{{context_path}}/content/resources/i.png', 'xlink:href'],
      ['#icon', 'xlink:href'],
    ]);
    expect(rewrite(html, found[0], '{{context_path}}/content/resources/j.png')).toContain('<image xlink:href="{{context_path}}/content/resources/j.png"/>');
  });

  it('reads JSON scripts and the interactive-video JSON block (div and script forms)', () => {
    const json = JSON.stringify({ slides: [{ type: 'image', url: '{{context_path}}/content/resources/s1.png' }] });
    const html =
      `<div id="exe-interactive-video-contents" style="display: none">${json}</div>` +
      `<script id="exe-interactive-video-contents" type="application/json">${json.replace('s1', 's2')}</script>` +
      `<script type="application/ld+json">{"image":"{{context_path}}/content/resources/s3.png"}</script>`;
    const { ctx, found } = collect();
    scanHtml(html, ctx, true);
    expect(found.map((f) => [f.value, f.kind])).toEqual([
      ['{{context_path}}/content/resources/s1.png', 'explicit'],
      ['{{context_path}}/content/resources/s2.png', 'explicit'],
      ['{{context_path}}/content/resources/s3.png', 'explicit'],
    ]);
    expect(found[1]!.location.field).toBe('#exe-interactive-video-contents');
    expect(rewrite(html, found[1], '{{context_path}}/content/resources/n.png')).toContain('"url":"{{context_path}}/content/resources/n.png"');
    // Raw text cannot receive its own end tag.
    expect(rewrite(html, found[1], '</script><b>')).toBeUndefined();
  });

  it('falls back to code scanning for broken JSON scripts and ordinary scripts', () => {
    const html =
      '<script type="application/json">{"a": "{{context_path}}/j.png"</script>' +
      '<script>var v = "content/resources/v.mp4";</script><script type="module">import "./m.js";</script>' +
      '<script type="text/template"><img src="{{context_path}}/tpl.png"></script>' +
      '<div id="exe-interactive-video-contents">{broken {{context_path}}/iv.png</div>';
    const { ctx, found } = collect();
    scanHtml(html, ctx, true);
    expect(found.map((f) => [f.value, f.kind, f.lift === undefined])).toEqual([
      ['{{context_path}}/j.png', 'dynamic', true],
      ['content/resources/v.mp4', 'dynamic', true],
      ['./m.js', 'dynamic', true],
      ['{{context_path}}/tpl.png', 'explicit', true],
      ['{{context_path}}/iv.png', 'explicit', false],
    ]);
  });

  it('decodes plain and obfuscated DataGame payloads', () => {
    const plain = JSON.stringify({ url: '{{context_path}}/content/resources/mapa.png' });
    const secret = encryptDataGame(JSON.stringify({ url: '{{context_path}}/content/resources/secreto.png', img: 'files/tmp/2025/10/24/X/leon.png' }));
    const html =
      `<div class="mapa-DataGame js-hidden">${plain}</div>` +
      `<div class="clasifica-DataGame js-hidden">${secret}</div>` +
      '<div class="adivina-DataGame">{not json {{context_path}}/g.png}</div>' +
      `<div class="rosco-DataGame">${encryptDataGame('plain text {{context_path}}/r.png')}</div>` +
      '<div class="sopa-DataGame">  </div>' +
      '<a href="{{context_path}}/content/resources/leon.png" class="js-hidden clasifica-LinkImages">0</a>';
    const { ctx, found } = collect();
    scanHtml(html, ctx, true);
    expect(found.map((f) => [f.value, f.kind, f.via.at(-1)])).toEqual([
      ['{{context_path}}/content/resources/mapa.png', 'explicit', 'json-string'],
      ['{{context_path}}/content/resources/secreto.png', 'dynamic', 'json-string'],
      ['files/tmp/2025/10/24/X/leon.png', 'dynamic', 'json-string'],
      ['{{context_path}}/g.png}', 'explicit', 'html-text'],
      ['{{context_path}}/r.png', 'dynamic', 'datagame-xor'],
      ['{{context_path}}/content/resources/leon.png', 'explicit', 'html-attribute'],
    ]);
    expect(rewrite(html, found[0], '{{context_path}}/content/resources/m2.png')).toContain(
      '<div class="mapa-DataGame js-hidden">{"url":"{{context_path}}/content/resources/m2.png"}</div>',
    );
  });

  it('reads plain-JSON DataGames whose strings contain raw HTML as JSON, with clean rewritable references', () => {
    const html =
      '<div class="relate-DataGame js-hidden">{"instructions":"<p style=\\"color:red\\"><audio src=\\"{{context_path}}/content/resources/x.webm\\"></audio></p>","img":"{{context_path}}/content/resources/y.png"}</div>';
    const { ctx, found } = collect();
    scanHtml(html, ctx, true);
    expect(found.map((f) => [f.value, f.kind, f.via.join('>')])).toEqual([
      ['{{context_path}}/content/resources/x.webm', 'explicit', 'html-text>datagame-json>json-string>html>html-attribute'],
      ['{{context_path}}/content/resources/y.png', 'explicit', 'html-text>datagame-json>json-string'],
    ]);
    expect(found.every((f) => !f.value.includes('\\'))).toBe(true);
    const out = rewrite(html, found[0], '{{context_path}}/content/resources/z.webm')!;
    expect(out).toContain('<audio src=\\"{{context_path}}/content/resources/z.webm\\">');
    expect(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).instructions).toContain('src="{{context_path}}/content/resources/z.webm"');
  });

  it('parses JSON-looking text nodes and scans the rest as text', () => {
    const html =
      '<div>{"u":"content/resources/j.png"}</div><div>[1,"x"</div><p>ver {{context_path}}/p.png &amp; más</p><style>.x{background:url(st.png)}</style>';
    const { ctx, found } = collect();
    scanHtml(html, ctx, true);
    expect(found.map((f) => f.value)).toEqual(['content/resources/j.png', '{{context_path}}/p.png', 'st.png']);
    expect(rewrite(html, byValue(found, '{{context_path}}/p.png'), '{{context_path}}/<q>&.png')).toContain('ver {{context_path}}/&lt;q>&.png &amp; más');
    expect(rewrite(html, byValue(found, '{{context_path}}/p.png'), '{{context_path}}/&lt;.png')).toContain('ver {{context_path}}/&amp;lt;.png &amp; más');
  });

  it('scans full documents, including foster-parented table text', () => {
    const doc =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="theme/style.css"></head><body><table>{{context_path}}/f.png<tr><td>x</td></tr></table></body></html>';
    const { ctx, found } = collect({ representation: 'published' });
    scanHtml(doc, ctx, false);
    expect(found.map((f) => [f.value, f.representation, f.lift === undefined])).toEqual([
      ['theme/style.css', 'published', false],
      ['{{context_path}}/f.png', 'published', false],
    ]);
    expect(rewrite(doc, found[1], 'g.png')).toBe(doc.replace('{{context_path}}/f.png', 'g.png'));
  });
});
