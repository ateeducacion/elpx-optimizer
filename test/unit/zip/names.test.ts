import { describe, expect, it } from 'vitest';
import { assertSafeEntryName, basename, checkEntryName, decodeEntryName, dirname, displayName, extname } from '../../../src/core/zip/names.js';
import { ElpxError } from '../../../src/core/errors.js';

const enc = new TextEncoder();

describe('decodeEntryName', () => {
  it('decodes flagged names as strict UTF-8', () => {
    expect(decodeEntryName(enc.encode('vídeo.mp4'), true)).toEqual({ name: 'vídeo.mp4', encoding: 'utf8-flag' });
    expect(() => decodeEntryName(new Uint8Array([0x66, 0xe9]), true)).toThrow(/Invalid UTF-8 in ZIP entry name/);
  });

  it('decodes unflagged names as ASCII, guessed UTF-8 or CP437', () => {
    expect(decodeEntryName(enc.encode('a/b.txt'), false)).toEqual({ name: 'a/b.txt', encoding: 'ascii' });
    expect(decodeEntryName(enc.encode('año.png'), false)).toEqual({ name: 'año.png', encoding: 'utf8-guess' });
    expect(decodeEntryName(new Uint8Array([0x61, 0xa4, 0x6f]), false)).toEqual({ name: 'año', encoding: 'cp437' });
  });
});

describe('checkEntryName', () => {
  it.each([
    ['', 'empty name'],
    ['a\u0000b', 'control character in name'],
    ['a\u007fb', 'control character in name'],
    ['a\\b', 'backslash in name'],
    ['/abs', 'absolute path'],
    ['c:/x', 'drive letter'],
    ['Z:rel', 'drive letter'],
    ['a/b/c/d', 'path too deep'],
    ['a//b', 'empty path segment'],
    ['a/./b', 'dot segment (path traversal)'],
    ['a/../b', 'dot segment (path traversal)'],
    ['..', 'dot segment (path traversal)'],
    ['a/../', 'dot segment (path traversal)'],
  ])('rejects %j (%s)', (name, reason) => {
    expect(checkEntryName(name, 3)).toEqual({ ok: false, reason });
  });

  it.each(['a', 'a/b/c', 'a/b/c/', 'dir/', '.hidden', 'a/..b/c...', 'ab:c/d'])('accepts %j', (name) => {
    expect(checkEntryName(name, 3)).toEqual({ ok: true });
  });

  it('assertSafeEntryName throws a zip-security error with a printable name', () => {
    let error: unknown;
    try {
      assertSafeEntryName('../\u0001evil', 10);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ElpxError);
    const err = error as ElpxError;
    expect(err.code).toBe('zip-security');
    expect(err.message).toBe('Unsafe entry name "../\\x01evil": control character in name');
    expect(err.details).toEqual({ entry: '../\\x01evil', reason: 'control character in name' });
    expect(() => assertSafeEntryName('ok/name.txt', 10)).not.toThrow();
  });
});

describe('path helpers', () => {
  it('escapes control characters for display', () => {
    expect(displayName('a\u0000b\nc\u007f')).toBe('a\\x00b\\x0ac\\x7f');
    expect(displayName('plain ñ')).toBe('plain ñ');
  });

  it('splits directory and base names', () => {
    expect(dirname('a/b/c.png')).toBe('a/b');
    expect(dirname('c.png')).toBe('');
    expect(dirname('a/')).toBe('a');
    expect(basename('a/b/c.png')).toBe('c.png');
    expect(basename('c.png')).toBe('c.png');
    expect(basename('a/b/')).toBe('b');
    expect(basename('dir/')).toBe('dir');
  });

  it('returns lower-case extensions, ignoring dotfiles and folders', () => {
    expect(extname('a/B.JPG')).toBe('jpg');
    expect(extname('archive.tar.gz')).toBe('gz');
    expect(extname('noext')).toBe('');
    expect(extname('.htaccess')).toBe('');
    expect(extname('dir.d/file')).toBe('');
    expect(extname('trailing.')).toBe('');
    expect(extname('folder.v2/')).toBe('v2');
  });
});
