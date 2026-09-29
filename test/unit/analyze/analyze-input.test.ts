import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { MemoryByteSource, type ByteSource } from '../../../src/core/io/byte-source.js';
import { analyzeArchive, entryRole, safeDisplayName, videoSummary } from '../../../src/core/analyze/analyze.js';
import { CancelledError } from '../../../src/core/errors.js';
import type { CancelSignal } from '../../../src/core/cancel.js';
import type { ProgressEvent } from '../../../src/core/media/engine.js';
import { craftZip } from '../../helpers/zip-craft.js';
import { analyzeBytes, buildElpx, codes, diags, elpxFixture, enc, entry, limits, media, odeXml, upstream, zipFiles } from '../../helpers/core-kit.js';
import { FakeEngine, MemoryStore, engineInfo, fakeMp4, inputProbe } from '../../helpers/fake-platform.js';

const XML = odeXml({ components: [{ html: '<p>hola</p>' }] });

/** The single fatal diagnostic of a failed analysis. */
function fatal(a: Awaited<ReturnType<typeof analyzeBytes>>) {
  expect(a.result.ok).toBe(false);
  const list = a.result.diagnostics.filter((d) => d.severity === 'fatal');
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe('analyzeArchive: inputs that are not usable projects', () => {
  it('reports non-ZIP input with a hint about its real format', async () => {
    expect(fatal(await analyzeBytes(enc.encode('<?xml version="1.0"?><ode/>'))).message).toBe('The file is not a ZIP archive; .elpx projects are ZIP files');
    expect(fatal(await analyzeBytes(media('photo-exif-icc.jpg'))).message).toMatch(/\(it looks like JPEG\)/);
    expect(fatal(await analyzeBytes(enc.encode('%PDF-1.4 tiny'))).message).toMatch(/\(it looks like PDF\)/);
    expect(
      fatal(await analyzeBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]))).message,
    ).not.toMatch(/looks like/);
    const empty = await analyzeBytes(new Uint8Array(0));
    expect(fatal(empty).code).toBe('not-a-zip');
    expect(empty.result.input).toEqual({ name: 'test.elpx', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  });

  it('reports truncated archives, CRC errors and falsified sizes as fatal integrity problems', async () => {
    const good = buildElpx({ components: [{ html: '<p/>' }] });
    const truncated = fatal(await analyzeBytes(good.subarray(0, good.length - 30)));
    expect(truncated.code).toBe('zip-structure');
    const crc = fatal(
      await analyzeBytes(
        craftZip([
          { name: 'content.xml', data: XML },
          { name: 'content/resources/a.png', data: 'PNGDATA', central: { crc: 1 }, local: { crc: 1 } },
        ]),
      ),
    );
    expect(crc).toMatchObject({ code: 'zip-integrity', resource: 'content/resources/a.png', severity: 'fatal' });
    const payload = new Uint8Array(deflateRawSync(new Uint8Array(3_000_000)));
    const bomb = await analyzeBytes(
      craftZip([
        { name: 'content.xml', data: XML },
        { name: 'content/resources/bomb.bin', method: 8, payload, central: { usize: 1000 }, local: { usize: 1000 } },
      ]),
    );
    expect(fatal(bomb)).toMatchObject({ code: 'zip-integrity', message: expect.stringMatching(/beyond its declared size/) });
    expect(bomb.archive).toBeDefined();
  });

  it('rejects traversal names, zip bombs by ratio and entry-count limits before inflating', async () => {
    expect(
      fatal(
        await analyzeBytes(
          craftZip([
            { name: 'content.xml', data: XML },
            { name: '../../etc/cron.d/x', data: 'x' },
          ]),
        ),
      ),
    ).toMatchObject({ code: 'zip-security', resource: '../../etc/cron.d/x' });
    const zeros = zipFiles({ 'content.xml': XML, 'content/resources/z.txt': new Uint8Array(3_000_000) });
    expect(fatal(await analyzeBytes(zeros, { limits: limits({ maxCompressionRatio: 50 }) })).code).toBe('zip-limit');
    expect(fatal(await analyzeBytes(zeros, { limits: limits({ maxEntries: 1 }) })).message).toMatch(/Too many entries/);
  });

  it('maps content.xml problems to precise diagnostics', async () => {
    const cases: [Uint8Array, string, RegExp][] = [
      [zipFiles({ 'content.xml': '<ode><odeNavStructures></ode>' }), 'content-xml-invalid', /Mismatched closing tag/],
      [
        zipFiles({ 'content.xml': new Uint8Array([0x3c, 0x6f, 0x64, 0x65, 0x3e, 0xff, 0x3c, 0x2f, 0x6f, 0x64, 0x65, 0x3e]) }),
        'content-xml-invalid',
        /Invalid UTF-8 in content\.xml/,
      ],
      [zipFiles({ 'content.xml': '<!DOCTYPE ode [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><ode>&lol2;</ode>' }), 'xml-security', /entities/],
      [zipFiles({ 'content.xml': '<!DOCTYPE ode SYSTEM "http://evil.example/x.dtd"><ode>&xxe;</ode>' }), 'xml-security', /Undefined entity/],
      [zipFiles({ 'content.xml': '<instance/>' }), 'legacy-elp', /legacy eXeLearning 2\.x/],
      [zipFiles({ 'content.xml': XML }), 'zip-limit', /larger than 100 bytes/],
    ];
    for (const [bytes, code, message] of cases) {
      const a = await analyzeBytes(bytes, code === 'zip-limit' ? { limits: limits({ maxTextEntryBytes: 100 }) } : {});
      const d = fatal(a);
      expect(d.code).toBe(code);
      expect(d.message).toMatch(message);
      expect(d.location?.entry).toBe('content.xml');
    }
    const deep = fatal(
      await analyzeBytes(zipFiles({ 'content.xml': `<ode>${'<a>'.repeat(40)}${'</a>'.repeat(40)}</ode>` }), { limits: limits({ maxXmlDepth: 20 }) }),
    );
    expect(deep).toMatchObject({ code: 'xml-security', location: { entry: 'content.xml', line: 1 } });
  });

  it('refuses packages that are not .elpx projects, keeping the opened archive', async () => {
    const legacy = await analyzeBytes(upstream('old_tema-10-ejemplo.elp'));
    expect(fatal(legacy).code).toBe('legacy-elp');
    expect(legacy.archive?.entries.map((e) => e.name)).toContain('contentv3.xml');
    const html = await analyzeBytes(zipFiles({ 'index.html': '<html></html>' }));
    expect(fatal(html)).toMatchObject({ code: 'not-an-elpx', message: expect.stringMatching(/web\/SCORM export/) });
  });

  it('turns unexpected I/O errors into fatal diagnostics', async () => {
    const bytes = buildElpx({ components: [] });
    let reads = 0;
    const flaky: ByteSource = {
      size: bytes.length,
      read: (offset, length) => {
        if (++reads > 1) return Promise.reject(new Error('device not ready'));
        return Promise.resolve(bytes.subarray(offset, offset + length));
      },
    };
    const a = await analyzeArchive(flaky, { limits: limits() });
    expect(fatal(a)).toMatchObject({ code: 'zip-structure', message: 'device not ready' });
  });

  it('keeps a stable, safe display name', async () => {
    expect(safeDisplayName('/home/user/secret/curso.elpx')).toBe('curso.elpx');
    expect(safeDisplayName('C:\\Users\\me\\curso.elpx')).toBe('curso.elpx');
    expect(safeDisplayName('a\u0000b\nc.elpx')).toBe('a_b_c.elpx');
    expect(safeDisplayName('dir/')).toBe('input');
    expect(safeDisplayName('x'.repeat(300))).toHaveLength(255);
    const a = await analyzeArchive(new MemoryByteSource(buildElpx({ components: [] })), { limits: limits() });
    expect(a.result.input.name).toBe('input.elpx');
  });
});

describe('analyzeArchive: cancellation', () => {
  it('throws CancelledError at every stage instead of reporting a diagnostic', async () => {
    const bytes = buildElpx({
      components: [{ html: '<img src="{{context_path}}/content/resources/v.mp4">' }],
      files: {
        'content/resources/v.mp4': fakeMp4(4000),
        'content/resources/a.png': media('palette-efficient.png'),
        'content/resources/b.png': media('palette-efficient.png'),
      },
    });
    const store = new MemoryStore();
    const engine = new FakeEngine(store);
    let completed = 0;
    let cancelled = 0;
    for (let k = 0; k < 400; k++) {
      let checks = 0;
      // A signal that becomes aborted after k checks, so each run stops at a different point.
      const signal: CancelSignal = {
        get aborted() {
          return ++checks > k;
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      try {
        const a = await analyzeArchive(new MemoryByteSource(bytes), { limits: limits(), signal, media: { engine, store } });
        expect(a.result.ok).toBe(true);
        completed++;
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(CancelledError);
        cancelled++;
      }
    }
    expect(cancelled).toBeGreaterThan(20);
    expect(completed).toBe(1);
  });

  it('rethrows a cancellation raised by the media engine', async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine(store);
    engine.probeInput = () => {
      throw new CancelledError();
    };
    const bytes = buildElpx({ components: [], files: { 'content/resources/v.mp4': fakeMp4(4000) } });
    await expect(analyzeBytes(bytes, { media: { engine, store } })).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('analyzeArchive: real eXeLearning packages', () => {
  it('analyzes the current v4 export with its stale manifest and search index', async () => {
    const a = await analyzeBytes(upstream('un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx'));
    expect(a.result.ok).toBe(true);
    expect(a.result.package).toMatchObject({
      variant: 'v4',
      pages: 14,
      components: 13,
      hasDoctype: true,
      hasScreenshot: true,
      hasManifest: true,
      hasSearchIndex: true,
      hasPublishedHtml: true,
      exeVersion: '3.0',
    });
    expect(a.result.package?.ideviceTypes['interactive-video']).toBe(1);
    const stale = diags(a, 'manifest-stale')[0]!;
    expect(stale.message).toBe('The download manifest lists 7 absent files and omits 10 existing ones');
    // search_index.js still points to the old ODE-ID folders: resolved only by file name.
    const lenient = a.result.references.filter((r) => r.lenient);
    expect(lenient.length).toBe(16);
    expect(lenient.every((r) => r.lenient === 'basename' && r.representation === 'search-index')).toBe(true);
    const assets = a.result.entries.filter((e) => e.role === 'user-asset');
    expect(assets).toHaveLength(7);
    expect(assets.every((e) => e.usage === 'used' && e.representations.join() === 'editable,published,search-index')).toBe(true);
    expect(entry(a, 'content/resources/colegio.mp3')).toMatchObject({ kind: 'audio', format: 'mp3', extensionMatches: true });
    expect(a.manifest?.files).toContain('content/resources/20251009090601SQPBIF/00.jpg');
    expect(a.texts.has('search_index.js')).toBe(true);
  });

  it('analyzes the v3.0 source-only package with entity-escaped XML and ODE-ID folders', async () => {
    const a = await analyzeBytes(upstream('Un contenido de ejemplo para probar estilos y catalogación.elpx'), {
      inputName: 'Un contenido de ejemplo para probar estilos y catalogación.elpx',
    });
    expect(a.result.package).toMatchObject({ variant: 'v3', hasDoctype: false, hasPublishedHtml: false, pages: 14 });
    expect(a.result.input.name).toBe('Un contenido de ejemplo para probar estilos y catalogación.elpx');
    const used = a.result.entries.filter((e) => e.role === 'user-asset');
    expect(used.map((e) => e.path)).toContain('content/resources/20251009090601SQPBIF/00.jpg');
    expect(used.every((e) => e.usage === 'used' && e.representations.join() === 'editable')).toBe(true);
    // Source-only package: nothing is reported as missing from the (absent) exported pages.
    expect(diags(a, 'reference-editable-only')).toEqual([]);
    expect(codes(a)).not.toContain('opaque-bundle');
    const refs = a.result.references.filter((r) => r.target === 'content/resources/20251009090601SQPBIF/00.jpg');
    expect(refs.every((r) => r.via[0] === 'xml-text' && r.rewritable)).toBe(true);
    // A runtime stylesheet points to a file that is absent: reported, but only as a warning.
    expect(diags(a, 'missing-resource')).toEqual([expect.objectContaining({ severity: 'warning', resource: 'content/img/exe_powered_logo.png' })]);
  });

  it('accepts a v3.0 package named .elp and a web export that carries content.xml', async () => {
    const elp = await analyzeBytes(upstream('encoding_test.elp'));
    expect(elp.result.package).toMatchObject({ variant: 'v3', title: 'Prueba Á', hasPublishedHtml: true });
    const web = await analyzeBytes(upstream('download-elpx-link.zip'));
    expect(web.result.ok).toBe(true);
    const custom = web.result.entries.filter((e) => e.path.startsWith('custom/') && !e.isDirectory);
    expect(custom.length).toBeGreaterThan(0);
    expect(custom.every((e) => e.usage === 'protected' && /File Manager/.test(e.usageReasons[0]!))).toBe(true);
  });

  it('reports the missing files of the minimal upstream fixtures', async () => {
    const classify = await analyzeBytes(upstream('missing-asset-refs.elpx'));
    expect(diags(classify, 'missing-resource').length).toBe(16);
    expect(
      classify.result.references.some((r) => r.via.includes('html-attribute') && r.location.ideviceType === 'classify' && r.value.endsWith('rabbit.svg')),
    ).toBe(true);
    const stale = await analyzeBytes(upstream('stale-text-template-refs.elpx'));
    expect(diags(stale, 'missing-resource').map((d) => d.resource)).toEqual(
      expect.arrayContaining([expect.stringMatching(/imagen1\.jpg$/), expect.stringMatching(/do\.mp3$/)]),
    );
    const damaged = await analyzeBytes(upstream('damaged-trueorfalse-json.elpx'));
    expect(diags(damaged, 'json-properties-malformed')[0]).toMatchObject({
      severity: 'warning',
      location: { entry: 'content.xml', field: 'jsonProperties', ideviceType: 'trueorfalse' },
    });
    const pdf = await analyzeBytes(upstream('pdf-noext-iframe.elpx'));
    const noext = pdf.result.entries.find((e) => e.path.startsWith('content/resources/asset-'))!;
    expect(noext).toMatchObject({ usage: 'used', format: 'pdf', kind: 'document' });
    expect(noext.extensionMatches).toBeUndefined();
    // The exported pages name the file differently (upstream adds an extension from the MIME type).
    expect(diags(pdf, 'reference-editable-only').map((d) => d.resource)).toEqual([noext.path]);
  });
});

describe('analyzeArchive: media inspection', () => {
  const bytes = buildElpx({
    components: [{ html: '<video src="{{context_path}}/content/resources/v.mp4"></video><img src="{{context_path}}/content/resources/big.mp4">' }],
    files: { 'content/resources/v.mp4': fakeMp4(4000), 'content/resources/big.mp4': fakeMp4(9000), 'theme/intro.mp4': fakeMp4(100) },
  });

  it('probes user videos with the engine and summarizes them', async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine(store);
    const events: ProgressEvent[] = [];
    const a = await analyzeBytes(bytes, { media: { engine, store }, limits: limits({ maxVideoBytes: 5000 }), onProgress: (e) => events.push(e) });
    expect([...a.probes.keys()]).toEqual(['content/resources/v.mp4']);
    expect(a.result.media).toEqual({ probed: true, engine: 'native' });
    expect(entry(a, 'content/resources/v.mp4').video).toEqual({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: 10,
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      frameRate: 25,
      bitRate: 8_000_000,
      rotation: 0,
      audio: [{ codec: 'aac', channels: 2 }],
      subtitles: 0,
      chapters: 0,
      otherStreams: 0,
    });
    expect(entry(a, 'content/resources/big.mp4').video).toBeUndefined();
    expect([...store.live].every((r) => r.disposed)).toBe(true);
    expect(new Set(events.map((e) => e.stage))).toEqual(new Set(['read', 'analyze', 'probe', 'done']));
    expect(events.find((e) => e.stage === 'probe')).toMatchObject({ resource: 'content/resources/v.mp4', item: 1, items: 2 });
  });

  it('notes an unavailable engine, probe failures and the absence of an engine', async () => {
    const store = new MemoryStore();
    const off = new FakeEngine(store);
    off.infoValue = engineInfo({ video: { available: false, reason: 'ffprobe not found', encoders: [], engineClass: 'native', slowEncoders: [] } });
    const a = await analyzeBytes(bytes, { media: { engine: off, store } });
    expect(a.result.media).toEqual({ probed: false, engine: 'native', note: 'ffprobe not found' });
    expect(diags(a, 'media-engine-unavailable')[0]!.message).toBe('Videos were not inspected: ffprobe not found');
    off.infoValue = engineInfo({ video: { available: false, encoders: [], engineClass: 'browser', slowEncoders: [] } });
    expect((await analyzeBytes(bytes, { media: { engine: off, store } })).result.media.note).toBe('Video inspection unavailable');

    const failing = new FakeEngine(store);
    failing.probeInput = () => {
      throw new Error('moov atom not found');
    };
    const b = await analyzeBytes(bytes, { media: { engine: failing, store } });
    expect(diags(b, 'media-probe-failed').map((d) => [d.resource, d.message])).toEqual([
      ['content/resources/big.mp4', 'content/resources/big.mp4: moov atom not found'],
      ['content/resources/v.mp4', 'content/resources/v.mp4: moov atom not found'],
    ]);
    expect((await analyzeBytes(bytes)).result.media).toEqual({ probed: false, note: 'Videos were not inspected (no media engine)' });
    // No videos: the engine is not even asked.
    const quiet = new FakeEngine(store);
    expect((await analyzeBytes(buildElpx({ components: [] }), { media: { engine: quiet, store } })).result.media).toEqual({ probed: false });
  });

  it('classifies probed containers without a real video stream as audio', async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine(store);
    const audio = { index: 0, type: 'audio' as const, codec: 'opus', channels: 1, rotation: 0, attachedPic: false, isDefault: true, alphaMode: false };
    engine.probeInput = (r) => {
      if (r.size === 3000) return { formatName: 'matroska,webm', duration: 4, streams: [audio], chapters: 0, tags: {} };
      if (r.size === 3500)
        return {
          ...inputProbe(),
          streams: [
            { ...inputProbe().streams[0]!, attachedPic: true },
            { ...audio, index: 1, codec: 'aac' },
          ],
        };
      if (r.size === 3600) return { formatName: 'mp4', streams: [], chapters: 0, tags: {} };
      return inputProbe();
    };
    const { fakeWebm } = await import('../../helpers/fake-platform.js');
    const pkg = buildElpx({
      components: [{ html: '<audio src="{{context_path}}/content/resources/grabacion.webm"></audio>' }],
      files: {
        'content/resources/grabacion.webm': fakeWebm(3000),
        'content/resources/cancion.mp4': fakeMp4(3500),
        'content/resources/raro.mp4': fakeMp4(3600),
        'content/resources/clip.mp4': fakeMp4(4000),
      },
    });
    const a = await analyzeBytes(pkg, { media: { engine, store } });
    expect(entry(a, 'content/resources/grabacion.webm')).toMatchObject({
      kind: 'audio',
      format: 'webm',
      video: expect.objectContaining({ audio: [{ codec: 'opus', channels: 1 }] }),
    });
    expect(entry(a, 'content/resources/cancion.mp4').kind).toBe('audio');
    expect(entry(a, 'content/resources/raro.mp4').kind).toBe('video');
    expect(entry(a, 'content/resources/clip.mp4').kind).toBe('video');
    expect(a.result.totals).toMatchObject({ audioBytes: 6500, videoBytes: 7600 });
    const { buildOptimizationPlan } = await import('../../../src/core/plan/plan.js');
    const { normalizeOptions } = await import('../../../src/core/plan/options.js');
    const plan = buildOptimizationPlan(a, normalizeOptions(), engineInfo(), limits());
    expect(plan.operations.map((o) => o.id)).toEqual(['video:content/resources/clip.mp4']);
    expect(plan.skipped.map((s) => s.path)).toEqual(['content/resources/raro.mp4']);
    // Without a probe nothing can be told: the file stays a video.
    expect(entry(await analyzeBytes(pkg), 'content/resources/grabacion.webm').kind).toBe('video');
  });

  it('survives temporary files that cannot be deleted, even when cancelled', async () => {
    const store = new MemoryStore();
    store.failDispose = true;
    const engine = new FakeEngine(store);
    const a = await analyzeBytes(bytes, { media: { engine, store } });
    expect(a.probes.size).toBe(2);
    engine.probeInput = () => {
      throw new CancelledError();
    };
    await expect(analyzeBytes(bytes, { media: { engine, store } })).rejects.toBeInstanceOf(CancelledError);
  });

  it('summarizes probes with cover art, data streams and languages', () => {
    const p = inputProbe();
    const summary = videoSummary({
      ...p,
      duration: undefined,
      bitRate: undefined,
      streams: [
        { ...p.streams[0]!, attachedPic: true, index: 5 },
        { ...p.streams[0]!, frameRate: 29.97002997, rotation: 90, duration: 12.5 },
        { ...p.streams[1]!, language: 'spa' },
        { index: 3, type: 'audio', codec: 'mp3', rotation: 0, attachedPic: false, isDefault: false, alphaMode: false },
        { index: 4, type: 'subtitle', codec: 'mov_text', rotation: 0, attachedPic: false, isDefault: false, alphaMode: false },
        { index: 6, type: 'data', codec: 'bin_data', rotation: 0, attachedPic: false, isDefault: false, alphaMode: false },
        { index: 7, type: 'unknown', codec: 'x', rotation: 0, attachedPic: false, isDefault: false, alphaMode: false },
      ],
      chapters: 2,
    });
    expect(summary).toEqual({
      container: p.formatName,
      duration: 12.5,
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      frameRate: 29.97,
      rotation: 90,
      audio: [{ codec: 'aac', channels: 2, language: 'spa' }, { codec: 'mp3' }],
      subtitles: 1,
      chapters: 2,
      otherStreams: 3,
    });
    expect(videoSummary({ formatName: 'wav', streams: [], chapters: 0, tags: {} })).toEqual({
      container: 'wav',
      audio: [],
      subtitles: 0,
      chapters: 0,
      otherStreams: 0,
    });
  });

  it('inspects images, except those above the image size limit', async () => {
    const pkg = buildElpx({
      components: [],
      files: {
        'content/resources/foto.jpg': media('photo-exif-icc.jpg'),
        'content/resources/anim.gif': media('animated.gif'),
        'screenshot.png': media('palette-efficient.png'),
      },
    });
    const a = await analyzeBytes(pkg);
    expect(entry(a, 'content/resources/foto.jpg').image).toMatchObject({
      width: 320,
      orientation: 6,
      hasIcc: true,
      hasExif: true,
      hasXmp: true,
      animated: false,
      colorModel: 'rgb',
      bitDepth: 8,
      lossless: false,
    });
    expect(entry(a, 'content/resources/anim.gif').image).toMatchObject({ animated: true, hasAlpha: expect.any(Boolean) });
    expect(entry(a, 'screenshot.png')).toMatchObject({ role: 'package', usage: 'not-applicable', image: expect.objectContaining({ lossless: true }) });
    const capped = await analyzeBytes(pkg, { limits: limits({ maxImageBytes: 20_000 }) });
    expect(entry(capped, 'content/resources/foto.jpg').image).toBeUndefined();
    expect(entry(capped, 'screenshot.png').image).toBeDefined();
  });
});

describe('entryRole', () => {
  it.each([
    ['content.xml', 'package'],
    ['content.dtd', 'package'],
    ['screenshot.png', 'package'],
    ['search_index.js', 'package'],
    ['libs/elpx-manifest.js', 'package'],
    ['index.html', 'page'],
    ['html/tema-1.html', 'page'],
    ['html/sub/x.html', 'other'],
    ['theme/style.css', 'runtime'],
    ['libs/jquery.js', 'runtime'],
    ['idevices/text/text.js', 'runtime'],
    ['content/css/base.css', 'runtime'],
    ['content/img/logo.png', 'runtime'],
    ['content/resources/a.png', 'user-asset'],
    ['custom/Mi foto.png', 'user-asset'],
    ['resources/a.png', 'other'],
    ['other.png', 'other'],
  ])('%s is %s', (path, role) => {
    expect(entryRole(path)).toBe(role);
  });

  it('matches the generated fixtures', async () => {
    const a = await analyzeBytes(elpxFixture('course-video.elpx'));
    expect(entry(a, 'html/juego.html').role).toBe('page');
    expect(entry(a, 'libs/elpx-manifest.js').role).toBe('package');
  });
});
