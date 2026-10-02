import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes, readU16 } from '../../../src/core/zip/reader.js';
import { optimizeArchive, type OptimizeOutcome } from '../../../src/core/optimize/optimize.js';
import { buildOptimizationPlan, type OptimizationPlan, type PlanOperation } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import type { Limits } from '../../../src/core/limits.js';
import { analyzeBytes, buildElpx, dec, enc, limits, media } from '../../helpers/core-kit.js';
import { FakeEngine, MemoryStore, fakePlatform } from '../../helpers/fake-platform.js';
import { inspectImage } from '../../../src/core/media/image-inspect.js';
import { APP_DEFAULTS } from '../../../src/core/plan/options.js';
import { optionsFromFlags, renderPlan } from '../../../src/cli/commands/optimize.js';
import { captureIO } from '../../helpers/cli.js';
import { CancelledError } from '../../../src/core/errors.js';
import { craftZip, type CraftEntry } from '../../helpers/zip-craft.js';

/** ODT and ODP attachments: their embedded images are recompressed in place and the package is rebuilt (issue #39). */

const R = '{{context_path}}/content/resources';
const MIME = { odt: 'application/vnd.oasis.opendocument.text', odp: 'application/vnd.oasis.opendocument.presentation' };
const CONTENT = '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>';
const PHOTO = media('photo-exif-icc.jpg');
const SMALL = media('efficient.jpg');

function manifestXml(extra = ''): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>' +
    `<manifest:file-entry manifest:full-path="Pictures/photo.jpg" manifest:media-type="image/jpeg">${extra}</manifest:file-entry>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>'
  );
}

/** A minimal OpenDocument package; `entries` replaces or extends the default ones. */
function odf(mime: string, options: { manifest?: string; extra?: CraftEntry[]; first?: CraftEntry; mimetypeExtra?: Uint8Array } = {}): Uint8Array {
  const mimetype: CraftEntry = {
    name: 'mimetype',
    data: mime,
    method: 0,
    flags: 0,
    ...(options.mimetypeExtra ? { local: { extra: options.mimetypeExtra } } : {}),
  };
  return craftZip([
    ...(options.first ? [options.first] : []),
    mimetype,
    { name: 'content.xml', data: CONTENT, method: 8 },
    { name: 'styles.xml', data: CONTENT, method: 8 },
    { name: 'Pictures/photo.jpg', data: PHOTO, method: 0 },
    ...(options.extra ?? []),
    { name: 'META-INF/manifest.xml', data: options.manifest ?? manifestXml(), method: 8 },
  ]);
}

function elpxWith(path: string, bytes: Uint8Array): Uint8Array {
  return buildElpx({ components: [{ html: `<a href="${R}/${path}">Doc</a>` }], files: { [`content/resources/${path}`]: bytes } });
}

interface OdfRun {
  analysis: Analysis;
  plan: OptimizationPlan;
  outcome: OptimizeOutcome;
  files: Map<string, Uint8Array>;
}

async function run(
  bytes: Uint8Array,
  options: OptionsInput = {},
  extra: { encode?: (input: Uint8Array) => Uint8Array; planLimits?: Limits } = {},
): Promise<OdfRun> {
  const store = new MemoryStore();
  const engine = new FakeEngine(store);
  engine.encode = (input) => Promise.resolve(extra.encode ? extra.encode(input) : SMALL);
  const analysis = await analyzeBytes(bytes, extra.planLimits ? { limits: extra.planLimits } : {});
  const plan = buildOptimizationPlan(analysis, normalizeOptions(options), await engine.info(), extra.planLimits ?? limits());
  const platform = fakePlatform({ engine, store, ...(extra.planLimits ? { limits: extra.planLimits } : {}) });
  const outcome = await optimizeArchive(new MemoryByteSource(bytes), analysis, plan, platform, { outputName: 'out.elpx' });
  const files = new Map<string, Uint8Array>();
  if (outcome.output) {
    const zip = await openZip(outcome.output, platform.limits);
    for (const e of zip.entries) files.set(e.name, await readEntryBytes(zip, e, 1 << 26));
  }
  return { analysis, plan, outcome, files };
}

const odfOps = (plan: OptimizationPlan): Extract<PlanOperation, { op: 'optimize-odf' }>[] =>
  plan.operations.filter((o): o is Extract<PlanOperation, { op: 'optimize-odf' }> => o.op === 'optimize-odf');

describe('optimizeArchive: ODT and ODP attachments', () => {
  for (const format of ['odp', 'odt'] as const) {
    it(`recompresses the images inside an ${format.toUpperCase()} and keeps the rest of the package as it was`, async () => {
      const path = `slides.${format}`;
      const original = odf(MIME[format], { mimetypeExtra: new Uint8Array([0xfe, 0xca, 0, 0]) });
      const r = await run(elpxWith(path, original));
      const [op] = odfOps(r.plan);
      expect(op).toMatchObject({ path: `content/resources/${path}`, format, embedded: [{ path: 'Pictures/photo.jpg', size: PHOTO.length }] });
      expect(r.plan.estimate.savedBytes).toBeGreaterThan(0);
      const result = r.outcome.report.operations.find((o) => o.op === 'optimize-odf')!;
      expect(result).toMatchObject({ status: 'applied', before: original.length, embedded: [{ path: 'Pictures/photo.jpg', before: PHOTO.length }] });
      expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);

      // Same path in the ELPX; inside, the same entries in the same order, only the image changed.
      const out = r.files.get(`content/resources/${path}`)!;
      expect(out.length).toBeLessThan(original.length);
      const before = await openZip(new MemoryByteSource(original), limits());
      const after = await openZip(new MemoryByteSource(out), limits());
      expect(after.entries.map((e) => e.name)).toEqual(before.entries.map((e) => e.name));
      const mimetype = after.entries[0]!;
      expect(mimetype.name).toBe('mimetype');
      expect(mimetype.method).toBe(0);
      expect(readU16(await after.source.read(mimetype.localHeaderOffset + 28, 2), 0)).toBe(0);
      expect(dec.decode(await readEntryBytes(after, mimetype, 100))).toBe(MIME[format]);
      for (const name of ['content.xml', 'styles.xml', 'META-INF/manifest.xml']) {
        expect(await readEntryBytes(after, after.byName.get(name)!, 1 << 20)).toEqual(await readEntryBytes(before, before.byName.get(name)!, 1 << 20));
      }
      // The new image, with the original's metadata carried over.
      const photo = await readEntryBytes(after, after.byName.get('Pictures/photo.jpg')!, 1 << 24);
      expect(photo.length).toBe(result.embedded![0]!.after);
      expect(photo.length).toBeLessThan(PHOTO.length);
      expect(inspectImage(photo, 'jpeg')).toMatchObject({ format: 'jpeg', hasExif: true });
    });
  }

  it('skips documents it cannot change safely, saying why', async () => {
    const cases: [string, Uint8Array, string][] = [
      ['mismatch.odt', odf(MIME.odp), 'odf-mime-mismatch'],
      ['signed.odp', odf(MIME.odp, { extra: [{ name: 'META-INF/documentsignatures.xml', data: '<x/>', method: 8 }] }), 'odf-signed'],
      ['encrypted.odp', odf(MIME.odp, { manifest: manifestXml('<manifest:encryption-data manifest:checksum="x"/>') }), 'odf-encrypted'],
      ['broken.odp', enc.encode('PK\x03\x04 not really a zip'), 'odf-invalid'],
      ['late.odp', odf(MIME.odp, { first: { name: 'content.xml', data: CONTENT, method: 8 } }), 'odf-invalid'],
      // The nested package goes through the same hostile-input ZIP checks as the project.
      ['traversal.odp', odf(MIME.odp, { extra: [{ name: '../evil.jpg', data: PHOTO }] }), 'odf-invalid'],
      [
        'nomanifest.odp',
        craftZip([
          { name: 'mimetype', data: MIME.odp, flags: 0 },
          { name: 'Pictures/a.jpg', data: PHOTO },
        ]),
        'odf-invalid',
      ],
    ];
    for (const [name, bytes, reason] of cases) {
      const r = await run(elpxWith(name, bytes));
      expect(odfOps(r.plan), name).toEqual([]);
      expect(
        r.plan.skipped.find((s) => s.path === `content/resources/${name}`),
        name,
      ).toMatchObject({ kind: 'odf', reason });
    }
  });

  it('leaves documents alone when ODF is turned off, excluded or larger than the limit', async () => {
    const bytes = elpxWith('slides.odp', odf(MIME.odp));
    const off = await run(bytes, { odf: { enabled: false } });
    expect(off.plan.skipped.find((s) => s.kind === 'odf')).toMatchObject({ reason: 'odf-disabled' });
    const excluded = await run(bytes, { exclude: ['content/resources/slides.odp'] });
    expect(excluded.plan.skipped.find((s) => s.kind === 'odf')).toMatchObject({ reason: 'excluded' });
    const big = await run(bytes, {}, { planLimits: limits({ maxOdfBytes: 100 }) });
    expect(big.plan.skipped.find((s) => s.kind === 'odf')).toMatchObject({ reason: 'exceeds-size-limit' });
    for (const r of [off, excluded, big]) expect(odfOps(r.plan)).toEqual([]);
  });

  it('keeps the original document when its images do not get smaller', async () => {
    const original = odf(MIME.odp);
    const r = await run(elpxWith('slides.odp', original), {}, { encode: (input) => input });
    expect(r.outcome.report.operations.find((o) => o.op === 'optimize-odf')).toMatchObject({ status: 'reverted' });
    expect(r.outcome.report.status).toBe('no-improvement');
    const failing = await run(
      elpxWith('slides.odp', original),
      {},
      {
        encode: () => {
          throw new Error('encoder crashed');
        },
      },
    );
    expect(failing.outcome.report.operations.find((o) => o.op === 'optimize-odf')).toMatchObject({
      status: 'reverted',
      detail: 'no embedded image was replaced (Pictures/photo.jpg: encoder crashed)',
    });
    expect(failing.outcome.report.status).toBe('no-improvement');
  });

  it('CLI: --no-odf turns it off and the dry run lists the images inside each document', async () => {
    expect(await optionsFromFlags({ 'no-odf': true }, captureIO().io)).toEqual({ ...APP_DEFAULTS, odf: { enabled: false } });
    const r = await run(elpxWith('slides.odp', odf(MIME.odp)));
    const text = renderPlan(r.plan, true);
    expect(text).toContain('optimize-odf content/resources/slides.odp');
    expect(text).toContain(': 1 embedded image');
    expect(text).toMatch(/\n {6}Pictures\/photo\.jpg \(/);
  });

  it('keeps the images that did not improve and still delivers the others', async () => {
    let calls = 0;
    const bytes = elpxWith(
      'slides.odp',
      odf(MIME.odp, {
        extra: [
          { name: 'Pictures/second.jpg', data: PHOTO },
          // Already efficient: left out of the plan.
          { name: 'Pictures/small.jpg', data: SMALL },
        ],
      }),
    );
    const r = await run(
      bytes,
      {},
      {
        encode: () => {
          if (++calls === 2) throw new Error('encoder crashed');
          return SMALL;
        },
      },
    );
    expect(odfOps(r.plan)[0]!.embedded.map((i) => i.path)).toEqual(['Pictures/photo.jpg', 'Pictures/second.jpg']);
    const result = r.outcome.report.operations.find((o) => o.op === 'optimize-odf')!;
    expect(result.status).toBe('applied');
    expect(result.embedded).toHaveLength(1);
    expect(result.detail).toMatch(/^kept as they were: Pictures\/(photo|second)\.jpg: /);
  });

  it('keeps the document when the whole package does not save enough', async () => {
    // A large incompressible entry makes the image's saving too small for the document.
    const blob = new Uint8Array(4 << 20).map((_, i) => (i * 2654435761) >>> 24);
    const r = await run(elpxWith('slides.odp', odf(MIME.odp, { extra: [{ name: 'Media/big.bin', data: blob }] })));
    expect(r.outcome.report.operations.find((o) => o.op === 'optimize-odf')).toMatchObject({
      status: 'reverted',
      detail: expect.stringMatching(/^not smaller enough/),
    });
  });

  it('plans nothing for a document without images worth recompressing or not inspected', async () => {
    const bytes = elpxWith('slides.odp', odf(MIME.odp));
    const off = await run(bytes, { images: { enabled: false } });
    expect(off.plan.skipped.find((s) => s.kind === 'odf')).toMatchObject({ reason: 'nothing-to-optimize' });
    const { odfs: _odfs, ...uninspected } = off.analysis;
    const plan = buildOptimizationPlan(uninspected, normalizeOptions({}), await new FakeEngine(new MemoryStore()).info(), limits());
    expect(plan.skipped.find((s) => s.kind === 'odf')).toMatchObject({ reason: 'odf-invalid', detail: 'The document was not inspected' });
  });

  it('stops on a cancellation inside the document and delivers nothing', async () => {
    const bytes = elpxWith('slides.odp', odf(MIME.odp));
    const r = await run(
      bytes,
      {},
      {
        encode: () => {
          throw new CancelledError();
        },
      },
    );
    expect(r.outcome.report).toMatchObject({ status: 'cancelled', error: 'Cancelled by the user; nothing was delivered' });
    expect(r.files.size).toBe(0);
  });
});
