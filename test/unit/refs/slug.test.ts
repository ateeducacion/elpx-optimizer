import { describe, expect, it } from 'vitest';
import { cleanFileName, slugify } from '../../../src/core/refs/slug.js';

/** Clean file names: lower case ASCII letters, digits and hyphens, without copy markers. */

describe('slugify', () => {
  it.each([
    ['Foto Clase', 'foto-clase'],
    ['Canción del Ñandú', 'cancion-del-nandu'],
    ['Crème brûlée à la façon', 'creme-brulee-a-la-facon'],
    ['Straße', 'strasse'],
    ['Æsop Ærø', 'aesop-aero'],
    ['Øre ø', 'ore-o'],
    ['Łódź', 'lodz'],
    // Compatibility forms (ligatures, full-width letters) decompose to plain letters.
    ['ﬁnal Ｔema２', 'final-tema2'],
    ['  --Tema__1 . . final--  ', 'tema-1-final'],
    ['照片', ''],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe('cleanFileName', () => {
  it.each([
    // Copy markers, in Spanish, English, German and French, as prefixes or suffixes, repeated.
    ['Copia de Foto Clase (2).JPG', 'foto-clase.jpg'],
    ['Copy of report.PDF', 'report.pdf'],
    ['Kopie von Bild.png', 'bild.png'],
    ['copie de image.png', 'image.png'],
    ['foto - copia.jpg', 'foto.jpg'],
    ['foto — copia (2).jpg', 'foto.jpg'],
    ['foto copy 2.png', 'foto.png'],
    ['foto_copia(3).png', 'foto.png'],
    ['Foto [3].jpg', 'foto.jpg'],
    ['Copia de Copia de mapa (2) (3).png', 'mapa.png'],
    ['Tema 1 - Copy (4).docx', 'tema-1.docx'],
    // Only separate words are copy markers.
    ['fotocopia.jpg', 'fotocopia.jpg'],
    // Accents, spaces and case; the extension is lower-cased and kept.
    ['Año Nuevo.JPEG', 'ano-nuevo.jpeg'],
    ['archive.tar.gz', 'archive-tar.gz'],
    ['foto-clase.jpg', 'foto-clase.jpg'],
    // No extension: an extension has 1-8 letters or digits after the last dot.
    ['LEEME', 'leeme'],
    ['datos.extensionlarga', 'datos-extensionlarga'],
    ['foto.', 'foto'],
    ['.htaccess', 'htaccess'],
    // A name that is only a marker keeps its words; a name with nothing usable becomes "archivo".
    ['Copia de (2).jpg', 'copia-de-2.jpg'],
    ['照片.jpg', 'archivo.jpg'],
    ['---', 'archivo'],
  ])('%j → %j', (input, expected) => {
    expect(cleanFileName(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const name of ['Copia de Foto Clase (2).JPG', 'Año Nuevo.JPEG', '照片.jpg', 'archive.tar.gz', 'LEEME']) {
      expect(cleanFileName(cleanFileName(name))).toBe(cleanFileName(name));
    }
  });
});
