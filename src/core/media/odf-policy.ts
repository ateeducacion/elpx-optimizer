import { CancelledError, ElpxError, errorMessage } from '../errors.js';
import type { CancelSignal } from '../cancel.js';
import type { Limits } from '../limits.js';
import { MemoryByteSource } from '../io/byte-source.js';
import { MemoryByteSink } from '../io/byte-sink.js';
import { bytesEqual, utf8DecodeStrict } from '../io/text.js';
import { openZip, readEntryBytes, readU16, type ZipArchive } from '../zip/reader.js';
import { ZipWriter, metaFromEntry } from '../zip/writer.js';
import { METHOD_STORED } from '../zip/constants.js';
import { localName, parseXml, type XmlElement } from '../parse/xml.js';
import { inspectImage, type ImageInfo } from './image-inspect.js';
import { SNIFF_BYTES, extensionMatches, sniff } from './sniff.js';

/**
 * OpenDocument text and presentations attached to a project (issue #39): their
 * embedded JPEG, PNG and WebP images are recompressed in place, with the same
 * names and formats, so no XML inside the document changes. The package is
 * rebuilt entry by entry (everything else copied byte for byte) and checked
 * before it replaces the attachment. Documents inside the document are never
 * opened (depth 1).
 */

export type OdfFormat = 'odt' | 'odp';

export const ODF_MIME: Readonly<Record<OdfFormat, string>> = Object.freeze({
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
});

export const ODF_FORMATS: ReadonlySet<string> = new Set(Object.keys(ODF_MIME));

export type OdfSkipReason =
  'odf-disabled' | 'odf-invalid' | 'odf-mime-mismatch' | 'odf-signed' | 'odf-encrypted' | 'exceeds-size-limit' | 'nothing-to-optimize';

export interface OdfImage {
  /** Path inside the document, e.g. Pictures/photo.jpg. */
  readonly path: string;
  readonly size: number;
  readonly format: string;
  readonly extensionMatches: boolean | undefined;
  readonly info: ImageInfo;
}

export type OdfInfo =
  | { readonly ok: true; readonly format: OdfFormat; readonly images: readonly OdfImage[] }
  | { readonly ok: false; readonly reason: OdfSkipReason; readonly detail: string };

const MANIFEST = 'META-INF/manifest.xml';
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MANIFEST_MAX = 4 * 1024 * 1024;

/** Opens an attachment as an OpenDocument package and lists the images that could be recompressed. */
export async function inspectOdf(bytes: Uint8Array, format: OdfFormat, limits: Limits, signal?: CancelSignal): Promise<OdfInfo> {
  try {
    const zip = await openZip(new MemoryByteSource(bytes), limits, signal);
    const problem = await packageProblem(zip, format, limits, signal);
    if (problem) return { ok: false, ...problem };
    const images: OdfImage[] = [];
    for (const e of zip.entries) {
      if (e.isDirectory || e.uncompressedSize > limits.maxImageBytes || !/\.(jpe?g|png|webp)$/i.test(e.name)) continue;
      const data = await readEntryBytes(zip, e, limits.maxImageBytes, signal ? { signal } : {});
      const sniffed = sniff(data.subarray(0, SNIFF_BYTES), e.name);
      if (sniffed.kind !== 'image' || !IMAGE_FORMATS.has(sniffed.format)) continue;
      images.push({
        path: e.name,
        size: e.uncompressedSize,
        format: sniffed.format,
        extensionMatches: extensionMatches(e.name, sniffed),
        info: inspectImage(data, sniffed.format),
      });
    }
    return { ok: true, format, images };
  } catch (error) {
    if (error instanceof CancelledError || (error instanceof ElpxError && error.code === 'cancelled')) throw error;
    return { ok: false, reason: 'odf-invalid', detail: `Not a readable OpenDocument package: ${errorMessage(error)}` };
  }
}

/** Why a package cannot be changed safely, if it cannot. */
async function packageProblem(
  zip: ZipArchive,
  format: OdfFormat,
  limits: Limits,
  signal: CancelSignal | undefined,
): Promise<{ reason: OdfSkipReason; detail: string } | undefined> {
  const first = zip.entries[0];
  if (first?.name !== 'mimetype' || first.method !== METHOD_STORED) {
    return { reason: 'odf-invalid', detail: 'The mimetype entry is not the first one, stored uncompressed' };
  }
  const mime = utf8DecodeStrict(await readEntryBytes(zip, first, 256, signal ? { signal } : {}), 'mimetype');
  if (mime !== ODF_MIME[format]) return { reason: 'odf-mime-mismatch', detail: `A .${format} file whose package says ${mime || 'nothing'}` };
  // ODF 1.2+: signatures are META-INF files whose names contain "signatures".
  if (zip.entries.some((e) => /^META-INF\/[^/]*signatures[^/]*$/i.test(e.name))) {
    return { reason: 'odf-signed', detail: 'The document is digitally signed; changing its images would invalidate the signature' };
  }
  const manifest = zip.byName.get(MANIFEST);
  if (!manifest) return { reason: 'odf-invalid', detail: `No ${MANIFEST}` };
  const root = parseXml(utf8DecodeStrict(await readEntryBytes(zip, manifest, MANIFEST_MAX, signal ? { signal } : {}), MANIFEST), {
    maxDepth: limits.maxXmlDepth,
  }).root;
  if (localName(root.name) !== 'manifest') return { reason: 'odf-invalid', detail: `${MANIFEST} is not an OpenDocument manifest` };
  if (hasElement(root, 'encryption-data')) return { reason: 'odf-encrypted', detail: 'The document is encrypted' };
  return undefined;
}

function hasElement(el: XmlElement, name: string): boolean {
  return el.children.some((c) => c.kind === 'element' && (localName(c.name) === name || hasElement(c, name)));
}

/** Writes the package again with some entries replaced; every other entry is copied as stored, in the same order. */
export async function rebuildOdf(zip: ZipArchive, replacements: ReadonlyMap<string, Uint8Array>, signal?: CancelSignal): Promise<Uint8Array> {
  const sink = new MemoryByteSink();
  const writer = new ZipWriter(sink, signal ? { signal } : {});
  for (const e of zip.entries) {
    const data = replacements.get(e.name);
    if (data) await writer.addBytes(metaFromEntry(e), data, e.method);
    else await writer.copyEntry(zip, e);
  }
  await writer.finish();
  return sink.toBytes();
}

/** Checks a rebuilt package against the original: still a valid package, same entries, only the replaced ones changed. */
export async function validateOdfCandidate(
  original: ZipArchive,
  candidate: Uint8Array,
  replacements: ReadonlyMap<string, Uint8Array>,
  format: OdfFormat,
  limits: Limits,
  signal?: CancelSignal,
): Promise<string[]> {
  const zip = await openZip(new MemoryByteSource(candidate), limits, signal);
  const problem = await packageProblem(zip, format, limits, signal);
  if (problem) return [problem.detail];
  const problems: string[] = [];
  // ODF: the mimetype entry has no extra field, so its value sits at a fixed offset.
  if (readU16(await zip.source.read(zip.entries[0]!.localHeaderOffset + 28, 2), 0) !== 0) problems.push('the mimetype entry has an extra field');
  if (zip.entries.map((e) => e.name).join('\n') !== original.entries.map((e) => e.name).join('\n')) problems.push('the entries differ from the original');
  for (const e of zip.entries) {
    const data = replacements.get(e.name);
    const before = original.byName.get(e.name);
    if (data) {
      if (!bytesEqual(await readEntryBytes(zip, e, limits.maxImageBytes, signal ? { signal } : {}), data))
        problems.push(`${e.name} does not hold the new image`);
    } else if (!before || before.crc32 !== e.crc32 || before.uncompressedSize !== e.uncompressedSize || before.method !== e.method) {
      problems.push(`${e.name} changed`);
    }
  }
  return problems;
}
