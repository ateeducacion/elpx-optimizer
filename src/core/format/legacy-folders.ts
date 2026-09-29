/**
 * eXeLearning 3.0 stored every upload in a folder named after the iDevice
 * that received it, `content/resources/<ODE-ID>/<file>`, with ODE-IDs made
 * of a 14-digit timestamp and 6 upper-case letters or digits (see
 * docs/upstream-review.md §2 and §8). eXeLearning 4 keeps those folders as
 * user folders on import. Only folders with exactly that name pattern are
 * considered editor-generated; any other folder belongs to the user.
 */

const LEGACY_FILE = /^content\/resources\/(\d{14}[A-Z0-9]{6})\/([^/]+)$/;

/** Returns the editor folder and file name of a file stored in a v3 ODE-ID folder. */
export function legacyFolderOf(path: string): { readonly folder: string; readonly name: string } | undefined {
  const m = LEGACY_FILE.exec(path);
  return m ? { folder: m[1]!, name: m[2]! } : undefined;
}
