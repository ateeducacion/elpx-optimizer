import { describe, expect, it } from 'vitest';
import { DecodingMode } from 'entities/decode';
import { decodeHtmlRefs, encodeHtmlAttributeMinimal, encodeHtmlTextMinimal } from '../../../src/core/parse/html.js';

describe('minimal HTML encoders', () => {
  it('keep "&" raw in attributes unless it would be read as a character reference', () => {
    expect(encodeHtmlAttributeMinimal('foto&paisaje.jpg', '"')).toBe('foto&paisaje.jpg');
    expect(encodeHtmlAttributeMinimal('a&b "c".png', '"')).toBe('a&b &quot;c&quot;.png');
    expect(encodeHtmlAttributeMinimal("it's.png", "'")).toBe('it&#39;s.png');
    expect(encodeHtmlAttributeMinimal('a b=c.png', null)).toBe('a&#32;b&#61;c.png');
    // "&copy" and "&amp;" would decode: fall back to full escaping.
    expect(encodeHtmlAttributeMinimal('a&copy.png', '"')).toBe('a&amp;copy.png');
    expect(encodeHtmlAttributeMinimal('a&amp;b.png', "'")).toBe('a&amp;amp;b.png');
    expect(encodeHtmlAttributeMinimal('x&#65;.png', null)).toBe('x&amp;#65;.png');
  });

  it('round-trip every result through the HTML decoder', () => {
    const samples = ['plain.png', 'a&b.png', 'a&copy.png', 'a&amp;b', '&#x41;', '"q"', "'s'", 'a b', 'ñ & 😀', '&', '&&;'];
    for (const text of samples) {
      for (const quote of ['"', "'", null] as const) {
        expect(decodeHtmlRefs(encodeHtmlAttributeMinimal(text, quote), DecodingMode.Attribute).text).toBe(text);
      }
      expect(decodeHtmlRefs(encodeHtmlTextMinimal(text), DecodingMode.Legacy).text).toBe(text);
    }
  });

  it('only escape "<" in text unless an entity would form', () => {
    expect(encodeHtmlTextMinimal('a < b & c > d')).toBe('a &lt; b & c > d');
    expect(encodeHtmlTextMinimal('a&lt;b')).toBe('a&amp;lt;b');
    expect(encodeHtmlTextMinimal('fish&chips')).toBe('fish&chips');
  });
});
