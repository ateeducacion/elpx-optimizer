import { describe, expect, it } from 'vitest';
import { scanHtmlFragment, type HtmlTextField } from '../../../src/core/parse/html.js';

/** Text fields of a fragment. */
const texts = (html: string) => scanHtmlFragment(html).filter((f): f is HtmlTextField => f.kind === 'text');

describe('DataGame and interactive-video data containers', () => {
  it('returns the raw inner source when the JSON holds raw HTML that parse5 turned into elements', () => {
    const inner = '{"instructions":"<p style=\\"color:red\\"><audio src=\\"{{context_path}}/content/resources/x.webm\\"></audio></p>"}';
    const html = `<div class="relate-DataGame js-hidden">${inner}</div><p>after</p>`;
    const fields = scanHtmlFragment(html);
    const data = fields.find((f): f is HtmlTextField => f.kind === 'text' && f.rawSource === true)!;
    expect(data).toMatchObject({ value: inner, rawText: true, rewritable: true, rawStart: html.indexOf(inner), rawEnd: html.indexOf(inner) + inner.length });
    expect(data.element.attributes['class']).toBe('relate-DataGame js-hidden');
    // Children are not walked: no attribute field with a backslash-quoted value.
    expect(fields.some((f) => f.kind === 'attribute' && f.value.includes('\\"'))).toBe(false);
    expect(texts(html).map((f) => f.value)).toEqual([inner, 'after']);
  });

  it('applies to the interactive-video div and normalizes newlines', () => {
    const inner = '{"slides":[{"text":"<b>hola</b>",\r\n"url":"{{context_path}}/content/resources/s.png"}]}';
    const [field] = texts(`<div id="exe-interactive-video-contents" style="display:none">${inner}</div>`);
    expect(field).toMatchObject({ rawSource: true, value: inner });
    expect(field!.decoded.text).toBe(inner.replace('\r\n', '\n'));
    expect(field!.decoded.map.at(-1)).toBe(inner.length);
  });

  it('leaves plain containers, scripts and unclosed containers to the normal walk', () => {
    const plain = texts('<div class="mapa-DataGame">{"url":"{{context_path}}/content/resources/m.png"}</div>');
    expect(plain.map((f) => [f.value, f.rawSource])).toEqual([['{"url":"{{context_path}}/content/resources/m.png"}', undefined]]);
    const script = texts('<script id="exe-interactive-video-contents" type="application/json">{"a":"<b>x</b>"}</script>');
    expect(script[0]!.rawSource).toBeUndefined();
    const unclosed = scanHtmlFragment('<div class="x-DataGame">{"a":"<b>{{context_path}}/content/resources/u.png</b>"}');
    expect(unclosed.some((f) => f.kind === 'text' && f.rawSource)).toBe(false);
    expect(unclosed.some((f) => f.value === '{{context_path}}/content/resources/u.png')).toBe(true);
  });
});
