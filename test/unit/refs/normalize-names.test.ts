import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../../../src/core/io/byte-source.js';
import { openZip, readEntryBytes } from '../../../src/core/zip/reader.js';
import { planRestructure, type RestructureOptions, type RestructurePlan } from '../../../src/core/refs/restructure.js';
import { applyTextEdits } from '../../../src/core/refs/rewrite.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import { buildOptimizationPlan, type OptimizationPlan, type PlanOperation } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import { optimizeArchive, type OptimizeOutcome } from '../../../src/core/optimize/optimize.js';
import { parseManifest } from '../../../src/core/format/manifest.js';
import { NATIVE_LIMITS } from '../../../src/core/limits.js';
import { analyzeBytes, buildElpx, dec, media, page } from '../../helpers/core-kit.js';
import { fakePlatform, fakeWav } from '../../helpers/fake-platform.js';

/** Clean file names (normalizeNames: 'slug'): planning, collisions, interplay with moves and conversions, plan and execution. */

const CP = '{{context_path}}';
const R = `${CP}/content/resources`;
const PNG = media('palette-efficient.png');
const P = '20240101120000PPPPPP';

/** PNG bytes made distinct by trailing padding. */
function png(n: number): Uint8Array {
  const out = new Uint8Array(PNG.length + n);
  out.set(PNG);
  out.fill(n, PNG.length);
  return out;
}

/** Plans clean names (other features off unless patched). */
function normalize(analysis: Analysis, patch: Partial<RestructureOptions> = {}): RestructurePlan {
  return planRestructure(analysis, {
    deduplicate: false,
    flatten: false,
    removeMissing: false,
    excluded: new Set(),
    removed: new Set(),
    normalizeNames: true,
    ...patch,
  });
}

/** The htmlView of the first component after the plan's edits. */
function view(analysis: Analysis, plan: RestructurePlan): string {
  return /<htmlView><!\[CDATA\[([\s\S]*?)\]\]><\/htmlView>/.exec(applyTextEdits(analysis.texts, plan.edits).get('content.xml')!)![1]!;
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="hermana.png" width="1" height="1"/></svg>';
const bytes = buildElpx({
  components: [
    {
      html: [
        `<img src="${R}/Copia de Foto Clase (2).JPG">`,
        `<img src="${R}/mis fotos/Año 1.png">`,
        `<img src="${R}/foto-ok.jpg">`,
        `<a href="${CP}/custom/Mi Archivo.pdf">pdf</a>`,
        `<script>var s = "content/resources/Sonido_Raro.mp3";</script>`,
        `<img src="${R}/Diagrama Final.svg">`,
        `<img src="${R}/Foto.JPG"><img src="${R}/foto.jpg"><img src="${R}/foto-2.jpg">`,
        `<a href="${R}/Tema (1).pdf">1</a><a href="${R}/Tema (2).pdf">2</a>`,
        `<iframe src="${R}/applet/Index Principal.html"></iframe>`,
      ].join(''),
    },
  ],
  manifest: true,
  files: {
    'index.html': page('<img src="content/resources/Copia%20de%20Foto%20Clase%20(2).JPG"><img src="content/resources/mis%20fotos/A%C3%B1o%201.png">'),
    'content/resources/Copia de Foto Clase (2).JPG': png(1),
    'content/resources/mis fotos/Año 1.png': png(2),
    'content/resources/foto-ok.jpg': png(3),
    'custom/Mi Archivo.pdf': '%PDF-1.4\n',
    'content/resources/Sonido_Raro.mp3': png(4),
    'content/resources/Diagrama Final.svg': svg,
    'content/resources/hermana.png': png(5),
    'content/resources/Foto.JPG': png(6),
    'content/resources/foto.jpg': png(7),
    'content/resources/foto-2.jpg': png(8),
    'content/resources/Tema (1).pdf': '%PDF-1.4\n1',
    'content/resources/Tema (2).pdf': '%PDF-1.4\n2',
    'content/resources/applet/Index Principal.html': page('<p>applet</p>'),
    'content/resources/Sin Uso.txt': 'nothing',
    'theme/Img Fondo.png': png(9),
  },
});

describe('normalizeNames: planning', () => {
  it('cleans file names, keeps folders, takes the next free "-n" name and rewrites every reference', async () => {
    const analysis = await analyzeBytes(bytes);
    const plan = normalize(analysis);
    expect(plan.renamed).toEqual([
      { from: 'content/resources/Copia de Foto Clase (2).JPG', to: 'content/resources/foto-clase.jpg', references: 2 },
      // foto.jpg and foto-2.jpg are taken.
      { from: 'content/resources/Foto.JPG', to: 'content/resources/foto-3.jpg', references: 1 },
      { from: 'content/resources/Sin Uso.txt', to: 'content/resources/sin-uso.txt', references: 0 },
      { from: 'content/resources/Tema (1).pdf', to: 'content/resources/tema.pdf', references: 1 },
      { from: 'content/resources/Tema (2).pdf', to: 'content/resources/tema-2.pdf', references: 1 },
    ]);
    expect(plan.moves).toEqual([]);
    expect(plan.conversions).toEqual([]);
    // Runtime files, the File Manager folder and clean names are never candidates.
    expect(plan.skipped).toEqual([
      { path: 'content/resources/Diagrama Final.svg', kind: 'rename', reason: 'contains references to other files' },
      { path: 'content/resources/Sonido_Raro.mp3', kind: 'rename', reason: 'uncertain references: possible reference in script or obfuscated data' },
      { path: 'content/resources/applet/Index Principal.html', kind: 'rename', reason: 'inside content/resources/applet/, which contains HTML or scripts' },
      // Folders keep their names, and a placeholder cannot hold a space.
      {
        path: 'content/resources/mis fotos/Año 1.png',
        kind: 'rename',
        reason: 'reference in content.xml cannot be expressed for content/resources/mis fotos/ano-1.png',
      },
    ]);
    expect(view(analysis, plan)).toContain(
      `<img src="${R}/foto-clase.jpg"><img src="${R}/mis fotos/Año 1.png"><img src="${R}/foto-ok.jpg"><a href="${CP}/custom/Mi Archivo.pdf">pdf</a>`,
    );
    expect(view(analysis, plan)).toContain(`<img src="${R}/foto-3.jpg"><img src="${R}/foto.jpg"><img src="${R}/foto-2.jpg"><a href="${R}/tema.pdf">1</a>`);
    expect(applyTextEdits(analysis.texts, plan.edits).get('index.html')).toContain(
      '<img src="content/resources/foto-clase.jpg"><img src="content/resources/mis%20fotos/A%C3%B1o%201.png">',
    );
    // Off: nothing changes.
    expect(normalize(analysis, { normalizeNames: false }).renamed).toEqual([]);
    // A copy merged into an identical file disappears instead of being renamed.
    const copies = await analyzeBytes(
      buildElpx({
        components: [{ html: `<a href="${R}/tema.pdf">a</a><a href="${R}/tema.pdf">b</a><a href="${R}/Copia de tema.pdf">c</a>` }],
        files: { 'content/resources/tema.pdf': '%PDF-1.4\nx', 'content/resources/Copia de tema.pdf': '%PDF-1.4\nx' },
      }),
    );
    const merged = normalize(copies, { deduplicate: true });
    expect(merged.merges.map((m) => [m.keep, m.remove])).toEqual([['content/resources/tema.pdf', ['content/resources/Copia de tema.pdf']]]);
    expect(merged.renamed).toEqual([]);
  });

  it('never gives a file a name that differs only in letter case from a name that stays', async () => {
    const files = { 'content/resources/Foto (2).jpg': png(1), 'content/resources/Foto.JPG': png(2) };
    const html = `<img src="${R}/Foto (2).jpg"><img src="${R}/Foto.JPG">`;
    // A file that keeps its name (here excluded) reserves it before clean names are handed out.
    const excluded = await analyzeBytes(buildElpx({ components: [{ html }], files }));
    const plan = normalize(excluded, { excluded: new Set(['content/resources/Foto.JPG']) });
    expect(plan.renamed).toEqual([{ from: 'content/resources/Foto (2).jpg', to: 'content/resources/foto-2.jpg', references: 1 }]);
    // A file whose rename is cancelled keeps its name: the rename that took the same name case-insensitively goes too.
    const cancelled = await analyzeBytes(buildElpx({ components: [{ html }], files: { ...files, 'index.html': page(`<img src="${R}/Foto.JPG">`) } }));
    const both = normalize(cancelled);
    expect(both.renamed).toEqual([]);
    expect(both.skipped).toEqual([
      {
        path: 'content/resources/Foto (2).jpg',
        kind: 'rename',
        reason: 'content/resources/foto.jpg would differ only in letter case from content/resources/Foto.JPG',
      },
      { path: 'content/resources/Foto.JPG', kind: 'rename', reason: 'reference in index.html cannot be expressed for content/resources/foto-2.jpg' },
    ]);
    // Names that already clash in the input are not a reason to cancel other changes.
    const clash = await analyzeBytes(
      buildElpx({
        components: [{ html: `<img src="${CP}/${P}/x.png"><img src="${R}/Mapa.png"><img src="${R}/mapa.png">` }],
        files: { [`content/resources/${P}/x.png`]: png(3), 'content/resources/Mapa.png': png(4), 'content/resources/mapa.png': png(5) },
      }),
    );
    expect(normalize(clash, { normalizeNames: false, flatten: true }).moves).toEqual([
      { from: `content/resources/${P}/x.png`, to: 'content/resources/x.png', references: 1 },
    ]);
  });

  it('cleans the final name of moved and converted files, and reports a failure under the first change', async () => {
    const analysis = await analyzeBytes(
      buildElpx({
        components: [
          {
            html:
              `<img src="${CP}/${P}/Foto Clase.JPG"><audio src="${R}/Mi Audio.wav"></audio>` +
              `<img src="${R}/Solo Nombre.png"><img src="${CP}/${P}/Mover Nombre.png"><audio src="${R}/Voz Mala.wav"></audio>`,
          },
        ],
        files: {
          // Published placeholders cannot follow any new name.
          'index.html': page(`<img src="${R}/Solo Nombre.png"><img src="${CP}/${P}/Mover Nombre.png"><audio src="${R}/Voz Mala.wav"></audio>`),
          [`content/resources/${P}/Foto Clase.JPG`]: png(1),
          'content/resources/Mi Audio.wav': fakeWav(100, 1),
          'content/resources/Solo Nombre.png': png(2),
          [`content/resources/${P}/Mover Nombre.png`]: png(3),
          'content/resources/Voz Mala.wav': fakeWav(100, 2),
        },
      }),
    );
    const plan = normalize(analysis, {
      flatten: true,
      convert: new Map([
        ['content/resources/Mi Audio.wav', 'mp3'],
        ['content/resources/Voz Mala.wav', 'mp3'],
      ]),
    });
    expect(plan.moves).toEqual([{ from: `content/resources/${P}/Foto Clase.JPG`, to: 'content/resources/foto-clase.jpg', references: 1 }]);
    expect(plan.conversions).toEqual([{ from: 'content/resources/Mi Audio.wav', to: 'content/resources/mi-audio.mp3', references: 1 }]);
    expect(plan.renamed).toEqual([]);
    expect(plan.skipped.map((s) => [s.path, s.kind])).toEqual([
      [`content/resources/${P}/Mover Nombre.png`, 'flatten'],
      ['content/resources/Solo Nombre.png', 'rename'],
      ['content/resources/Voz Mala.wav', 'convert'],
    ]);
    expect(view(analysis, plan)).toBe(
      `<img src="${R}/foto-clase.jpg"><audio src="${R}/mi-audio.mp3"></audio>` +
        `<img src="${R}/Solo Nombre.png"><img src="${CP}/${P}/Mover Nombre.png"><audio src="${R}/Voz Mala.wav"></audio>`,
    );
  });
});

interface Run {
  plan: OptimizationPlan;
  outcome: OptimizeOutcome;
  names: string[];
  texts: Map<string, string>;
}

/** Plans and optimizes with the fake platform (media off). */
async function run(input: Uint8Array, options: OptionsInput, tamper?: (b: Uint8Array) => Uint8Array): Promise<Run> {
  const analysis = await analyzeBytes(input);
  const platform = fakePlatform(tamper ? { tamper } : {});
  const plan = buildOptimizationPlan(
    analysis,
    normalizeOptions({ images: { enabled: false }, video: { enabled: false }, ...options }),
    await platform.engine.info(),
    NATIVE_LIMITS,
  );
  const outcome = await optimizeArchive(new MemoryByteSource(input), analysis, plan, platform, { outputName: 'out.elpx' });
  const zip = await openZip(outcome.output!, NATIVE_LIMITS);
  const texts = new Map<string, string>();
  for (const e of zip.entries) if (/\.(xml|html|js)$/.test(e.name)) texts.set(e.name, dec.decode(await readEntryBytes(zip, e, 1 << 24)));
  return { plan, outcome, names: zip.entries.map((e) => e.name), texts };
}

describe('normalizeNames: plan and execution', () => {
  it('plans rename operations with the manifest update, the risk and the rewrite reason', async () => {
    const analysis = await analyzeBytes(bytes);
    const plan = buildOptimizationPlan(
      analysis,
      normalizeOptions({ normalizeNames: 'slug', images: { enabled: false } }),
      await fakePlatform().engine.info(),
      NATIVE_LIMITS,
    );
    const renames = plan.operations.filter((o): o is Extract<PlanOperation, { op: 'rename-resource' }> => o.op === 'rename-resource');
    expect(renames.map((o) => [o.id, o.to, o.references])).toEqual([
      ['rename:content/resources/Copia de Foto Clase (2).JPG', 'content/resources/foto-clase.jpg', 2],
      ['rename:content/resources/Foto.JPG', 'content/resources/foto-3.jpg', 1],
      ['rename:content/resources/Sin Uso.txt', 'content/resources/sin-uso.txt', 0],
      ['rename:content/resources/Tema (1).pdf', 'content/resources/tema.pdf', 1],
      ['rename:content/resources/Tema (2).pdf', 'content/resources/tema-2.pdf', 1],
    ]);
    expect(renames[2]!.size).toBe(7);
    expect(plan.operations.some((o) => o.op === 'update-manifest')).toBe(true);
    expect(plan.risks).toContain('Files get clean names (lower case, no spaces, accents or copy markers) and their references are rewritten.');
    expect(plan.operations.filter((o) => o.op === 'rewrite-references').map((o) => [o.path, o.reason])).toEqual([
      ['content.xml', 'references to renamed files'],
      ['index.html', 'references to renamed files'],
    ]);
    expect(plan.skipped.filter((s) => s.kind === 'rename').map((s) => [s.path, s.reason])).toContainEqual(['content/resources/Diagrama Final.svg', 'kept']);
    expect(plan.estimate.savedBytes).toBe(0);
  });

  it('renames entries, rewrites references and the manifest, and counts renames as a benefit', async () => {
    const r = await run(bytes, { normalizeNames: 'slug' });
    expect(r.outcome.report.status).toBe('optimized');
    expect(r.outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
    expect(
      r.outcome.report.operations
        .filter((o) => o.op === 'rename-resource')
        .map((o) => o.detail)
        .slice(0, 3),
    ).toEqual([
      'renamed to content/resources/foto-clase.jpg; 2 references rewritten',
      'renamed to content/resources/foto-3.jpg; 1 reference rewritten',
      'renamed to content/resources/sin-uso.txt; 0 references rewritten',
    ]);
    expect(r.names).toEqual(
      expect.arrayContaining(['content/resources/foto-clase.jpg', 'content/resources/tema-2.pdf', 'custom/Mi Archivo.pdf', 'theme/Img Fondo.png']),
    );
    expect(r.names).not.toContain('content/resources/Foto.JPG');
    const manifest = parseManifest(r.texts.get('libs/elpx-manifest.js')!);
    if ('error' in manifest) throw new Error(manifest.error);
    expect(manifest.files).toContain('content/resources/foto-3.jpg');
    expect(r.texts.get('content.xml')).toContain(`<a href="${R}/tema.pdf">1</a><a href="${R}/tema-2.pdf">2</a>`);
    // Shorter names make a smaller package here; renames alone would still be delivered (structural change).
    expect(r.outcome.report.sizes.saved).toBeGreaterThan(0);
  });

  it('delivers renames even when the package does not get smaller', async () => {
    const input = buildElpx({ components: [{ html: `<img src="${R}/Foto Clase.png">` }], files: { 'content/resources/Foto Clase.png': png(1) } });
    // Pad the written archive with a ZIP comment up to the input size.
    const pad = (out: Uint8Array): Uint8Array => {
      const padded = new Uint8Array(Math.max(out.length, input.length));
      padded.set(out);
      new DataView(padded.buffer).setUint16(out.length - 2, padded.length - out.length, true);
      return padded;
    };
    const r = await run(input, { normalizeNames: 'slug' }, pad);
    expect(r.outcome.report.status).toBe('optimized');
    expect(r.outcome.report.output!.size).toBeGreaterThanOrEqual(input.length);
    expect(r.names).toContain('content/resources/foto-clase.png');
  });
});
