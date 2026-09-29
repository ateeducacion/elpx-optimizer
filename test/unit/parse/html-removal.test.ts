import { describe, expect, it } from 'vitest';
import { scanHtmlDocument, scanHtmlFragment, type HtmlAttributeField, type HtmlField } from '../../../src/core/parse/html.js';

/** Source spans used to take references out of markup: whole removable elements and attributes. */

/** The source text of each element's removable span, by the attribute that identifies it. */
function removable(html: string, fields: HtmlField[] = scanHtmlFragment(html)): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const f of fields) {
    if (f.kind !== 'attribute' || f.name !== 'id') continue;
    const span = f.element.removableSpan;
    out[f.value] = span ? html.slice(span.start, span.end) : undefined;
  }
  return out;
}

/** Attribute fields by name. */
function attribute(html: string, name: string): HtmlAttributeField {
  return scanHtmlFragment(html).find((f): f is HtmlAttributeField => f.kind === 'attribute' && f.name === name)!;
}

describe('removableSpan', () => {
  it('covers void elements and elements with an end tag and nothing but whitespace or comments inside', () => {
    const html =
      '<p id="p">text <img id="img" src="a.png"> <br id="br"/></p>' +
      '<video id="video" src="v.mp4"> <!-- none --> \n</video>' +
      '<video id="with-text" src="v.mp4">No video</video>' +
      '<object id="object" data="x.swf"><param id="param" name="movie" value="x.swf"></object>' +
      '<a id="empty-link" href="x.pdf"></a>' +
      '<ul><li id="li">no end tag</ul>' +
      '<template id="template"> </template><template id="full-template"><img src="t.png"></template>';
    expect(removable(html)).toEqual({
      p: undefined,
      img: '<img id="img" src="a.png">',
      br: '<br id="br"/>',
      video: '<video id="video" src="v.mp4"> <!-- none --> \n</video>',
      'with-text': undefined,
      object: undefined,
      param: '<param id="param" name="movie" value="x.swf">',
      'empty-link': '<a id="empty-link" href="x.pdf"></a>',
      li: undefined,
      template: '<template id="template"> </template>',
      'full-template': undefined,
    });
  });

  it('is absent for elements the parser implied, and for elements holding other elements', () => {
    // No <html>, <head> or <body> tags in the source: the text lives in an implied body.
    const text = scanHtmlDocument('solo texto').find((f) => f.kind === 'text')!;
    expect(text.element.tagName).toBe('body');
    expect(text.element.removableSpan).toBeUndefined();
    const html = '<table id="table"><tr id="tr"><td id="td"></td></tr></table>';
    expect(removable(html, scanHtmlDocument(html))).toEqual({ table: undefined, tr: undefined, td: '<td id="td"></td>' });
  });
});

describe('attribute spans', () => {
  it('include the whitespace before the attribute, whatever the quoting', () => {
    for (const [html, name, expected] of [
      ['<img src="a.png" alt="x">', 'src', ' src="a.png"'],
      ['<img alt="x"\n\t src=\'a.png\'>', 'src', "\n\t src='a.png'"],
      ['<img alt=x src = a.png>', 'src', ' src = a.png'],
    ] as const) {
      const f = attribute(html, name);
      expect(html.slice(f.span.start, f.span.end)).toBe(expected);
      // Removing the span leaves well-formed markup.
      expect(html.slice(0, f.span.start) + html.slice(f.span.end)).not.toContain('a.png');
    }
  });
});
