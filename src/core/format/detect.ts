import type { ZipArchive } from '../zip/reader.js';

/**
 * Package classification from the archive contents (never the extension),
 * following the upstream importer's detection order where it applies.
 */

export type PackageVariant = 'v4' | 'v3';

export type Detection =
  | { readonly kind: 'elpx'; readonly contentXml: string }
  | { readonly kind: 'legacy-elp'; readonly reason: string }
  | { readonly kind: 'wrapped'; readonly reason: string }
  | { readonly kind: 'nested'; readonly reason: string }
  | { readonly kind: 'epub'; readonly reason: string }
  | { readonly kind: 'html-export'; readonly reason: string }
  | { readonly kind: 'unknown-zip'; readonly reason: string };

/** Classifies an opened ZIP archive. */
export function detectPackage(archive: ZipArchive): Detection {
  const names = archive.entries.filter((e) => !e.isDirectory).map((e) => e.name);
  const has = (n: string): boolean => archive.byName.has(n);
  if (has('content.xml')) return { kind: 'elpx', contentXml: 'content.xml' };
  if (has('contentv3.xml') || has('content.data')) {
    return {
      kind: 'legacy-elp',
      reason:
        'This is a legacy eXeLearning (2.x or older) .elp project (contentv3.xml/content.data). Open it in eXeLearning and save it as .elpx, then optimize the .elpx.',
    };
  }
  if (has('EPUB/content.xml')) {
    return { kind: 'epub', reason: 'This is an EPUB export. Import it in eXeLearning and export it as .elpx first.' };
  }
  const nested = names.filter((n) => !n.includes('/') && /\.(elpx?|zip)$/i.test(n));
  if (nested.length > 0 && names.length <= 3) {
    return { kind: 'nested', reason: `The archive contains another package (${nested[0]}). Extract it and optimize that file instead.` };
  }
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size === 1 && names.every((n) => n.includes('/'))) {
    const top = [...tops][0]!;
    if (archive.byName.has(`${top}/content.xml`)) {
      return { kind: 'wrapped', reason: `The project is inside a folder ("${top}/"). Re-create the ZIP from the folder contents.` };
    }
  }
  if (has('index.html') || has('imsmanifest.xml')) {
    return {
      kind: 'html-export',
      reason: 'This is a web/SCORM export without editable source (content.xml). Only .elpx projects are supported.',
    };
  }
  return { kind: 'unknown-zip', reason: 'The ZIP archive does not contain content.xml; it is not an eXeLearning project.' };
}

/** Returns true for the ODE-ID folder naming used by eXeLearning 3.0 (e.g. 20251009090601SQPBIF). */
export function isOdeIdFolder(segment: string): boolean {
  return /^[0-9]{14}[A-Z0-9]{6}$/.test(segment);
}
