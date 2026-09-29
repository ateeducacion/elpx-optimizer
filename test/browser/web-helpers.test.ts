import { describe, expect, it } from 'vitest';
import { append, h, replace } from '../../src/web/dom.js';
import { bytes, duration, percent } from '../../src/web/format.js';
import { detectLang, translate } from '../../src/web/i18n.js';
import { icon, type IconName } from '../../src/web/icons.js';
import { readUrlSettings } from '../../src/web/url-settings.js';
import { BROWSER_LIMITS } from '../../src/core/limits.js';

describe('format helpers', () => {
  it('formats bytes with binary units per locale', () => {
    expect(bytes(0, 'en')).toBe('0 B');
    expect(bytes(1023, 'en')).toBe('1,023 B');
    expect(bytes(1536, 'en')).toBe('1.5 KB');
    expect(bytes(1536, 'es')).toBe('1,5 KB');
    expect(bytes(150 * 1024 * 1024, 'en')).toBe('150 MB');
    expect(bytes(-2048, 'en')).toBe('−2.0 KB');
    // Beyond the largest unit the value keeps growing in TB.
    expect(bytes(5 * 1024 ** 5, 'en')).toBe('5,120 TB');
  });

  it('formats durations as m:ss or h:mm:ss', () => {
    expect(duration(undefined)).toBe('—');
    expect(duration(Number.NaN)).toBe('—');
    expect(duration(Number.POSITIVE_INFINITY)).toBe('—');
    expect(duration(0)).toBe('0:00');
    expect(duration(65.4)).toBe('1:05');
    expect(duration(3725)).toBe('1:02:05');
  });

  it('formats percentages with one decimal', () => {
    expect(percent(0.1234, 'en')).toBe('12.3 %');
    expect(percent(0.5, 'es')).toBe('50 %');
  });
});

describe('i18n', () => {
  it('detects the language from the browser list, defaulting to Spanish', () => {
    expect(detectLang(['en-GB', 'es'])).toBe('en');
    expect(detectLang(['ES-es'])).toBe('es');
    expect(detectLang(['fr', 'EN'])).toBe('en');
    expect(detectLang(['fr', 'de'])).toBe('es');
    expect(detectLang([])).toBe('es');
  });

  it('translates keys and fills placeholders', () => {
    expect(translate('en', 'title')).toBe('eXeLearning project optimizer');
    expect(translate('es', 'title')).toBe('Optimizador de proyectos eXeLearning');
    expect(translate('en', 'processed', { done: 3, total: '10' })).toBe('3 of 10');
    // Missing parameters are left visible; unknown keys return the key itself.
    expect(translate('es', 'processed', { done: 1 })).toBe('1 de {total}');
    expect(translate('en', 'no-such-key')).toBe('no-such-key');
  });
});

describe('dom helper', () => {
  it('builds elements with attributes, listeners and text children', () => {
    let clicks = 0;
    const el = h(
      'button',
      { className: 'a b', type: 'button', disabled: false, hidden: true, 'data-x': 5, title: undefined, onclick: () => clicks++ },
      'text ',
      7,
      null,
      undefined,
      false,
      h('span', {}, '<b>not html</b>'),
    );
    expect(el.className).toBe('a b');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(el.getAttribute('hidden')).toBe('');
    expect(el.getAttribute('data-x')).toBe('5');
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.textContent).toBe('text 7<b>not html</b>');
    expect(el.querySelector('b')).toBeNull();
    el.click();
    expect(clicks).toBe(1);
    expect(h('div').outerHTML).toBe('<div></div>');
  });

  it('appends and replaces children', () => {
    const parent = h('div', {}, 'old');
    append(parent, ['a', 1, h('i')]);
    expect(parent.childNodes).toHaveLength(4);
    replace(parent, 'new', false, h('em', {}, 'x'));
    expect(parent.innerHTML).toBe('new<em>x</em>');
    replace(parent);
    expect(parent.childNodes).toHaveLength(0);
  });
});

describe('readUrlSettings', () => {
  const MiB = 1024 * 1024;

  it('keeps the defaults when nothing is given', () => {
    expect(readUrlSettings('')).toEqual({});
    expect(readUrlSettings('?lang=en&foo=bar')).toEqual({});
  });

  it('reads a positive whole number of MiB, capped at the browser limit', () => {
    expect(readUrlSettings('?maxVideoMiB=5')).toEqual({ maxVideoBytes: 5 * MiB });
    expect(readUrlSettings('maxVideoMiB=010')).toEqual({ maxVideoBytes: 10 * MiB });
    expect(readUrlSettings('?maxVideoMiB=%2012%20')).toEqual({ maxVideoBytes: 12 * MiB });
    expect(readUrlSettings('?maxVideoMiB=5000')).toEqual({ maxVideoBytes: BROWSER_LIMITS.maxVideoBytes });
    expect(readUrlSettings('?maxVideoMiB=99999999999999999999999')).toEqual({ maxVideoBytes: BROWSER_LIMITS.maxVideoBytes });
  });

  it('ignores invalid sizes', () => {
    for (const v of ['0', '000', '-3', '1.5', '1e3', 'abc', '', '0x10', 'Infinity']) {
      expect(readUrlSettings(`?maxVideoMiB=${encodeURIComponent(v)}`), v).toEqual({});
    }
  });

  it('reads the thread preference', () => {
    expect(readUrlSettings('?threads=single')).toEqual({ threading: 'single' });
    expect(readUrlSettings('?threads=auto&maxVideoMiB=1')).toEqual({ threading: 'auto', maxVideoBytes: MiB });
    for (const v of ['multi', 'SINGLE', '', '1']) expect(readUrlSettings(`?threads=${v}`), v).toEqual({});
  });
});

describe('icons', () => {
  // Every icon, checked at compile time against the bundled set.
  const ALL: Record<IconName, true> = {
    archive: true,
    'arrow-left': true,
    'arrow-repeat': true,
    'camera-video': true,
    'check-circle-fill': true,
    circle: true,
    download: true,
    eraser: true,
    eye: true,
    'pause-fill': true,
    'play-fill': true,
    'play-circle': true,
    'question-circle': true,
    robot: true,
    terminal: true,
    clipboard: true,
    'clipboard-check': true,
    'exclamation-triangle-fill': true,
    'file-earmark': true,
    'file-earmark-arrow-up': true,
    'file-earmark-pdf': true,
    files: true,
    'filetype-json': true,
    'folder-symlink': true,
    gear: true,
    github: true,
    image: true,
    'info-circle-fill': true,
    'music-note-beamed': true,
    'pencil-square': true,
    'shield-lock': true,
    feather: true,
    translate: true,
    trash3: true,
    'x-circle-fill': true,
  };

  it('turns every bundled SVG into a decorative inline icon', () => {
    const seen = new Set<string>();
    for (const name of Object.keys(ALL) as IconName[]) {
      const svg = icon(name);
      expect(svg, name).toBeInstanceOf(SVGSVGElement);
      expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(svg.ownerDocument).toBe(document);
      expect(svg.getAttribute('class')).toBe('bi');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      // Sized by CSS (1em), not by the file.
      expect(svg.hasAttribute('width')).toBe(false);
      expect(svg.hasAttribute('height')).toBe(false);
      expect(svg.getAttribute('viewBox')).toBe('0 0 16 16');
      expect(svg.querySelector('parsererror')).toBeNull();
      expect(svg.querySelector('path')).not.toBeNull();
      expect(svg.querySelector('script, foreignObject')).toBeNull();
      seen.add(svg.innerHTML);
    }
    // Each name is a different drawing.
    expect(seen.size).toBe(Object.keys(ALL).length);
  });

  it('adds extra classes and returns a fresh element each time', () => {
    const a = icon('github', 'fs-5');
    expect(a.getAttribute('class')).toBe('bi fs-5');
    const b = icon('github');
    expect(b).not.toBe(a);
    expect(b.innerHTML).toBe(a.innerHTML);
    document.body.append(a);
    expect(a.getBoundingClientRect().width).toBeGreaterThan(0);
    a.remove();
  });
});
