import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionMatches, mimeFromExtension, sniff, SNIFF_BYTES } from '../../../src/core/media/sniff.js';
import { MEDIA } from '../../helpers/native.js';
import { cat, latin1 } from '../../helpers/image-craft.js';

/** Builds an ISO BMFF head: size, "ftyp", major brand and compatible brands. */
function ftyp(major: string, ...compatible: string[]): Uint8Array {
  return cat([0, 0, 0, 0x20], latin1('ftyp'), latin1(major), [0, 0, 0, 0], ...compatible.map(latin1));
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(MEDIA, name))).subarray(0, SNIFF_BYTES);

describe('sniff', () => {
  it.each([
    ['jpeg', cat([0xff, 0xd8, 0xff, 0xe0]), 'image', 'image/jpeg'],
    ['png', cat([0x89], latin1('PNG\r\n\x1a\n')), 'image', 'image/png'],
    ['gif', latin1('GIF87a'), 'image', 'image/gif'],
    ['gif', latin1('GIF89a'), 'image', 'image/gif'],
    ['webp', latin1('RIFF\x10\x00\x00\x00WEBPVP8 '), 'image', 'image/webp'],
    ['avi', latin1('RIFF\x10\x00\x00\x00AVI LIST'), 'video', 'video/x-msvideo'],
    ['wav', latin1('RIFF\x10\x00\x00\x00WAVEfmt '), 'audio', 'audio/wav'],
    ['avif', ftyp('avif', 'mif1'), 'image', 'image/avif'],
    ['avif', ftyp('mif1', 'avis'), 'image', 'image/avif'],
    ['heic', ftyp('heic', 'mif1'), 'image', 'image/heic'],
    ['heic', ftyp('mif1', 'heic'), 'image', 'image/heic'],
    ['mov', ftyp('qt  '), 'video', 'video/quicktime'],
    ['m4a', ftyp('M4A '), 'audio', 'audio/mp4'],
    ['m4a', ftyp('M4B '), 'audio', 'audio/mp4'],
    ['3gp', ftyp('3gp5'), 'video', 'video/3gpp'],
    ['m4v', ftyp('M4V '), 'video', 'video/x-m4v'],
    ['m4v', ftyp('M4VH'), 'video', 'video/x-m4v'],
    ['m4v', ftyp('M4VP'), 'video', 'video/x-m4v'],
    ['mp4', ftyp('isom', 'iso2', 'avc1'), 'video', 'video/mp4'],
    ['mov', cat([0, 0, 0, 8], latin1('moov')), 'video', 'video/quicktime'],
    ['mov', cat([0, 0, 0, 8], latin1('mdat')), 'video', 'video/quicktime'],
    ['mov', cat([0, 0, 0, 8], latin1('wide')), 'video', 'video/quicktime'],
    ['webm', cat([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], latin1('webm')), 'video', 'video/webm'],
    ['mkv', cat([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], latin1('matroska')), 'video', 'video/x-matroska'],
    ['ogv', latin1('OggS\x00\x02........\x80theora'), 'video', 'video/ogg'],
    ['opus', latin1('OggS\x00\x02........OpusHead'), 'audio', 'audio/ogg'],
    ['ogg', latin1('OggS\x00\x02........\x01vorbis'), 'audio', 'audio/ogg'],
    ['flv', latin1('FLV\x01'), 'video', 'video/x-flv'],
    ['mpeg', cat([0, 0, 1, 0xba, 0x44]), 'video', 'video/mpeg'],
    ['asf', latin1('0&\xb2u\x8ef\xcf\x11\xa6\xd9\x00\xaa\x00b\xce\x6c'), 'video', 'video/x-ms-asf'],
    ['mp3', latin1('ID3\x03\x00'), 'audio', 'audio/mpeg'],
    ['mp3', cat([0xff, 0xfb, 0x90, 0x64]), 'audio', 'audio/mpeg'],
    ['flac', latin1('fLaC\x00'), 'audio', 'audio/flac'],
    ['bmp', latin1('BM\x36\x00'), 'image', 'image/bmp'],
    ['ico', cat([0, 0, 1, 0, 1, 0]), 'image', 'image/x-icon'],
    ['tiff', latin1('II*\x00\x08\x00'), 'image', 'image/tiff'],
    ['tiff', latin1('MM\x00*\x00\x00'), 'image', 'image/tiff'],
    ['pdf', latin1('%PDF-1.7\n'), 'document', 'application/pdf'],
    ['woff', latin1('wOFF\x00\x01'), 'font', 'font/woff'],
    ['woff2', latin1('wOF2\x00\x01'), 'font', 'font/woff2'],
    ['otf', latin1('OTTO\x00\x0a'), 'font', 'font/otf'],
    ['ttf', cat([0, 1, 0, 0, 0, 0x0a]), 'font', 'font/ttf'],
    ['zip', latin1('PK\x03\x04\x14\x00'), 'archive', 'application/zip'],
  ])('recognizes %s from its magic bytes', (format, head, kind, mime) => {
    expect(sniff(head, 'no-extension')).toEqual({ kind, format, mime });
  });

  it('recognizes MPEG transport streams only with a second sync byte at 188', () => {
    const ts = new Uint8Array(189);
    ts[0] = 0x47;
    ts[188] = 0x47;
    expect(sniff(ts, 'a.ts').format).toBe('mpegts');
    expect(sniff(ts.subarray(0, 188), 'a.ts').format).not.toBe('mpegts');
  });

  it('does not treat every 0xFF byte pair as MPEG audio', () => {
    // Layer bits 00 are reserved: not a frame sync.
    expect(sniff(cat([0xff, 0xe0, 0x41, 0x42]), 'x').kind).not.toBe('audio');
  });

  it('classifies ZIP containers of office documents by extension', () => {
    const head = latin1('PK\x03\x04\x14\x00');
    for (const ext of ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub']) {
      expect(sniff(head, `doc.${ext}`)).toEqual({ kind: 'document', format: ext, mime: 'application/zip' });
    }
    expect(sniff(head, 'bundle.zip').kind).toBe('archive');
  });

  it('falls back to binary for RIFF files of other types and control bytes', () => {
    expect(sniff(latin1('RIFF\x10\x00\x00\x00AIFF'), 'a.aif')).toEqual({ kind: 'unknown', format: 'binary', mime: 'application/octet-stream' });
    expect(sniff(cat([0x41, 0x42, 0x03]), 'a.txt').format).toBe('binary');
    expect(sniff(cat([0x41, 0x00]), 'a.txt').format).toBe('binary');
    // Tabs, newlines and ESC sequences are text.
    expect(sniff(cat(latin1('a\tb\r\n'), [0x1b], latin1('[0m')), 'log.txt').kind).toBe('text');
  });

  it('recognizes SVG with or without an XML prolog, a BOM or leading space', () => {
    const svg = { kind: 'image', format: 'svg', mime: 'image/svg+xml' };
    expect(sniff(latin1('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x')).toEqual(svg);
    expect(sniff(latin1('<?xml version="1.0"?>\n<svg/>'), 'x')).toEqual(svg);
    expect(sniff(latin1('\xEF\xBB\xBF  <SVG/>'), 'x')).toEqual(svg);
    // An SVG extension is enough when the file starts with markup (e.g. a DOCTYPE first).
    expect(sniff(latin1('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg/>'), 'a.svg')).toEqual(svg);
    expect(sniff(latin1('<?xml version="1.0"?><root/>'), 'a.xml').format).toBe('xml');
    expect(sniff(latin1('not markup'), 'a.svg')).toEqual({ kind: 'text', format: 'txt', mime: 'text/plain' });
    expect(sniff(fixture('diagram.svg'), 'diagram.svg').format).toBe('svg');
  });

  it('recognizes WebVTT by content and text types by extension', () => {
    expect(sniff(latin1('WEBVTT\n\n00:00.000 --> 00:01.000\nhola'), 'captions.txt')).toEqual({ kind: 'text', format: 'vtt', mime: 'text/vtt' });
    const cases: [string, string, string][] = [
      ['html', 'html', 'text/html'],
      ['htm', 'html', 'text/html'],
      ['xhtml', 'html', 'application/xhtml+xml'],
      ['css', 'css', 'text/css'],
      ['js', 'js', 'text/javascript'],
      ['mjs', 'js', 'text/javascript'],
      ['json', 'json', 'application/json'],
      ['xml', 'xml', 'application/xml'],
      ['xsd', 'xml', 'application/xml'],
      ['dtd', 'dtd', 'application/xml-dtd'],
      ['srt', 'srt', 'application/x-subrip'],
      ['vtt', 'vtt', 'text/vtt'],
      ['txt', 'txt', 'text/plain'],
      ['md', 'txt', 'text/markdown'],
      ['csv', 'csv', 'text/csv'],
    ];
    for (const [ext, format, mime] of cases) expect(sniff(latin1('a,b\n1,2'), `f.${ext.toUpperCase()}`)).toEqual({ kind: 'text', format, mime });
    expect(sniff(fixture('subs.srt'), 'subs.srt').format).toBe('srt');
    expect(sniff(fixture('captions.vtt'), 'captions.vtt').format).toBe('vtt');
  });

  it('recognizes HTML without an extension and falls back to plain text', () => {
    expect(sniff(latin1('  <!DOCTYPE html><html>'), 'page').format).toBe('html');
    expect(sniff(latin1('<HTML><body>'), 'page').format).toBe('html');
    expect(sniff(latin1('just words'), 'README')).toEqual({ kind: 'text', format: 'txt', mime: 'text/plain' });
    expect(sniff(new Uint8Array(0), 'empty')).toEqual({ kind: 'text', format: 'txt', mime: 'text/plain' });
  });

  it.each([
    ['photo-exif-icc.jpg', 'jpeg'],
    ['alpha-text.png', 'png'],
    ['animated.gif', 'gif'],
    ['animated.webp', 'webp'],
    ['efficient.mp4', 'mp4'],
    ['alpha.mov', 'mov'],
    ['sample.webm', 'webm'],
    ['audio-only.m4a', 'm4a'],
  ])('sniffs the %s fixture as %s', (name, format) => {
    expect(sniff(fixture(name), name).format).toBe(format);
  });

  it('sniffs content regardless of a misleading extension', () => {
    expect(sniff(fixture('jpeg-named.png'), 'jpeg-named.png').format).toBe('jpeg');
  });
});

describe('extensionMatches', () => {
  it('compares the extension with the sniffed format', () => {
    expect(extensionMatches('a/B.JPG', { kind: 'image', format: 'jpeg', mime: 'image/jpeg' })).toBe(true);
    expect(extensionMatches('a.png', { kind: 'image', format: 'jpeg', mime: 'image/jpeg' })).toBe(false);
    expect(extensionMatches('a.mp4', { kind: 'video', format: 'mov', mime: 'video/quicktime' })).toBe(true);
    expect(extensionMatches('a.webm', { kind: 'video', format: 'mp4', mime: 'video/mp4' })).toBe(false);
  });

  it('is undefined for text content and unknown extensions', () => {
    expect(extensionMatches('a.png', { kind: 'text', format: 'txt', mime: 'text/plain' })).toBeUndefined();
    expect(extensionMatches('a.xyz', { kind: 'image', format: 'png', mime: 'image/png' })).toBeUndefined();
    expect(extensionMatches('noext', { kind: 'image', format: 'png', mime: 'image/png' })).toBeUndefined();
  });
});

describe('mimeFromExtension', () => {
  it('maps known extensions and ignores unknown ones', () => {
    expect(mimeFromExtension('x/Foto.JPEG')).toBe('image/jpeg');
    expect(mimeFromExtension('clip.webm')).toBe('video/webm');
    expect(mimeFromExtension('subs.srt')).toBe('application/x-subrip');
    expect(mimeFromExtension('data.bin')).toBeUndefined();
    expect(mimeFromExtension('noext')).toBeUndefined();
  });
});
