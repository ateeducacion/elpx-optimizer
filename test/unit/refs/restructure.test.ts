import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { planRestructure, type RestructureOptions, type RestructurePlan } from '../../../src/core/refs/restructure.js';
import type { Analysis, ReferenceInternal } from '../../../src/core/analyze/model.js';
import { buildOptimizationPlan, type OptimizationPlan, type PlanOperation } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import { optimizeArchive, type OptimizeOutcome } from '../../../src/core/optimize/optimize.js';
import { parseManifest } from '../../../src/core/format/manifest.js';
import { encryptDataGame } from '../../../src/core/format/datagame.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import { analyzeBytes, buildElpx, codes, dec, elpxFixture, entry, media, odeXml, page, searchIndex } from '../../helpers/core-kit.js';
import { craftZip } from '../../helpers/zip-craft.js';
import { FakeEngine, MemoryStore, fakePlatform } from '../../helpers/fake-platform.js';

/** Flattening of eXeLearning 3 editor folders and removal of references to missing files: planning and execution. */

const CP = '{{context_path}}';
const R = `${CP}/content/resources`;
const PNG = media('palette-efficient.png');
const JPG = media('progressive.jpg');
/** An eXeLearning 3 editor folder name (ODE-ID). */
const ode = (tail: string): string => `20240101120000${tail}`;
const [A, B, C, D, E] = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE'].map(ode) as [string, string, string, string, string];
const ODE_ID = /\d{14}[A-Z0-9]{6}/;

/** PNG bytes made distinct by trailing padding (still a valid PNG). */
function png(n: number): Uint8Array {
  const out = new Uint8Array(PNG.length + n);
  out.set(PNG);
  out.fill(n, PNG.length);
  return out;
}

/** Plans with every feature off unless patched. */
function restructure(analysis: Analysis, patch: Partial<RestructureOptions> = {}): RestructurePlan {
  return planRestructure(analysis, { deduplicate: false, flatten: false, removeMissing: false, excluded: new Set(), removed: new Set(), ...patch });
}

/** Skip reasons by path (several reasons for one path are joined). */
function reasons(plan: RestructurePlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of plan.skipped) out[s.path] = out[s.path] ? `${out[s.path]} | ${s.reason}` : s.reason;
  return out;
}

/** Operations of one kind. */
function ops<K extends PlanOperation['op']>(plan: OptimizationPlan, op: K): Extract<PlanOperation, { op: K }>[] {
  return plan.operations.filter((o): o is Extract<PlanOperation, { op: K }> => o.op === op);
}

interface Run {
  analysis: Analysis;
  plan: OptimizationPlan;
  outcome: OptimizeOutcome;
  /** Entry names of the delivered archive, in order. */
  names: string[];
  /** Text entries of the delivered archive. */
  texts: Map<string, string>;
  /** UTF-8 flag of every delivered entry. */
  utf8: Map<string, boolean>;
  output: Uint8Array;
  /** Re-analysis of the delivered archive. */
  after: Analysis;
}

/** Analyzes, plans (media off unless configured) and optimizes with the fake platform. */
async function run(
  bytes: Uint8Array,
  options: OptionsInput,
  platformOptions: { tamper?: (b: Uint8Array) => Uint8Array; engine?: FakeEngine } = {},
): Promise<Run> {
  const analysis = await analyzeBytes(bytes);
  const platform = fakePlatform(platformOptions);
  const plan = buildOptimizationPlan(
    analysis,
    normalizeOptions({ images: { enabled: false }, video: { enabled: false }, ...options }),
    await platform.engine.info(),
    NATIVE_LIMITS,
  );
  const outcome = await optimizeArchive(new MemoryByteSource(bytes), analysis, plan, platform, { outputName: 'out.elpx' });
  const output = new Uint8Array(await outcome.output!.read(0, outcome.output!.size));
  const zip = await openZip(new MemoryByteSource(output), NATIVE_LIMITS);
  const names: string[] = [];
  const texts = new Map<string, string>();
  const utf8 = new Map<string, boolean>();
  for (const e of zip.entries) {
    names.push(e.name);
    utf8.set(e.name, (e.flags & 0x0800) !== 0);
    if (/\.(xml|html|js|css|svg)$/.test(e.name)) texts.set(e.name, dec.decode(await readEntryBytes(zip, e, 1 << 24)));
  }
  return { analysis, plan, outcome, names, texts, utf8, output, after: await analyzeBytes(output) };
}

/** Asserts a run delivered a verified, optimized package. */
function expectVerified(r: Run): void {
  expect(r.outcome.report.status).toBe('optimized');
  expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
  expect(r.after.result.ok).toBe(true);
}

/** Files listed by the delivered manifest. */
function manifestFiles(r: Run): readonly string[] {
  const m = parseManifest(r.texts.get('libs/elpx-manifest.js')!);
  if ('error' in m) throw new Error(m.error);
  return m.files;
}

describe('flatten: eXeLearning 3 editor folders (legacy-folders.elpx)', () => {
  it('moves, merges and renames the files and rewrites every representation', async () => {
    const r = await run(elpxFixture('legacy-folders.elpx'), { flatten: 'legacy' });
    expect(ops(r.plan, 'move-resource').map((o) => [o.path, o.to, o.references])).toEqual([
      [`content/resources/${A}/ficha.pdf`, 'content/resources/ficha.pdf', 5],
      [`content/resources/${A}/foto.jpg`, 'content/resources/foto.jpg', 5],
      // A different foto.jpg already took the name.
      [`content/resources/${B}/foto.jpg`, 'content/resources/foto_2.jpg', 5],
      [`content/resources/${B}/logo.png`, 'content/resources/logo.png', 5],
      // content/resources/nota.png exists with other content.
      [`content/resources/${E}/nota.png`, 'content/resources/nota_2.png', 5],
    ]);
    // Identical same-name copies merge (reported as deduplication): into the copy that moves, or into the flat file.
    expect(ops(r.plan, 'deduplicate').map((o) => [o.keep, o.remove, o.references])).toEqual([
      [`content/resources/${B}/logo.png`, [`content/resources/${C}/logo.png`], 3],
      ['content/resources/portada.png', [`content/resources/${D}/portada.png`], 5],
    ]);
    expect(r.plan.skipped.filter((s) => s.kind === 'flatten' || s.kind === 'duplicate')).toEqual([]);
    expect(ops(r.plan, 'rewrite-references').map((o) => [o.path, o.edits, o.reason])).toEqual([
      ['content.xml', 13, 'references to moved files; references to removed duplicates'],
      ['index.html', 7, 'references to moved files; references to removed duplicates'],
      ['search_index.js', 13, 'references to moved files; references to removed duplicates'],
    ]);
    expect(ops(r.plan, 'update-manifest')).toHaveLength(1);
    expect(r.plan.risks).toContain('Files in eXeLearning 3 folders will be moved to content/resources/ and their references rewritten.');
    expect(ops(r.plan, 'remove-missing-reference')).toEqual([]);

    expectVerified(r);
    expect(r.outcome.report.validations.find((v) => v.name === 'entry-set')?.detail).toBe('20 entries (3 removed, 5 moved)');
    expect(r.outcome.report.operations.filter((o) => o.op === 'move-resource').map((o) => o.detail)).toEqual([
      'moved to content/resources/ficha.pdf; 5 references rewritten',
      'moved to content/resources/foto.jpg; 5 references rewritten',
      'moved to content/resources/foto_2.jpg; 5 references rewritten',
      'moved to content/resources/logo.png; 5 references rewritten',
      'moved to content/resources/nota_2.png; 5 references rewritten',
    ]);
    const resources = r.names.filter((n) => n.startsWith('content/resources/'));
    expect(resources).toEqual([
      'content/resources/foto.jpg',
      'content/resources/ficha.pdf',
      'content/resources/foto_2.jpg',
      'content/resources/logo.png',
      'content/resources/portada.png',
      'content/resources/nota.png',
      'content/resources/nota_2.png',
      // A user folder is not an editor folder.
      'content/resources/mis fotos/playa.jpg',
    ]);
    // The empty 20240101120000FFFFFF/ entry is gone and the manifest lists the new names.
    expect(r.names.some((n) => ODE_ID.test(n))).toBe(false);
    expect([...manifestFiles(r)].sort()).toEqual(r.names.filter((n) => !n.endsWith('/')).sort());

    const xml = r.texts.get('content.xml')!;
    for (const id of [A, B, C, D, E]) expect(xml).not.toContain(id);
    // Both the v3 short form ({{context_path}}/<ODE-ID>/f) and the long form become content/resources/f.
    expect(xml).toContain(`<img src="${R}/foto.jpg" alt="Foto A"> <img src="${R}/foto_2.jpg" alt="Foto B">`);
    expect(xml).toContain(`<a href="${R}/ficha.pdf">Ficha</a> <img src="${R}/logo.png" alt="Logo">`);
    expect(xml).toContain(`<img src="${R}/portada.png" alt="Portada"> <img src="${R}/nota_2.png" alt="Nota">`);
    expect(xml).toContain(`<img src=\\"${R}/foto_2.jpg\\" alt=\\"Foto B\\">`);
    // DataGame JSON: the merged copy now points to the moved original.
    expect(xml).toContain(`{"url":"${R}/logo.png","back":"${R}/fondo-perdido.png","points":[]}`);
    // Broken references are kept unless asked otherwise.
    expect(xml).toContain(`${CP}/20240101120000ZZZZZZ/borrada.jpg`);
    const html = r.texts.get('index.html')!;
    expect(html).toContain('<img src="content/resources/foto.jpg" alt="Foto A"> <img src="content/resources/foto_2.jpg" alt="Foto B">');
    expect(html).toContain('{"url":"content/resources/logo.png","back":"content/resources/fondo-perdido.png","points":[]}');
    expect(html).toContain('<img src="content/resources/mis fotos/playa.jpg" alt="Playa">');
    const search = r.texts.get('search_index.js')!;
    expect(search).toContain(`<img src=\\"${R}/nota_2.png\\" alt=\\"Nota\\">`);
    expect(search).toContain(`{\\"url\\":\\"${R}/logo.png\\"`);

    // The result has no files or resolved references in editor folders left.
    expect(r.after.result.package?.legacyFolders).toEqual({ folders: 0, files: 0 });
    expect(codes(r.after)).not.toContain('legacy-resource-folders');
    const odeRefs = r.after.result.references.filter((x) => ODE_ID.test(x.value) || ODE_ID.test(x.target ?? ''));
    expect(odeRefs.length).toBe(5);
    expect(odeRefs.every((x) => x.status === 'missing' && x.value.includes('ZZZZZZ/borrada.jpg'))).toBe(true);
    expect(entry(r.after, 'content/resources/logo.png').references).toBe(8);
    expect(entry(r.after, 'content/resources/portada.png').references).toBe(5);
  });

  it('also takes out the broken references when asked', async () => {
    const r = await run(elpxFixture('legacy-folders.elpx'), { flatten: 'legacy', missingReferences: 'remove' });
    expect(ops(r.plan, 'remove-missing-reference').map((o) => [o.path, o.references, o.actions, o.entries])).toEqual([
      [`content/resources/20240101120000ZZZZZZ/borrada.jpg`, 5, { element: 5, attribute: 0, value: 0 }, ['content.xml', 'index.html', 'search_index.js']],
      ['content/resources/apuntes.pdf', 5, { element: 0, attribute: 5, value: 0 }, ['content.xml', 'index.html', 'search_index.js']],
      ['content/resources/fondo-perdido.png', 3, { element: 0, attribute: 0, value: 3 }, ['content.xml', 'index.html', 'search_index.js']],
    ]);
    expect(ops(r.plan, 'rewrite-references').map((o) => [o.path, o.edits, o.reason])).toEqual([
      ['content.xml', 18, 'references to moved files; references to removed duplicates; references to missing files taken out'],
      ['index.html', 10, 'references to moved files; references to removed duplicates; references to missing files taken out'],
      ['search_index.js', 18, 'references to moved files; references to removed duplicates; references to missing files taken out'],
    ]);
    expect(r.plan.risks).toContain('References to missing files will be taken out: images and media players are deleted, links keep their text.');
    expectVerified(r);
    expect(r.outcome.report.operations.filter((o) => o.op === 'remove-missing-reference').map((o) => o.detail)).toEqual([
      '5 references taken out of content.xml, index.html, search_index.js',
      '5 references taken out of content.xml, index.html, search_index.js',
      '3 references taken out of content.xml, index.html, search_index.js',
    ]);
    const xml = r.texts.get('content.xml')!;
    expect(xml).not.toContain('borrada.jpg');
    expect(xml).not.toContain('apuntes.pdf');
    expect(xml).not.toContain('fondo-perdido.png');
    expect(xml).toContain('<p> <a>Apuntes</a></p>');
    expect(xml).toContain(`{"url":"${R}/logo.png","back":"","points":[]}`);
    expect(r.texts.get('index.html')).toContain('<p> <a>Apuntes</a></p>');
    expect(r.texts.get('search_index.js')).toContain('<p> <a>Apuntes</a></p>');
    // Nothing broken and nothing in an editor folder is left.
    expect(r.after.result.references.filter((x) => x.status !== 'resolved' && x.kind === 'explicit')).toEqual([]);
    expect(r.after.result.references.some((x) => ODE_ID.test(x.value))).toBe(false);
    expect(codes(r.after)).not.toContain('missing-resource');
  });

  it('combines with deduplication and the unused-file cleanup', async () => {
    const r = await run(elpxFixture('legacy-folders.elpx'), { flatten: 'legacy', deduplicate: 'exact', removeUnused: 'safe' });
    expect(ops(r.plan, 'remove-unused').map((o) => o.path)).toEqual(['content/resources/nota.png', 'content/resources/portada.png']);
    // Deduplication runs first (kind "duplicate"); the kept file then moves.
    expect(ops(r.plan, 'deduplicate').map((o) => [o.keep, o.remove])).toEqual([[`content/resources/${B}/logo.png`, [`content/resources/${C}/logo.png`]]]);
    // Names freed by the cleanup are used without a suffix.
    expect(ops(r.plan, 'move-resource').map((o) => [o.path, o.to])).toEqual([
      [`content/resources/${A}/ficha.pdf`, 'content/resources/ficha.pdf'],
      [`content/resources/${A}/foto.jpg`, 'content/resources/foto.jpg'],
      [`content/resources/${B}/foto.jpg`, 'content/resources/foto_2.jpg'],
      [`content/resources/${B}/logo.png`, 'content/resources/logo.png'],
      [`content/resources/${D}/portada.png`, 'content/resources/portada.png'],
      [`content/resources/${E}/nota.png`, 'content/resources/nota.png'],
    ]);
    expectVerified(r);
    expect(r.outcome.report.validations.find((v) => v.name === 'entry-set')?.detail).toBe('19 entries (4 removed, 6 moved)');
    expect(r.outcome.report.validations.find((v) => v.name === 'references-still-resolve')?.detail).toBe('62 references checked, 47 resolve (47 before)');
    expect(r.names.filter((n) => n.startsWith('content/resources/'))).toEqual([
      'content/resources/foto.jpg',
      'content/resources/ficha.pdf',
      'content/resources/foto_2.jpg',
      'content/resources/logo.png',
      'content/resources/portada.png',
      'content/resources/nota.png',
      'content/resources/mis fotos/playa.jpg',
    ]);
    // The moved files kept their bytes under the freed names.
    expect(entry(r.after, 'content/resources/portada.png').size).toBe(entry(r.analysis, `content/resources/${D}/portada.png`).size);
    expect(entry(r.after, 'content/resources/nota.png').size).toBe(entry(r.analysis, `content/resources/${E}/nota.png`).size);
    expect(r.texts.get('content.xml')).toContain(`<img src="${R}/portada.png" alt="Portada"> <img src="${R}/nota.png" alt="Nota">`);
    // With both features, the unreferenced flat copy of portada.png is merged instead of removed.
    const both = restructure(r.analysis, { deduplicate: true, flatten: true });
    expect(both.merges.map((m) => [m.keep, m.remove, m.rewritten])).toEqual([
      [`content/resources/${B}/logo.png`, [`content/resources/${C}/logo.png`], { [`content/resources/${C}/logo.png`]: 3 }],
      [`content/resources/${D}/portada.png`, ['content/resources/portada.png'], { 'content/resources/portada.png': 0 }],
    ]);
    expect(both.renames.get(`content/resources/${D}/portada.png`)).toBe('content/resources/portada.png');
  });
});

describe('flatten: decisions per file', () => {
  const P = ode('PPPPPP');
  const Q = ode('QQQQQQ');
  const S = ode('SSSSSS');

  it('keeps files whose references cannot follow them, and explains why', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="hermana.png" width="1" height="1"/></svg>';
    const bytes = buildElpx({
      components: [
        { html: `<img src="${CP}/${P}/dinamica.png"><script>var a = "content/resources/${P}/dinamica.png";</script>` },
        { html: `<script>var b = "content/resources/${P}/solo-codigo.png";</script>` },
        { html: `<img src="${CP}/${P}/excluida.png"><img src="${CP}/${Q}/figura.svg">` },
        // A missing flat reference that the basename fallback resolves to the editor-folder file.
        { html: `<img src="${R}/w.png"><img src="${CP}/${P}/w.png">` },
        // Published pages never contain placeholders; one that does cannot be rewritten for a new path.
        { html: `<img src="${CP}/${P}/publicada.png">` },
      ],
      files: {
        'index.html': page(`<img src="${CP}/${P}/publicada.png">`),
        [`content/resources/${P}/dinamica.png`]: png(1),
        [`content/resources/${P}/solo-codigo.png`]: png(2),
        [`content/resources/${P}/excluida.png`]: png(3),
        [`content/resources/${P}/w.png`]: png(4),
        [`content/resources/${P}/publicada.png`]: png(5),
        [`content/resources/${Q}/figura.svg`]: svg,
        [`content/resources/${Q}/hermana.png`]: png(6),
      },
    });
    const analysis = await analyzeBytes(bytes);
    const plan = restructure(analysis, { flatten: true, excluded: new Set([`content/resources/${P}/excluida.png`]) });
    expect(reasons(plan)).toEqual({
      [`content/resources/${P}/dinamica.png`]: 'also matched by lenient or dynamic references: possible reference in script or obfuscated data',
      [`content/resources/${P}/solo-codigo.png`]: 'uncertain references: possible reference in script or obfuscated data',
      [`content/resources/${P}/excluida.png`]: 'excluded by the user',
      [`content/resources/${P}/w.png`]: 'also matched by lenient or dynamic references: lenient match (basename)',
      [`content/resources/${P}/publicada.png`]: 'reference in index.html cannot be expressed for content/resources/publicada.png',
      [`content/resources/${Q}/figura.svg`]: 'contains references to other files',
    });
    expect(plan.skipped.every((s) => s.kind === 'flatten')).toBe(true);
    // A file referenced from a resource that stays is moved; the resource's reference follows it.
    expect(plan.moves).toEqual([{ from: `content/resources/${Q}/hermana.png`, to: 'content/resources/hermana.png', references: 1 }]);
    const svgEdits = plan.edits.get(`content/resources/${Q}/figura.svg`)!;
    expect(svgEdits).toHaveLength(1);
    expect(svg.slice(0, svgEdits[0]!.start) + svgEdits[0]!.text + svg.slice(svgEdits[0]!.end)).toContain('href="../hermana.png"');
    expect(plan.merges).toEqual([]);
    expect(plan.emptiedDirectories).toEqual([]);
  });

  it('chooses free names case- and normalization-insensitively; folders and excluded copies count as taken', async () => {
    const bytes = buildElpx({
      components: [
        {
          html:
            `<img src="${CP}/${S}/foto.jpg"><img src="${CP}/${S}/café.png"><a href="${CP}/${S}/fotos">fotos</a>` +
            `<img src="${CP}/${S}/logo.png"><img src="${CP}/${S}/falsa.png"><img src="${R}/fotos/x.png">`,
        },
      ],
      files: {
        // Taken names: other letter case, decomposed (NFD) accent, and a folder.
        'content/resources/Foto.JPG': JPG,
        'content/resources/cafe\u0301.png': png(1),
        'content/resources/fotos/x.png': png(2),
        'content/resources/logo.png': png(3),
        [`content/resources/${S}/foto.jpg`]: media('efficient.jpg'),
        [`content/resources/${S}/café.png`]: png(4),
        [`content/resources/${S}/fotos`]: 'no extension',
        [`content/resources/${S}/logo.png`]: png(3),
        // JPEG data in a .png: moving never looks at the content.
        [`content/resources/${S}/falsa.png`]: JPG,
        [`content/resources/${S}/sin-uso.png`]: png(5),
        [`content/resources/${S}/`]: new Uint8Array(0),
      },
    });
    const analysis = await analyzeBytes(bytes);
    expect(entry(analysis, `content/resources/${S}/falsa.png`).extensionMatches).toBe(false);
    const plan = restructure(analysis, { flatten: true, excluded: new Set(['content/resources/logo.png']) });
    expect(plan.moves).toEqual([
      { from: `content/resources/${S}/café.png`, to: 'content/resources/café_2.png', references: 1 },
      { from: `content/resources/${S}/falsa.png`, to: 'content/resources/falsa.png', references: 1 },
      { from: `content/resources/${S}/foto.jpg`, to: 'content/resources/foto_2.jpg', references: 1 },
      { from: `content/resources/${S}/fotos`, to: 'content/resources/fotos_2', references: 1 },
      // Identical to content/resources/logo.png, which the user excluded: not merged into it.
      { from: `content/resources/${S}/logo.png`, to: 'content/resources/logo_2.png', references: 1 },
      { from: `content/resources/${S}/sin-uso.png`, to: 'content/resources/sin-uso.png', references: 0 },
    ]);
    expect(plan.merges).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.emptiedDirectories).toEqual([`content/resources/${S}/`]);
    const r = await run(bytes, { flatten: 'legacy', exclude: ['content/resources/logo.png'] });
    // The moved file keeps its extension mismatch; the check compares it under its original name.
    expectVerified(r);
    expect(r.after.result.diagnostics.filter((d) => d.code === 'extension-mismatch').map((d) => d.resource)).toEqual(['content/resources/falsa.png']);
    expect(r.texts.get('content.xml')).toContain(
      `<img src="${R}/foto_2.jpg"><img src="${R}/café_2.png"><a href="${R}/fotos_2">fotos</a><img src="${R}/logo_2.png"><img src="${R}/falsa.png">`,
    );
    expect(r.names.filter((n) => n.startsWith('content/resources/'))).toEqual([
      'content/resources/Foto.JPG',
      'content/resources/cafe\u0301.png',
      'content/resources/fotos/x.png',
      'content/resources/logo.png',
      'content/resources/foto_2.jpg',
      'content/resources/café_2.png',
      'content/resources/fotos_2',
      'content/resources/logo_2.png',
      'content/resources/falsa.png',
      'content/resources/sin-uso.png',
    ]);
  });
});

describe('flatten: verification of the final paths', () => {
  const P = ode('PPPPPP');

  it('cancels a move that would change how another reference resolves', async () => {
    const long = `${'imagen-con-un-nombre-muy-largo-'.repeat(3)}final.png`;
    const bytes = buildElpx({
      components: [
        // content/x.png is found through {{context_path}}/x.png; a new content/resources/x.png would make it ambiguous.
        { html: `<img src="${CP}/x.png"><img src="${CP}/x.png"><img src="${CP}/${P}/x.png">` },
        // Already found under two prefixes (the analysis records both candidates).
        { html: `<img src="${CP}/y.png">` },
        // A missing reference with other letter case would start resolving (leniently) to the moved file.
        { html: `<img src="${R}/${long.toUpperCase()}"><img src="${CP}/${P}/${long}">` },
        { html: `<img src="${CP}/${P}/z.png"><img src="${CP}/${P}/ok.png">` },
      ],
      files: {
        // A script in a page naming a file that does not exist yet.
        'index.html': page('<script>var z = "content/resources/z.png";</script>'),
        'content/x.png': png(1),
        'content/y.png': png(6),
        'content/resources/y.png': png(7),
        [`content/resources/${P}/x.png`]: png(2),
        [`content/resources/${P}/${long}`]: png(3),
        [`content/resources/${P}/z.png`]: png(4),
        [`content/resources/${P}/ok.png`]: png(5),
      },
    });
    const analysis = await analyzeBytes(bytes);
    const upper = `${R}/${long.toUpperCase()}`;
    expect(analysis.references.find((x) => x.value === upper)?.status).toBe('missing');
    expect(analysis.references.find((x) => x.value === `${CP}/y.png`)).toMatchObject({
      lenient: 'multiple-prefixes',
      candidates: ['content/y.png', 'content/resources/y.png'],
    });
    const plan = restructure(analysis, { flatten: true });
    expect(reasons(plan)).toEqual({
      [`content/resources/${P}/x.png`]: `would change how "${CP}/x.png" resolves`,
      [`content/resources/${P}/${long}`]: `would change how "${upper.slice(0, 80)}…" resolves`,
      // A name mentioned in a script protects same-named files from the start.
      [`content/resources/${P}/z.png`]: 'also matched by lenient or dynamic references: file name mentioned in script or obfuscated data',
    });
    // Everything else still moves.
    expect(plan.moves).toEqual([{ from: `content/resources/${P}/ok.png`, to: 'content/resources/ok.png', references: 1 }]);
    expect([...plan.edits.keys()]).toEqual(['content.xml']);
    const r = await run(bytes, { flatten: 'legacy' });
    expectVerified(r);
    expect(r.after.references.find((x) => x.value === `${CP}/x.png`)).toMatchObject({ status: 'resolved', target: 'content/x.png' });
    expect(r.after.references.find((x) => x.value === upper)?.status).toBe('missing');
  });

  it('keeps identical copies in place when the file they merge into cannot move', async () => {
    const bytes = buildElpx({
      components: [{ html: `<img src="${CP}/logo.png"><img src="${CP}/${B}/logo.png"><img src="${CP}/${C}/logo.png"><img src="${R}/${D}/portada.png">` }],
      files: {
        'index.html': page(`<img src="${CP}/${D}/portada.png">`),
        'content/logo.png': png(1),
        [`content/resources/${B}/logo.png`]: png(2),
        [`content/resources/${C}/logo.png`]: png(2),
        'content/resources/portada.png': png(3),
        [`content/resources/${D}/portada.png`]: png(3),
      },
    });
    const analysis = await analyzeBytes(bytes);
    const flat = restructure(analysis, { flatten: true });
    expect(flat.skipped).toEqual([
      { path: `content/resources/${B}/logo.png`, kind: 'flatten', reason: `would change how "${CP}/logo.png" resolves` },
      { path: `content/resources/${C}/logo.png`, kind: 'flatten', reason: `identical to content/resources/${B}/logo.png, which stays in place` },
      // A merge into a flat copy fails like a move when a reference cannot follow it.
      { path: `content/resources/${D}/portada.png`, kind: 'flatten', reason: 'reference in index.html cannot be expressed for content/resources/portada.png' },
    ]);
    expect(flat.moves).toEqual([]);
    expect(flat.merges).toEqual([]);
    expect(flat.edits.size).toBe(0);
    // Deduplication merges do not depend on the kept file moving and are kept.
    const both = restructure(analysis, { flatten: true, deduplicate: true });
    expect(both.merges).toEqual([
      { keep: `content/resources/${B}/logo.png`, remove: [`content/resources/${C}/logo.png`], rewritten: { [`content/resources/${C}/logo.png`]: 1 } },
      // The unreferenced flat copy goes; the referenced one stays in its folder.
      { keep: `content/resources/${D}/portada.png`, remove: ['content/resources/portada.png'], rewritten: { 'content/resources/portada.png': 0 } },
    ]);
    expect(both.moves).toEqual([]);
    expect(reasons(both)).toEqual({
      [`content/resources/${B}/logo.png`]: `would change how "${CP}/logo.png" resolves`,
      [`content/resources/${D}/portada.png`]: 'reference in index.html cannot be expressed for content/resources/portada.png',
    });
    const r = await run(bytes, { flatten: 'legacy', deduplicate: 'exact' });
    expectVerified(r);
    expect(r.texts.get('content.xml')).toContain(`<img src="${CP}/${B}/logo.png"><img src="${R}/${B}/logo.png">`);
  });

  it('cancels every change when a changed resolution cannot be blamed on one of them', async () => {
    const bytes = buildElpx({
      components: [{ html: `<img src="${CP}/${P}/a.png"><img src="${R}/b.png"><img src="${R}/c.png"><img src="${R}/fija.png">` }],
      files: {
        [`content/resources/${P}/a.png`]: png(1),
        'content/resources/b.png': png(2),
        'content/resources/c.png': png(2),
        'content/resources/fija.png': png(3),
      },
    });
    const base = await analyzeBytes(bytes);
    const clean = restructure(base, { flatten: true, deduplicate: true });
    expect(clean.moves).toHaveLength(1);
    expect(clean.merges).toHaveLength(1);
    // Simulate an analysis that recorded a different outcome for a reference to a file nobody touches.
    const fixed = base.references.find((x) => x.value === `${R}/fija.png`)!;
    const { target: _target, ...unresolved } = fixed;
    const patched: Analysis = { ...base, references: base.references.map((x) => (x === fixed ? { ...unresolved, status: 'ambiguous' as const } : x)) };
    const plan = restructure(patched, { flatten: true, deduplicate: true });
    const reason = `would change how "${R}/fija.png" resolves`;
    expect(plan.skipped).toEqual([
      { path: `content/resources/${P}/a.png`, kind: 'flatten', reason },
      { path: 'content/resources/c.png', kind: 'duplicate', reason },
    ]);
    expect(plan.moves).toEqual([]);
    expect(plan.merges).toEqual([]);
    expect(plan.edits.size).toBe(0);
    expect(plan.emptiedDirectories).toEqual([]);
  });

  it('drops directory entries left empty, and only those', async () => {
    const bytes = buildElpx({
      components: [
        {
          html: `<img src="${CP}/${A}/a.png"><img src="${CP}/${B}/b.png"><script>var x = "content/resources/${B}/dyn.png";</script><img src="${R}/copia/c.png"><img src="${R}/c.png">`,
        },
      ],
      files: {
        [`content/resources/${A}/`]: new Uint8Array(0),
        [`content/resources/${A}/a.png`]: png(1),
        [`content/resources/${B}/`]: new Uint8Array(0),
        [`content/resources/${B}/b.png`]: png(2),
        [`content/resources/${B}/dyn.png`]: png(3),
        [`content/resources/${E}/`]: new Uint8Array(0),
        'content/resources/copia/': new Uint8Array(0),
        'content/resources/copia/c.png': png(4),
        'content/resources/c.png': png(4),
        'content/resources/vacia/': new Uint8Array(0),
      },
    });
    const analysis = await analyzeBytes(bytes);
    // B keeps a file that cannot move; E and "vacia" were already empty.
    expect(restructure(analysis, { flatten: true }).emptiedDirectories).toEqual([`content/resources/${A}/`, `content/resources/${E}/`]);
    // Without flattening, only folders emptied by a change go, never other empty folders.
    expect(restructure(analysis, { deduplicate: true }).emptiedDirectories).toEqual(['content/resources/copia/']);
    expect(restructure(analysis, {}).emptiedDirectories).toEqual([]);
    const r = await run(bytes, { flatten: 'legacy', deduplicate: 'exact' });
    expectVerified(r);
    expect(r.names.filter((n) => n.endsWith('/'))).toEqual([`content/resources/${B}/`, 'content/resources/vacia/']);
  });

  it('does not count empty editor folders alone as a change, with or without a manifest', async () => {
    for (const manifest of [true, false]) {
      const bytes = buildElpx({ components: [{ html: '<p>x</p>' }], manifest, files: { [`content/resources/${A}/`]: new Uint8Array(0) } });
      const r = await run(bytes, { flatten: 'legacy' });
      // The plan lists nothing, so nothing is done: the manifest (which lists files only) is not rewritten.
      expect(r.plan.operations).toEqual([]);
      expect(r.outcome.report.status).toBe('no-improvement');
      expect(r.outcome.report.operations).toEqual([]);
      expect(r.output).toEqual(bytes);
    }
  });
});

/** htmlView contents of every component, in order. */
function htmlViews(xml: string): string[] {
  return [...xml.matchAll(/<htmlView><!\[CDATA\[([\s\S]*?)\]\]><\/htmlView>/g)].map((m) => m[1]!);
}

/** Explicit references whose target cannot exist, as the unlink option selects them. */
function broken(a: Analysis): string[] {
  return a.result.references
    .filter((x) => x.kind === 'explicit' && (x.status === 'missing' || x.status === 'unmapped' || (x.status === 'unresolvable' && x.form === 'local-file')))
    .map((x) => `${x.location.entry}: ${x.value}`);
}

/** An obfuscated DataGame payload holding HTML with broken references. */
const XOR = encryptDataGame(JSON.stringify({ html: `<img src="${R}/falta-xor.png" srcset="${R}/falta-xor-2x.png 2x">` }));

describe('remove missing references', () => {
  /** One component per case: [html, htmlView after the removal]. */
  const cases: [string, string][] = [
    [`<p><img src="${R}/falta-1.png" alt="uno"></p>`, '<p></p>'],
    // Links keep their text.
    [`<p><a href="${R}/falta.pdf">Apuntes</a></p>`, '<p><a>Apuntes</a></p>'],
    // Only listed elements go as a whole, even when empty.
    [`<p><a href="${R}/falta-ancla.pdf" id="ancla"></a></p>`, '<p><a id="ancla"></a></p>'],
    // Obfuscated DataGame payloads are only read for discovery: their references are never taken out.
    [`<div class="mapa-DataGame js-hidden">${XOR}</div>`, `<div class="mapa-DataGame js-hidden">${XOR}</div>`],
    [`<video src="${R}/falta.mp4"></video>`, ''],
    // The missing source goes; the track that exists stays.
    [
      `<video controls><source src="${R}/falta.webm" type="video/webm"><track kind="captions" src="${R}/subs.vtt"></video>`,
      `<video controls><track kind="captions" src="${R}/subs.vtt"></video>`,
    ],
    // srcset keeps its valid candidates; the element stays for them.
    [`<img src="${R}/falta-2.png" srcset="${R}/ok.png 1x, ${R}/falta-2.png 2x">`, `<img srcset="${R}/ok.png 1x">`],
    [`<img srcset="${R}/falta-3.png 1x, ${R}/falta-4.png 2x" alt="x">`, ''],
    [`<picture><source srcset="${R}/falta.webp" type="image/webp"><img src="${R}/ok.png"></picture>`, `<picture><img src="${R}/ok.png"></picture>`],
    // An element with children loses the attribute; an empty param goes.
    [
      `<object data="${R}/falta.swf" type="application/x-shockwave-flash"><param name="movie" value="${R}/falta.swf"></object>`,
      '<object type="application/x-shockwave-flash"></object>',
    ],
    [
      `<div class="mapa-DataGame js-hidden">{"url":"${R}/falta-juego.png","ok":"${R}/ok.png"}</div>`,
      `<div class="mapa-DataGame js-hidden">{"url":"","ok":"${R}/ok.png"}</div>`,
    ],
    [`<img src="file:///C:/Users/profe/foto.jpg"><img src="C:\\fotos\\x.png"><img src="asset://abc/imagen.png">`, ''],
    // Not broken: never touched.
    [`<img src="/raiz.png"><img src="https://example.com/x.png">`, `<img src="/raiz.png"><img src="https://example.com/x.png">`],
    // Skipped, with reasons.
    [
      `<div style="background:url(${R}/falta-fondo.png)">x</div><p style="background:url(${R}/falta-fondo.png)">y</p>`,
      `<div style="background:url(${R}/falta-fondo.png)">x</div><p style="background:url(${R}/falta-fondo.png)">y</p>`,
    ],
    [`<p>Ver ${R}/falta-texto.pdf ahora</p>`, `<p>Ver ${R}/falta-texto.pdf ahora</p>`],
    // Another reference held by the element (even a dynamic one) keeps the element.
    [`<img src="${R}/falta-5.png" onclick="mostrar('${R}/ok.png')">`, `<img onclick="mostrar('${R}/ok.png')">`],
    [
      `<script type="text/template"><img src="${R}/falta-plantilla.png"></script>`,
      `<script type="text/template"><img src="${R}/falta-plantilla.png"></script>`,
    ],
    // Nested (the poster attribute inside the removed video) and identical (src and srcset) removals collapse.
    [`<video src="${R}/falta-2.mp4" poster="${R}/falta-poster.jpg"></video>`, ''],
    [`<img src="${R}/falta-7.png" srcset="${R}/falta-7.png 2x">`, ''],
    // Only some attributes delete their element.
    [`<link rel="preload" as="image" imagesrcset="${R}/falta-8.png 1x">`, '<link rel="preload" as="image">'],
    [
      `<iframe src="${R}/falta.html"></iframe><audio src="${R}/falta.mp3"> <!-- sin audio --> </audio><embed src="${R}/falta.svg">` +
        `<input type="image" src="${R}/falta-boton.png"><script src="${R}/falta.js"></script>`,
      '',
    ],
    [`<video src="${R}/falta-3.mp4">Tu navegador no reproduce vídeo</video>`, '<video>Tu navegador no reproduce vídeo</video>'],
    // HTML inside an attribute value.
    [`<div data-content='<img src="${R}/falta-9.png">'>d</div>`, `<div data-content=''>d</div>`],
  ];
  const bytes = buildElpx({
    components: cases.map(([html], i) => ({ id: `c${i + 1}`, html })),
    manifest: true,
    files: {
      'index.html': page('<img src="content/resources/falta-1.png"><a href="content/resources/falta.pdf">Apuntes</a>'),
      'html/pagina.html': page('<p><img src="../img/falta.png" alt="p"></p>'),
      'search_index.js': searchIndex({ p: { idevices: { c1: { htmlView: `<p><img src="${R}/falta-1.png"></p>` } } } }),
      'content/resources/ok.png': PNG,
      'content/resources/subs.vtt': 'WEBVTT\n',
    },
  });
  const skippedCases = ['falta-fondo.png', 'falta-texto.pdf', 'falta-plantilla.png'];

  it('plans whole elements, attributes and data values per missing file', async () => {
    const analysis = await analyzeBytes(bytes);
    const plan = restructure(analysis, { removeMissing: true });
    const summary = Object.fromEntries(
      plan.unlinks.map((u) => [u.key, [u.references, `${u.actions.element}/${u.actions.attribute}/${u.actions.value}`, u.entries.join(',')]]),
    );
    expect(summary).toEqual({
      'C:\\fotos\\x.png': [1, '1/0/0', 'content.xml'],
      'asset://abc/imagen.png': [1, '1/0/0', 'content.xml'],
      // The same missing file in the three representations is one decision.
      'content/resources/falta-1.png': [3, '3/0/0', 'content.xml,index.html,search_index.js'],
      'content/resources/falta-2.mp4': [1, '1/0/0', 'content.xml'],
      'content/resources/falta-2.png': [2, '0/1/1', 'content.xml'],
      'content/resources/falta-3.mp4': [1, '0/1/0', 'content.xml'],
      'content/resources/falta-3.png': [1, '1/0/0', 'content.xml'],
      'content/resources/falta-4.png': [1, '1/0/0', 'content.xml'],
      'content/resources/falta-5.png': [1, '0/1/0', 'content.xml'],
      'content/resources/falta-7.png': [2, '2/0/0', 'content.xml'],
      'content/resources/falta-8.png': [1, '0/1/0', 'content.xml'],
      'content/resources/falta-9.png': [1, '1/0/0', 'content.xml'],
      'content/resources/falta-ancla.pdf': [1, '0/1/0', 'content.xml'],
      'content/resources/falta-boton.png': [1, '1/0/0', 'content.xml'],
      'content/resources/falta-juego.png': [1, '0/0/1', 'content.xml'],
      'content/resources/falta-poster.jpg': [1, '0/1/0', 'content.xml'],
      'content/resources/falta.html': [1, '1/0/0', 'content.xml'],
      'content/resources/falta.js': [1, '1/0/0', 'content.xml'],
      'content/resources/falta.mp3': [1, '1/0/0', 'content.xml'],
      'content/resources/falta.mp4': [1, '1/0/0', 'content.xml'],
      'content/resources/falta.pdf': [2, '0/2/0', 'content.xml,index.html'],
      'content/resources/falta.svg': [1, '1/0/0', 'content.xml'],
      'content/resources/falta.swf': [2, '1/1/0', 'content.xml'],
      'content/resources/falta.webm': [1, '1/0/0', 'content.xml'],
      'content/resources/falta.webp': [1, '1/0/0', 'content.xml'],
      'file:///C:/Users/profe/foto.jpg': [1, '1/0/0', 'content.xml'],
      // A page-relative path outside content/resources/ keys on the path it expects.
      'img/falta.png': [1, '1/0/0', 'html/pagina.html'],
    });
    expect(plan.skipped).toEqual([
      { path: 'content/resources/falta-fondo.png', kind: 'missing-reference', reason: 'in a stylesheet; only HTML attributes and data values are removed' },
      { path: 'content/resources/falta-plantilla.png', kind: 'missing-reference', reason: 'in xml-cdata › html-text, which cannot be rewritten' },
      {
        path: 'content/resources/falta-texto.pdf',
        kind: 'missing-reference',
        reason: 'inside text in xml-cdata › html-text; only HTML attributes and data values are removed',
      },
    ]);
    expect(plan.moves).toEqual([]);
    expect(plan.merges).toEqual([]);
    expect([...plan.edits.keys()]).toEqual(['content.xml', 'html/pagina.html', 'index.html', 'search_index.js']);
    // 29 references, 26 edits: one srcset edit covers two candidates, and the nested poster removal and the
    // second copy of the img removal fold into the enclosing removals.
    expect(broken(analysis).filter((b) => b.startsWith('content.xml:') && !skippedCases.some((f) => b.endsWith(f)))).toHaveLength(29);
    expect(plan.edits.get('content.xml')).toHaveLength(26);
    const xor = analysis.references.filter((x) => x.via.includes('datagame-xor'));
    expect(xor.map((x) => [x.value, x.kind, x.status, x.element, x.removal])).toEqual([
      [`${R}/falta-xor.png`, 'dynamic', 'missing', undefined, undefined],
      [`${R}/falta-xor-2x.png`, 'dynamic', 'missing', undefined, undefined],
    ]);
    expect(plan.edits.get('content.xml')!.every((e, i, all) => i === 0 || all[i - 1]!.end <= e.start)).toBe(true);
  });

  it('writes the result, verifies it and leaves only the skipped references broken', async () => {
    const r = await run(bytes, { missingReferences: 'remove' });
    expectVerified(r);
    expect(htmlViews(r.texts.get('content.xml')!)).toEqual(cases.map(([, after]) => after));
    expect(r.texts.get('index.html')).toContain('<body><a>Apuntes</a></body>');
    expect(r.texts.get('html/pagina.html')).toContain('<body><p></p></body>');
    expect(r.texts.get('search_index.js')).toBe(searchIndex({ p: { idevices: { c1: { htmlView: '<p></p>' } } } }));
    expect(broken(r.after)).toEqual([
      `content.xml: ${R}/falta-fondo.png`,
      `content.xml: ${R}/falta-fondo.png`,
      `content.xml: ${R}/falta-texto.pdf`,
      `content.xml: ${R}/falta-plantilla.png`,
    ]);
    expect(broken(r.analysis).length).toBe(37);
    // Nothing moved or merged: the manifest is left alone.
    expect(ops(r.plan, 'update-manifest')).toEqual([]);
    expect(r.outcome.report.operations.some((o) => o.op === 'update-manifest')).toBe(false);
    expect(ops(r.plan, 'rewrite-references').map((o) => o.reason)).toEqual(Array(4).fill('references to missing files taken out'));
    const resolves = r.outcome.report.validations.find((v) => v.name === 'references-still-resolve')!;
    expect(resolves.detail).toBe('13 references checked, 4 resolve (4 before)');
    expect(r.outcome.report.operations.find((o) => o.id === 'unlink:content/resources/falta-1.png')?.detail).toBe(
      '3 references taken out of content.xml, index.html, search_index.js',
    );
    expect(r.outcome.report.operations.find((o) => o.id === 'unlink:content/resources/falta.js')?.detail).toBe('1 reference taken out of content.xml');
  });
});

describe('remove missing references: edits that cannot be made', () => {
  const P = ode('PPPPPP');
  const SPLIT = '@@SPLIT@@';

  it('skips removals that would cut through an encoding boundary or another change', async () => {
    // A CDATA section boundary inside the removed range cannot be lifted into content.xml.
    const xml = odeXml({
      components: [
        { html: `<img src="${R}/falta-a.png" alt="a${SPLIT}">` },
        { html: `<a href="${R}/falta-${SPLIT}b.pdf">b</a>` },
        { html: `<div class="mapa-DataGame js-hidden">{"url":"${R}/falta-${SPLIT}c.png"}</div>` },
        { html: `<img src="${R}/ok.png" srcset="${R}/falta-d.png 1x, ${R}/ok.png 2${SPLIT}x">` },
        // The srcset value edit would overwrite the rewritten candidate of a moved file.
        { html: `<img src="${R}/ok.png" srcset="${CP}/${P}/movida.png 1x, ${R}/falta-e.png 2x">` },
      ],
    }).replaceAll(SPLIT, ']]><![CDATA[');
    const bytes = buildElpx({ contentXml: xml, files: { 'content/resources/ok.png': PNG, [`content/resources/${P}/movida.png`]: png(1) } });
    const analysis = await analyzeBytes(bytes);
    expect(analysis.result.ok).toBe(true);
    const plan = restructure(analysis, { removeMissing: true, flatten: true });
    expect(plan.skipped).toEqual([
      { path: 'content/resources/falta-a.png', kind: 'missing-reference', reason: 'the element cannot be edited in its encoding' },
      { path: 'content/resources/falta-b.pdf', kind: 'missing-reference', reason: 'the element cannot be edited in its encoding' },
      { path: 'content/resources/falta-c.png', kind: 'missing-reference', reason: 'the data value cannot be edited in its encoding' },
      { path: 'content/resources/falta-d.png', kind: 'missing-reference', reason: 'the srcset attribute cannot be edited in its encoding' },
      { path: 'content/resources/falta-e.png', kind: 'missing-reference', reason: 'the srcset attribute cannot be edited in its encoding' },
    ]);
    expect(plan.unlinks).toEqual([]);
    expect(plan.moves).toEqual([{ from: `content/resources/${P}/movida.png`, to: 'content/resources/movida.png', references: 1 }]);
    const r = await run(bytes, { missingReferences: 'remove', flatten: 'legacy' });
    expectVerified(r);
    expect(r.texts.get('content.xml')).toContain(`srcset="${R}/movida.png 1x, ${R}/falta-e.png 2x"`);
    expect(broken(r.after)).toHaveLength(5);
  });

  it('handles references and elements it cannot anchor (patched analysis)', async () => {
    const bytes = buildElpx({
      components: [
        {
          html:
            `<img src="${R}/falta-a.png"><img src="${R}/falta-b.png"><img src="${R}/falta-c.png">` +
            `<img src="${R}/falta-d.png"><img srcset="${R}/falta-e.png 1x">`,
        },
      ],
      files: { 'index.html': page('<img src="content/resources/falta-f.png">') },
    });
    const base = await analyzeBytes(bytes);
    const find = (name: string): ReferenceInternal => base.references.find((x) => x.value.endsWith(name))!;
    const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => find(`falta-${x}.png`)) as ReferenceInternal[] as [
      ReferenceInternal,
      ReferenceInternal,
      ReferenceInternal,
      ReferenceInternal,
      ReferenceInternal,
      ReferenceInternal,
    ];
    const { element: _element, ...noElement } = a;
    const { site: _site, removal: _removal, ...bare } = b;
    const { candidates: _candidates, ...noCandidates } = d;
    // Elements whose start cannot be located still go as a whole (they hold nothing else).
    const unanchored = (x: ReferenceInternal): ReferenceInternal => ({
      ...x,
      element: { ...x.element!, lift: (edit) => (edit.start === edit.end ? undefined : x.element!.lift(edit)) },
    });
    const patched: Analysis = {
      ...base,
      references: [
        noElement,
        { ...bare, via: [], rewritable: false },
        { ...bare, id: 100, via: [], value: 'hueco.png' },
        unanchored(c),
        noCandidates,
        unanchored(e),
        // A page reference that lost its location still resolves against the package root.
        { ...f, location: {} },
      ],
    };
    const plan = restructure(patched, { removeMissing: true });
    expect(plan.skipped).toEqual([
      { path: 'content/resources/falta-a.png', kind: 'missing-reference', reason: 'the element holding it cannot be edited' },
      { path: 'content/resources/falta-b.png', kind: 'missing-reference', reason: 'in its location, which cannot be rewritten' },
      {
        path: 'content/resources/falta-b.png',
        kind: 'missing-reference',
        reason: 'inside text in its location; only HTML attributes and data values are removed',
      },
    ]);
    // A missing reference without an expected path is keyed by its value.
    expect(plan.unlinks.map((u) => [u.key, u.actions, u.entries])).toEqual([
      ['content/resources/falta-c.png', { element: 1, attribute: 0, value: 0 }, ['content.xml']],
      ['content/resources/falta-e.png', { element: 1, attribute: 0, value: 0 }, ['content.xml']],
      ['content/resources/falta-f.png', { element: 1, attribute: 0, value: 0 }, ['index.html']],
      [`${R}/falta-d.png`, { element: 1, attribute: 0, value: 0 }, ['content.xml']],
    ]);
    const size = (x: ReferenceInternal): number => x.element!.span!.end - x.element!.span!.start;
    expect(plan.edits.get('content.xml')!.map((edit) => [edit.end - edit.start, edit.text])).toEqual([
      [size(c), ''],
      [size(d), ''],
      [size(e), ''],
    ]);
    expect(plan.edits.get('index.html')!.map((edit) => [edit.end - edit.start, edit.text])).toEqual([[size(f), '']]);
  });
});

describe('normalizeEdits (through planRestructure)', () => {
  const P = ode('PPPPPP');

  it('collapses identical edits and refuses partial overlaps', async () => {
    const bytes = buildElpx({
      components: [{ html: `<img src="${CP}/${P}/a.png">` }],
      files: { [`content/resources/${P}/a.png`]: png(1) },
    });
    const base = await analyzeBytes(bytes);
    const ref = base.references.find((x) => x.value === `${CP}/${P}/a.png`)!;
    // The same site recorded twice yields two identical edits: one is kept.
    const twice: Analysis = { ...base, references: [...base.references, { ...ref, id: 100 }] };
    const plan = restructure(twice, { flatten: true });
    expect(plan.moves).toEqual([{ from: `content/resources/${P}/a.png`, to: 'content/resources/a.png', references: 2 }]);
    expect(plan.edits.get('content.xml')).toEqual([restructure(base, { flatten: true }).edits.get('content.xml')![0]]);
    // Edits that overlap without being identical removals cannot come from well-formed markup.
    const at = (start: number, end: number, id = ref.id): ReferenceInternal => ({ ...ref, id, site: { ...ref.site!, start, end } });
    const { start, end } = ref.site!;
    const overlapping: Analysis = { ...base, references: base.references.map((x) => (x === ref ? at(start, end - 1) : x)).concat(at(start + 1, end, 101)) };
    expect(() => restructure(overlapping, { flatten: true })).toThrow('Overlapping reference edits in content.xml');
    const nested: Analysis = { ...base, references: [...base.references, at(start + 1, end, 101)] };
    expect(() => restructure(nested, { flatten: true })).toThrow('Overlapping reference edits in content.xml');
  });
});

/** Pads a written archive with a ZIP comment so that it is at least `size` bytes long. */
function padTo(size: number): (bytes: Uint8Array) => Uint8Array {
  return (bytes) => {
    const extra = Math.max(0, size - bytes.length);
    const out = new Uint8Array(bytes.length + extra);
    out.set(bytes);
    // The writer ends with an end-of-central-directory record without comment; declare the padding as one.
    new DataView(out.buffer).setUint16(bytes.length - 2, extra, true);
    return out;
  };
}

describe('optimizeArchive with restructuring', () => {
  const P = ode('PPPPPP');

  it('counts moves and removed references as a benefit even when the package does not shrink', async () => {
    const bytes = buildElpx({
      components: [
        { html: `<img src="${CP}/${P}/a.png"><img src="${R}/b.png"><img src="${R}/c.png"><img src="${R}/falta.png">` },
        // A known problem without a resource is carried over, not reported as new.
        { html: '<p>Texto</p>', json: '{"roto": ' },
      ],
      manifest: true,
      files: { [`content/resources/${P}/a.png`]: png(1), 'content/resources/b.png': png(2), 'content/resources/c.png': png(2) },
    });
    const tamper = padTo(bytes.length);
    const moved = await run(bytes, { flatten: 'legacy' }, { tamper });
    expect(codes(moved.analysis)).toContain('json-properties-malformed');
    expectVerified(moved);
    expect(codes(moved.after)).toContain('json-properties-malformed');
    expect(moved.output.length).toBeGreaterThanOrEqual(bytes.length);
    expect(moved.names).toContain('content/resources/a.png');
    // Renames alone update the manifest.
    expect(ops(moved.plan, 'update-manifest')).toHaveLength(1);
    expect(manifestFiles(moved)).toContain('content/resources/a.png');
    expect(manifestFiles(moved)).not.toContain(`content/resources/${P}/a.png`);
    const unlinked = await run(bytes, { missingReferences: 'remove' }, { tamper });
    expectVerified(unlinked);
    expect(unlinked.output.length).toBeGreaterThanOrEqual(bytes.length);
    expect(unlinked.texts.get('content.xml')).not.toContain('falta.png');
    // A deduplication that does not make the package smaller is not worth delivering.
    const merged = await run(bytes, { deduplicate: 'exact' }, { tamper });
    expect(merged.outcome.report.status).toBe('no-improvement');
    expect(merged.output).toEqual(bytes);
  });

  it('flags renamed entries as UTF-8 when the new name needs it', async () => {
    const xml = odeXml({ components: [{ html: `<img src="${CP}/${P}/año.png"><img src="${CP}/${P}/nino.png"><img src="${CP}/${P}/señal.png">` }] });
    const files: [string, Uint8Array | string, number][] = [
      ['content.xml', xml, 0x0800],
      ['content.dtd', '<!ELEMENT ode ANY>\n', 0x0800],
      // Written by a tool that did not set the UTF-8 flag.
      [`content/resources/${P}/año.png`, png(1), 0],
      [`content/resources/${P}/nino.png`, png(2), 0],
      [`content/resources/${P}/señal.png`, png(3), 0x0800],
    ];
    const bytes = craftZip(files.map(([name, data, flags]) => ({ name, data, flags, method: name.endsWith('.png') ? 0 : 8 })));
    const r = await run(bytes, { flatten: 'legacy' });
    expect(r.analysis.result.diagnostics.filter((d) => d.code === 'zip-name-encoding').map((d) => d.resource)).toEqual([`content/resources/${P}/año.png`]);
    expectVerified(r);
    expect(Object.fromEntries(r.utf8)).toEqual({
      'content.xml': true,
      'content.dtd': true,
      'content/resources/año.png': true,
      'content/resources/nino.png': false,
      'content/resources/señal.png': true,
    });
    expect(codes(r.after)).not.toContain('zip-name-encoding');
  });

  it('moves a file whose content was also re-encoded', async () => {
    const store = new MemoryStore();
    const engine = new FakeEngine(store);
    const small = media('efficient.jpg');
    engine.encode = () => Promise.resolve(small);
    const bytes = buildElpx({
      components: [{ html: `<img src="${CP}/${P}/foto.jpg">` }],
      files: { [`content/resources/${P}/foto.jpg`]: media('photo-exif-icc.jpg') },
    });
    const r = await run(bytes, { flatten: 'legacy', images: {} }, { engine });
    expect(ops(r.plan, 'recompress-image').map((o) => o.path)).toEqual([`content/resources/${P}/foto.jpg`]);
    expectVerified(r);
    expect(r.outcome.report.operations.find((o) => o.op === 'recompress-image')?.status).toBe('applied');
    expect(r.names).toContain('content/resources/foto.jpg');
    expect(entry(r.after, 'content/resources/foto.jpg').size).toBeLessThan(entry(r.analysis, `content/resources/${P}/foto.jpg`).size);
    expect(r.outcome.report.validations.find((v) => v.name === 'unchanged-entries-preserved')?.detail).toBe(
      '2 entries changed as planned, 0 unexpected changes',
    );
  });
});
