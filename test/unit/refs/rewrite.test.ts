import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { applyTextEdits, planDeduplication, retargetValue } from '../../../src/core/refs/rewrite.js';
import type { Analysis, ReferenceInternal } from '../../../src/core/analyze/model.js';
import { buildOptimizationPlan } from '../../../src/core/plan/plan.js';
import { normalizeOptions } from '../../../src/core/plan/options.js';
import { optimizeArchive } from '../../../src/core/optimize/optimize.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import { analyzeBytes, buildElpx, dec, entry, media, odeXml, page, searchIndex } from '../../helpers/core-kit.js';
import { fakePlatform } from '../../helpers/fake-platform.js';

const R = '{{context_path}}/content/resources';
const JPG = media('progressive.jpg');
const PNG = media('palette-efficient.png');

/** A minimal reference record for retargetValue. */
function ref(patch: Partial<ReferenceInternal>): ReferenceInternal {
  return {
    id: 0,
    value: '',
    form: 'context-path',
    status: 'resolved',
    kind: 'explicit',
    representation: 'editable',
    location: { entry: 'content.xml' },
    via: [],
    rewritable: true,
    ...patch,
  };
}

/** Runs analyze → plan (dedup only) → optimize with the fake platform and returns the output texts. */
async function dedupRun(bytes: Uint8Array, exclude: string[] = []) {
  const analysis = await analyzeBytes(bytes);
  const platform = fakePlatform();
  const plan = buildOptimizationPlan(
    analysis,
    normalizeOptions({ deduplicate: 'exact', exclude, images: { enabled: false } }),
    await platform.engine.info(),
    NATIVE_LIMITS,
  );
  const outcome = await optimizeArchive(new MemoryByteSource(bytes), analysis, plan, platform, { outputName: 'out.elpx' });
  const texts = new Map<string, string>();
  const names: string[] = [];
  if (outcome.output) {
    const out = await openZip(outcome.output, NATIVE_LIMITS);
    for (const e of out.entries) {
      names.push(e.name);
      if (/\.(xml|html|js|css)$/.test(e.name)) texts.set(e.name, dec.decode(await readEntryBytes(out, e, 1 << 24)));
    }
  }
  return { analysis, plan, outcome, texts, names };
}

describe('retargetValue', () => {
  it('writes placeholders for the editable representation', () => {
    expect(retargetValue(ref({ value: `${R}/old.png` }), 'content/resources/new.png')).toBe(`${R}/new.png`);
    expect(retargetValue(ref({ value: `${R}/old.png?v=2#x` }), 'content/resources/n.png')).toBe(`${R}/n.png?v=2#x`);
    expect(retargetValue(ref({ value: `${R}/o#1.png`, lenient: 'literal-special' }), 'content/resources/n.png')).toBe(`${R}/n.png`);
    expect(retargetValue(ref({ value: 'resources/old.png', form: 'resources-legacy' }), 'content/resources/sub/n.png')).toBe('resources/sub/n.png');
    expect(retargetValue(ref({ value: 'resources/old.png', form: 'resources-legacy' }), 'custom/n.png')).toBe(
      `${R.replace('/content/resources', '')}/custom/n.png`,
    );
    expect(retargetValue(ref({ value: 'content/resources/old.png', form: 'relative', representation: 'search-index' }), 'content/resources/n.png')).toBe(
      `${R}/n.png`,
    );
    expect(retargetValue(ref({ value: 'asset://x.png', form: 'asset-uri' }), 'content/resources/n.png')).toBeUndefined();
  });

  it('refuses targets that eXeLearning or HTML would read differently', () => {
    for (const target of [
      'content/resources/a b.png',
      'content/resources/a"b.png',
      'content/resources/a<b.png',
      'content/resources/a\\b.png',
      'content/resources/a&amp;b.png',
      'content/resources/a&copy.png',
    ]) {
      expect(retargetValue(ref({ value: `${R}/x.png` }), target)).toBeUndefined();
    }
    expect(retargetValue(ref({ value: `${R}/x.png` }), 'content/resources/a&b.png')).toBe(`${R}/a&b.png`);
  });

  it('computes page-relative paths for published files and keeps the escaping style', () => {
    const pub = (value: string, entryName: string) => ref({ value, form: 'relative', representation: 'published', location: { entry: entryName } });
    expect(retargetValue(pub('content/resources/old.png', 'index.html'), 'content/resources/fotos/año 1.png')).toBe('content/resources/fotos/año%201.png');
    expect(retargetValue(pub('../content/resources/old%C3%B1.png#t', 'html/p.html'), 'content/resources/año.png')).toBe('../content/resources/a%C3%B1o.png#t');
    expect(retargetValue(pub('../fondo.png', 'content/resources/css/estilo.css'), 'content/resources/img/f.png')).toBe('../img/f.png');
    expect(retargetValue(pub('x.png', 'content/resources/css/estilo.css'), 'content/resources/css/y.png')).toBe('y.png');
    expect(retargetValue(ref({ value: '/abs.png', form: 'root-relative', representation: 'published' }), 'content/resources/y.png')).toBeUndefined();
    expect(retargetValue(ref({ value: 'x.png', form: 'relative', representation: 'resource', location: {} }), 'y.png')).toBe('y.png');
  });
});

describe('deduplication with reference rewriting', () => {
  const keep = 'content/resources/fotos/foto&paisaje.jpg';
  const dup = 'content/resources/copia.jpg';
  /** HTML referencing a resource in several ways. */
  const html = (p: string) => `<p><img src="${R}/${p.slice(18)}" srcset="${R}/${p.slice(18)} 1x, ${R}/${p.slice(18)}?v=2 2x" alt="a &amp; b"></p>`;
  const game = (p: string) => `<div class="mapa-DataGame js-hidden">${JSON.stringify({ url: `${R}/${p.slice(18)}` })}</div>`;
  const components = [
    { id: 'c1', html: html(keep) + html(keep), json: { textTextarea: html(keep) } },
    { id: 'c2', html: html(dup) + game(dup), json: { textTextarea: html(dup) } },
  ];

  it('rewrites every reference layer in v4 packages and verifies the result', async () => {
    const bytes = buildElpx({
      components,
      manifest: true,
      files: {
        [keep]: JPG,
        [dup]: JPG,
        'index.html': page(`<img src="content/resources/fotos/foto&amp;paisaje.jpg"><img src="content/resources/copia.jpg">`),
        'html/p2.html': page(`<img src="../content/resources/copia.jpg#frag">`),
        'search_index.js': searchIndex({ p1: { idevices: { c1: { htmlView: html(keep) }, c2: { htmlView: html(dup) } } } }),
        'content/resources/css/estilo.css': `.a{background:url(../copia.jpg)} .b{background:url("../fotos/foto&paisaje.jpg")}`,
      },
    });
    const { plan, outcome, texts, names } = await dedupRun(bytes);
    expect(plan.operations.find((o) => o.op === 'deduplicate')).toMatchObject({ keep, remove: [dup] });
    expect(outcome.report.status).toBe('optimized');
    expect(outcome.report.validations.every((v) => v.ok)).toBe(true);
    expect(names).not.toContain(dup);
    const xml = texts.get('content.xml')!;
    expect(xml).not.toContain('copia.jpg');
    expect(xml.split(`${R}/fotos/foto&paisaje.jpg`).length - 1).toBe(4 * 3 + 1 + 3);
    expect(xml).toContain(`${R}/fotos/foto&paisaje.jpg?v=2 2x`);
    expect(xml).toContain(`{"url":"${R}/fotos/foto&paisaje.jpg"}`);
    expect(xml).toContain(`<img src=\\"${R}/fotos/foto&paisaje.jpg\\"`);
    expect(texts.get('index.html')).toContain('<img src="content/resources/fotos/foto&paisaje.jpg">');
    expect(texts.get('html/p2.html')).toContain('<img src="../content/resources/fotos/foto&paisaje.jpg#frag">');
    expect(texts.get('search_index.js')).toContain(`src=\\"${R}/fotos/foto&paisaje.jpg\\"`);
    expect(texts.get('content/resources/css/estilo.css')).toBe(`.a{background:url(../fotos/foto&paisaje.jpg)} .b{background:url("../fotos/foto&paisaje.jpg")}`);
    expect(
      JSON.parse(
        texts
          .get('libs/elpx-manifest.js')!
          .replace(/^[\s\S]*?=/, '')
          .replace(/;\s*$/, ''),
      ).files,
    ).not.toContain(dup);
    // Everything else is byte-identical, and the result analyzes cleanly.
    const after = await analyzeBytes(outcome.output ? new Uint8Array(await outcome.output.read(0, outcome.output.size)) : new Uint8Array());
    expect(entry(after, keep).references).toBe(entry(await analyzeBytes(bytes), keep).references + entry(await analyzeBytes(bytes), dup).references);
    // The raw "&" written into content.xml resolves exactly (eXeLearning matches placeholders literally).
    const editable = after.result.references.filter((r) => r.representation === 'editable' && r.value.includes('foto&paisaje.jpg'));
    expect(editable.length).toBe(16);
    expect(editable.every((r) => r.status === 'resolved' && r.target === keep && r.lenient === undefined)).toBe(true);
  });

  it('rewrites references inside raw HTML embedded in a plain-JSON DataGame, keeping JSON escaping', async () => {
    const game = `<div class="relate-DataGame js-hidden">${JSON.stringify({ instructions: `<p style="color:red"><img src="${R}/b.png"></p>` })}</div>`;
    const bytes = buildElpx({
      components: [{ html: `<img src="${R}/a.png"><img src="${R}/a.png">` }, { type: 'relate', html: game }],
      files: { 'content/resources/a.png': PNG, 'content/resources/b.png': PNG },
    });
    const { analysis, outcome, texts, names } = await dedupRun(bytes);
    expect(analysis.result.diagnostics.filter((d) => d.code === 'missing-resource')).toEqual([]);
    expect(outcome.report.status).toBe('optimized');
    expect(names).not.toContain('content/resources/b.png');
    const xml = texts.get('content.xml')!;
    expect(xml).toContain(`<p style=\\"color:red\\"><img src=\\"${R}/a.png\\"></p>`);
    expect(xml).not.toContain('b.png');
  });

  it('rewrites entity-escaped v3.0 content with XML escaping', async () => {
    const bytes = buildElpx({ variant: 'v3', components, files: { [keep]: JPG, [dup]: JPG } });
    const { outcome, texts } = await dedupRun(bytes);
    expect(outcome.report.status).toBe('optimized');
    const xml = texts.get('content.xml')!;
    expect(xml).not.toContain('copia.jpg');
    expect(xml).toContain(`src="${R}/fotos/foto&amp;paisaje.jpg"`);
    expect(xml).toContain('alt="a &amp;amp; b"');
    expect(outcome.report.validations.find((v) => v.name === 'content-xml-well-formed-after-rewrite')?.ok).toBe(true);
  });

  it('keeps duplicates whose references cannot be safely rewritten', async () => {
    const splitChunks = '&lt;img src="{{context_path}}/content/resources/l<![CDATA[2.png">]]>';
    const xml = odeXml({
      components: [
        { html: `<img src="${R}/a1.png"><script>var a = "content/resources/a2.png";</script>` },
        { html: `<img src="${R}/b1.png"><img src="${R}/B2.PNG">` },
        { html: `<img src="${R}/c1.png"><img src="${R}/c1.png"><img src="${R}/c2.png"><img src="${R}/C2.PNG">` },
        { html: `<img src="${R}/d1.png"><script type="text/template"><img src="${R}/d2.png"></script>` },
        { html: `<img src="${R}/e1.png"><iframe src="${R}/bundle/index.html"></iframe>` },
        { html: `<img src="${R}/f1.png"><img src="${R}/f2.png">` },
        { html: `<img src="${R}/g1.png"><img src="${R}/g1.png"><img src="${R}/g2.png">` },
        { html: `<img src="${R}/h con espacio.png"><img src="${R}/h con espacio.png"><img src="${R}/h2.png">` },
        { html: `<img src="${R}/k2.png">` },
        { html: `<img src="${R}/l1.png"><img src="${R}/l1.png">SPLIT` },
      ],
    }).replace('SPLIT]]>', `]]>${splitChunks}`);
    // Each group gets distinct PNG bytes so groups never merge.
    const png = (n: number): Uint8Array => {
      const out = new Uint8Array(PNG.length + n);
      out.set(PNG);
      out.fill(n, PNG.length);
      return out;
    };
    const bytes = buildElpx({
      contentXml: xml,
      files: {
        'index.html': page('<img src="content/resources/k%231.png"><img src="content/resources/k%231.png">'),
        'content/resources/a1.png': png(1),
        'content/resources/a2.png': png(1),
        'content/resources/b1.png': png(2),
        'content/resources/b2.png': png(2),
        'content/resources/c1.png': png(3),
        'content/resources/c2.png': png(3),
        'content/resources/d1.png': png(4),
        'content/resources/d2.png': png(4),
        'content/resources/e1.png': png(5),
        'content/resources/bundle/e2.png': png(5),
        'content/resources/bundle/index.html': page('<p>applet</p>'),
        'content/resources/f1.png': JPG,
        'content/resources/f2.png': JPG,
        'content/resources/g1.png': png(6),
        'content/resources/g2.png': png(6),
        'content/resources/h con espacio.png': png(7),
        'content/resources/h2.png': png(7),
        'content/resources/k2.png': png(8),
        'content/resources/k#1.png': png(8),
        'content/resources/l1.png': png(9),
        'content/resources/l2.png': png(9),
      },
    });
    const analysis = await analyzeBytes(bytes);
    expect(analysis.result.ok).toBe(true);
    const plan = planDeduplication(analysis, new Set(['content/resources/g2.png']), new Set());
    const reasons = Object.fromEntries(plan.decisions.flatMap((d) => d.skipped.map((s) => [s.path, s.reason])));
    expect(reasons).toEqual({
      'content/resources/a2.png': 'uncertain references: possible reference in script or obfuscated data',
      'content/resources/b2.png': 'uncertain references: lenient match (case)',
      'content/resources/c2.png': 'also matched by lenient or dynamic references: lenient match (case)',
      'content/resources/d2.png': 'reference in xml-cdata › html-text cannot be rewritten',
      'content/resources/bundle/e2.png': 'protected: inside content/resources/bundle/, which contains HTML or scripts',
      'content/resources/f2.png': 'content does not match the extension',
      'content/resources/g2.png': 'excluded by the user',
      'content/resources/h2.png': 'reference in content.xml cannot be expressed for content/resources/h con espacio.png',
      'content/resources/k2.png': 'rewritten reference would not resolve exactly to content/resources/k#1.png',
      'content/resources/l2.png': 'reference in content.xml cannot be rewritten in its encoding',
    });
    expect(plan.decisions.every((d) => d.remove.length === 0)).toBe(true);
    expect(plan.edits.size).toBe(0);
  });

  it('checks every reference to a duplicate defensively', async () => {
    const bytes = buildElpx({
      components: [{ html: `<img src="${R}/a.png"><img src="${R}/a.png"><img src="${R}/b.png">` }],
      files: { 'content/resources/a.png': PNG, 'content/resources/b.png': PNG, 'content/resources/c.png': PNG },
    });
    const base = await analyzeBytes(bytes);
    const clean = planDeduplication(base, new Set(), new Set());
    expect(clean.decisions).toEqual([
      {
        keep: 'content/resources/a.png',
        remove: ['content/resources/b.png', 'content/resources/c.png'],
        skipped: [],
        rewritten: { 'content/resources/b.png': 1, 'content/resources/c.png': 0 },
      },
    ]);
    expect(clean.edits.get('content.xml')).toHaveLength(1);
    // Already removed files leave too few members.
    expect(planDeduplication(base, new Set(), new Set(['content/resources/a.png', 'content/resources/b.png'])).decisions).toEqual([]);
    const bRef = base.references.find((r) => r.target === 'content/resources/b.png')!;
    const variant = (patch: Partial<ReferenceInternal>, entries = base.result.entries): Analysis => ({
      ...base,
      result: { ...base.result, entries },
      references: base.references.map((r) => (r === bRef ? { ...r, ...patch } : r)),
    });
    const reasonFor = (a: Analysis) =>
      planDeduplication(a, new Set(), new Set()).decisions[0]!.skipped.find((s) => s.path === 'content/resources/b.png')?.reason;
    expect(reasonFor(variant({ kind: 'dynamic' }))).toBe('referenced from code or obfuscated data');
    expect(reasonFor(variant({ lenient: 'case' }))).toBe('reference matches only by case');
    expect(reasonFor(variant({ status: 'ambiguous' }))).toBe('referenced ambiguously');
    expect(
      reasonFor(
        variant(
          {},
          base.result.entries.filter((e) => e.path !== 'content/resources/b.png'),
        ),
      ),
    ).toBe('not in the inventory');
    const { site: _site, ...noSite } = bRef;
    expect(reasonFor({ ...base, references: base.references.map((r) => (r === bRef ? noSite : r)) })).toBe(
      'reference in content.xml cannot be rewritten in its encoding',
    );
    expect(reasonFor(variant({ location: {}, site: { ...bRef.site!, lift: () => undefined } }))).toBe('reference in ? cannot be rewritten in its encoding');
    expect(reasonFor(variant({ form: 'asset-uri', location: {} }))).toBe('reference in ? cannot be expressed for content/resources/a.png');
    // Keep ordering: most references, then the shorter path, then lexical order.
    const tie = await analyzeBytes(
      buildElpx({ components: [], files: { 'content/resources/zz.png': PNG, 'content/resources/yy.png': PNG, 'content/resources/long.png': PNG } }),
    );
    expect(planDeduplication(tie, new Set(), new Set()).decisions[0]!.keep).toBe('content/resources/yy.png');
  });
});

describe('applyTextEdits', () => {
  it('applies edits per entry and refuses unknown entries', () => {
    const texts = new Map([['a.html', { text: 'abcdef' }]]);
    expect(
      applyTextEdits(
        texts,
        new Map([
          [
            'a.html',
            [
              { start: 1, end: 3, text: 'XY' },
              { start: 4, end: 5, text: '' },
            ],
          ],
        ]),
      ),
    ).toEqual(new Map([['a.html', 'aXYdf']]));
    expect(() => applyTextEdits(texts, new Map([['b.html', [{ start: 0, end: 0, text: 'x' }]]]))).toThrow(/No text for b\.html/);
  });
});
