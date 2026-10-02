import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip } from '../../../src/core/zip/reader.js';
import { CancelledError } from '../../../src/core/errors.js';
import { ODF_MIME, inspectOdf, rebuildOdf, validateOdfCandidate } from '../../../src/core/media/odf-policy.js';
import { limits, media } from '../../helpers/core-kit.js';
import { craftZip, type CraftEntry } from '../../helpers/zip-craft.js';

/** The OpenDocument package checks on their own: inspection and validation of a rebuilt package. */

const MANIFEST = '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>';
const PHOTO = media('photo-exif-icc.jpg');
const SMALL = media('efficient.jpg');

function pkg(entries: CraftEntry[] = [], mimetype: CraftEntry = { name: 'mimetype', data: ODF_MIME.odp, flags: 0 }): Uint8Array {
  return craftZip([
    mimetype,
    { name: 'content.xml', data: '<a/>', method: 8 },
    { name: 'Pictures/photo.jpg', data: PHOTO },
    ...entries,
    { name: 'META-INF/manifest.xml', data: MANIFEST, method: 8 },
  ]);
}

const open = (bytes: Uint8Array) => openZip(new MemoryByteSource(bytes), limits());

describe('inspectOdf', () => {
  it('lists only real JPEG, PNG and WebP images', async () => {
    const info = await inspectOdf(pkg([{ name: 'Pictures/fake.png', data: 'not an image' }]), 'odp', limits());
    expect(info).toMatchObject({
      ok: true,
      format: 'odp',
      images: [{ path: 'Pictures/photo.jpg', size: PHOTO.length, format: 'jpeg', extensionMatches: true }],
    });
  });

  it('rejects a deflated or empty mimetype and a manifest that is not one', async () => {
    const deflated = await inspectOdf(pkg([], { name: 'mimetype', data: ODF_MIME.odp, method: 8, flags: 0 }), 'odp', limits());
    expect(deflated).toMatchObject({ ok: false, reason: 'odf-invalid' });
    const empty = await inspectOdf(pkg([], { name: 'mimetype', data: '', flags: 0 }), 'odp', limits());
    expect(empty).toMatchObject({ ok: false, reason: 'odf-mime-mismatch', detail: 'A .odp file whose package says nothing' });
    const wrongRoot = craftZip([
      { name: 'mimetype', data: ODF_MIME.odt, flags: 0 },
      { name: 'META-INF/manifest.xml', data: '<other/>' },
    ]);
    expect(await inspectOdf(wrongRoot, 'odt', limits())).toMatchObject({
      ok: false,
      reason: 'odf-invalid',
      detail: 'META-INF/manifest.xml is not an OpenDocument manifest',
    });
  });

  it('lets a cancellation through instead of calling the document invalid', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(inspectOdf(pkg(), 'odp', limits(), controller.signal)).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('validateOdfCandidate', () => {
  it('accepts a rebuild that only replaced the image', async () => {
    const zip = await open(pkg());
    const replaced = new Map([['Pictures/photo.jpg', SMALL]]);
    expect(await validateOdfCandidate(zip, await rebuildOdf(zip, replaced), replaced, 'odp', limits())).toEqual([]);
  });

  it('names every difference from the original', async () => {
    const zip = await open(pkg());
    const replaced = new Map([['Pictures/photo.jpg', SMALL]]);
    // Another entry changed, an entry added, and the image not the one given.
    const changed = craftZip([
      { name: 'mimetype', data: ODF_MIME.odp, flags: 0, local: { extra: new Uint8Array([0xfe, 0xca, 0, 0]) } },
      { name: 'content.xml', data: '<b/>', method: 8 },
      { name: 'Pictures/photo.jpg', data: PHOTO },
      { name: 'Pictures/new.jpg', data: SMALL },
      { name: 'META-INF/manifest.xml', data: MANIFEST, method: 8 },
    ]);
    expect(await validateOdfCandidate(zip, changed, replaced, 'odp', limits())).toEqual([
      'the mimetype entry has an extra field',
      'the entries differ from the original',
      'content.xml changed',
      'Pictures/photo.jpg does not hold the new image',
      'Pictures/new.jpg changed',
    ]);
  });

  it('rejects a rebuild that is no longer a valid package', async () => {
    const zip = await open(pkg());
    const broken = craftZip([{ name: 'content.xml', data: '<a/>' }]);
    expect(await validateOdfCandidate(zip, broken, new Map(), 'odp', limits())).toEqual(['The mimetype entry is not the first one, stored uncompressed']);
  });
});
