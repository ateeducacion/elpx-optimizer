/**
 * Clean file names, in the spirit of WordPress's sanitize_title: lower case,
 * no accents, and only letters, digits and hyphens, keeping the extension.
 * Markers left by copying files are removed first ("Copia de …", "… - copia",
 * "… copy 2", "… (2)"), so "Copia de Foto Clase (2).JPG" becomes
 * "foto-clase.jpg".
 */

/** Prefixes and suffixes that operating systems add to copies (Spanish and English, Windows and macOS). */
const COPY_PREFIX = /^(?:copia\s+de|copy\s+of|kopie\s+von|copie\s+de)\s+/i;
const COPY_SUFFIX = /(?:\s*[-–—_]\s*|\s+)(?:copia|copy|kopie|copie)(?:\s*\(?\d+\)?)?$/i;
const NUMBER_SUFFIX = /\s*[([]\d+[)\]]$/;

/** Splits a file name into base and extension (an extension has 1–8 letters or digits). */
function splitExtension(name: string): { base: string; ext: string } {
  const m = /^(.*[^.])\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? { base: m[1]!, ext: m[2]!.toLowerCase() } : { base: name, ext: '' };
}

/** Removes copy markers, repeatedly ("Copia de Copia de x (2) (3)"). */
function stripCopyMarkers(base: string): string {
  let out = base.trim();
  for (;;) {
    const next = out.replace(COPY_PREFIX, '').replace(COPY_SUFFIX, '').replace(NUMBER_SUFFIX, '').trim();
    if (next === out) return out;
    out = next;
  }
}

/** Turns text into a slug: lower case ASCII letters, digits and single hyphens. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The clean version of a file name (only the name: folders are not touched). */
export function cleanFileName(name: string): string {
  const { base, ext } = splitExtension(name);
  const slug = slugify(stripCopyMarkers(base)) || slugify(base) || 'archivo';
  return ext ? `${slug}.${ext}` : slug;
}
