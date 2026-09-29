import { describe, expect, it } from 'vitest';
import { planRestructure, type RestructureOptions, type RestructurePlan } from '../../../src/core/refs/restructure.js';
import { applyTextEdits } from '../../../src/core/refs/rewrite.js';
import type { Analysis, ReferenceInternal } from '../../../src/core/analyze/model.js';
import { analyzeBytes, buildElpx, odeXml, page } from '../../helpers/core-kit.js';
import { fakeAiff, fakeFlac, fakeMp3, fakeWav } from '../../helpers/fake-platform.js';
import { restructurePlan } from '../../../src/core/plan/plan.js';
import { normalizeOptions } from '../../../src/core/plan/options.js';

/** Format conversions in the restructuring planner: renamed files, followed references and updated `type` attributes. */

const CP = '{{context_path}}';
const R = `${CP}/content/resources`;
const P = '20240101120000PPPPPP';
const Q = '20240101120000QQQQQQ';

/** Plans conversions to MP3 of the given files (other features off unless patched). */
function convert(analysis: Analysis, files: readonly string[] | ReadonlyMap<string, string>, patch: Partial<RestructureOptions> = {}): RestructurePlan {
  const map = files instanceof Map ? files : new Map((files as readonly string[]).map((f) => [f, 'mp3']));
  return planRestructure(analysis, {
    deduplicate: false,
    flatten: false,
    removeMissing: false,
    excluded: new Set(),
    removed: new Set(),
    convert: map,
    ...patch,
  });
}

/** The package texts after applying a plan's edits. */
function edited(analysis: Analysis, plan: RestructurePlan): Map<string, string> {
  return applyTextEdits(analysis.texts, plan.edits);
}

/** The htmlView of the first component. */
function htmlView(xml: string): string {
  return /<htmlView><!\[CDATA\[([\s\S]*?)\]\]><\/htmlView>/.exec(xml)![1]!;
}

describe('convert: renamed files and their references', () => {
  const html = [
    `<audio controls src="${R}/a.wav" type="audio/wav"></audio>`,
    `<audio controls><source src="${R}/b.flac" type="audio/x-flac; codecs=flac"></audio>`,
    // Types that already fit the new format are kept.
    `<audio src="${R}/c.aiff" type="audio/mpeg"></audio><audio src="${R}/d.wav" type=" Audio/MP3 "></audio>`,
    `<a href="${R}/e.wav">e</a>`,
    // Two references in one element: one type update.
    `<audio src="${R}/g.wav" data-fallback="${R}/g.wav" type="audio/wav"></audio>`,
    `<div class="adivina-DataGame js-hidden">{"audio":"${R}/a.wav"}</div>`,
  ].join('');
  const bytes = buildElpx({
    components: [{ html }],
    files: {
      'index.html': page('<audio src="content/resources/a.wav" type="audio/wav"></audio>'),
      'content/resources/a.wav': fakeWav(100, 1),
      // Already taken in another letter case.
      'content/resources/A.mp3': fakeMp3(100, 2),
      'content/resources/b.flac': fakeFlac(100, 3),
      'content/resources/c.aiff': fakeAiff(100, 4),
      'content/resources/d.wav': fakeWav(100, 5),
      'content/resources/e.wav': fakeWav(100, 6),
      'content/resources/g.wav': fakeWav(100, 7),
    },
  });

  it('gives each file a free name with the new extension and rewrites every reference and stale type', async () => {
    const analysis = await analyzeBytes(bytes);
    const plan = convert(
      analysis,
      ['a.wav', 'b.flac', 'c.aiff', 'd.wav', 'e.wav', 'g.wav'].map((f) => `content/resources/${f}`),
    );
    expect(plan.conversions).toEqual([
      { from: 'content/resources/a.wav', to: 'content/resources/a_2.mp3', references: 3 },
      { from: 'content/resources/b.flac', to: 'content/resources/b.mp3', references: 1 },
      { from: 'content/resources/c.aiff', to: 'content/resources/c.mp3', references: 1 },
      { from: 'content/resources/d.wav', to: 'content/resources/d.mp3', references: 1 },
      { from: 'content/resources/e.wav', to: 'content/resources/e.mp3', references: 1 },
      { from: 'content/resources/g.wav', to: 'content/resources/g.mp3', references: 2 },
    ]);
    expect(plan.moves).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect([...plan.renames]).toEqual(plan.conversions.map((c) => [c.from, c.to]));
    const texts = edited(analysis, plan);
    expect(htmlView(texts.get('content.xml')!)).toBe(
      [
        `<audio controls src="${R}/a_2.mp3" type="audio/mpeg"></audio>`,
        `<audio controls><source src="${R}/b.mp3" type="audio/mpeg"></audio>`,
        `<audio src="${R}/c.mp3" type="audio/mpeg"></audio><audio src="${R}/d.mp3" type=" Audio/MP3 "></audio>`,
        `<a href="${R}/e.mp3">e</a>`,
        `<audio src="${R}/g.mp3" data-fallback="${R}/g.mp3" type="audio/mpeg"></audio>`,
        `<div class="adivina-DataGame js-hidden">{"audio":"${R}/a_2.mp3"}</div>`,
      ].join(''),
    );
    expect(texts.get('index.html')).toContain('<audio src="content/resources/a_2.mp3" type="audio/mpeg"></audio>');
  });

  it('writes the type of each target format, and none for formats it does not know', async () => {
    const analysis = await analyzeBytes(bytes);
    const plan = convert(
      analysis,
      new Map([
        ['content/resources/a.wav', 'm4a'],
        ['content/resources/b.flac', 'bin'],
      ]),
    );
    expect(plan.conversions.map((c) => c.to)).toEqual(['content/resources/a.m4a', 'content/resources/b.bin']);
    const view = htmlView(edited(analysis, plan).get('content.xml')!);
    expect(view).toContain(`<audio controls src="${R}/a.m4a" type="audio/mp4"></audio>`);
    expect(view).toContain(`<source src="${R}/b.bin" type="audio/x-flac; codecs=flac">`);
  });

  it('ignores removed, unknown and merged files, and refuses excluded or uncertain ones', async () => {
    const analysis = await analyzeBytes(
      buildElpx({
        components: [
          {
            html:
              `<audio src="${R}/uno.wav"></audio><audio src="${R}/dos.wav"></audio><audio src="${R}/excluida.wav"></audio>` +
              `<script>var s = "content/resources/codigo.wav";</script><audio src="${R}/sonido"></audio>`,
          },
        ],
        files: {
          'content/resources/uno.wav': fakeWav(100, 1),
          'content/resources/dos.wav': fakeWav(100, 1),
          'content/resources/borrada.wav': fakeWav(100, 2),
          'content/resources/excluida.wav': fakeWav(100, 3),
          'content/resources/codigo.wav': fakeWav(100, 4),
          'content/resources/sonido': fakeWav(100, 5),
          // Unreferenced: converted without anything to rewrite.
          'content/resources/huerfano.wav': fakeWav(100, 6),
        },
      }),
    );
    const files = ['uno.wav', 'dos.wav', 'borrada.wav', 'excluida.wav', 'codigo.wav', 'sonido', 'huerfano.wav', 'no-existe.wav'].map(
      (f) => `content/resources/${f}`,
    );
    const plan = convert(analysis, files, {
      deduplicate: true,
      removed: new Set(['content/resources/borrada.wav']),
      excluded: new Set(['content/resources/excluida.wav']),
    });
    // The duplicate follows the kept copy to its new name; a file without an extension gets one.
    expect(plan.merges).toEqual([{ keep: 'content/resources/dos.wav', remove: ['content/resources/uno.wav'], rewritten: { 'content/resources/uno.wav': 1 } }]);
    expect(plan.conversions).toEqual([
      { from: 'content/resources/dos.wav', to: 'content/resources/dos.mp3', references: 1 },
      { from: 'content/resources/huerfano.wav', to: 'content/resources/huerfano.mp3', references: 0 },
      { from: 'content/resources/sonido', to: 'content/resources/sonido.mp3', references: 1 },
    ]);
    expect(plan.skipped).toEqual([
      { path: 'content/resources/codigo.wav', kind: 'convert', reason: 'uncertain references: possible reference in script or obfuscated data' },
      { path: 'content/resources/excluida.wav', kind: 'convert', reason: 'excluded by the user' },
    ]);
    expect(htmlView(edited(analysis, plan).get('content.xml')!)).toContain(`<audio src="${R}/dos.mp3"></audio><audio src="${R}/dos.mp3"></audio>`);
  });
});

describe('convert: with flattening', () => {
  it('moves converted files out of editor folders and reports them as conversions', async () => {
    const analysis = await analyzeBytes(
      buildElpx({
        components: [
          { html: `<audio src="${CP}/${P}/voz.wav" type="audio/wav"></audio><img src="${CP}/${P}/foto.png"><audio src="${R}/${Q}/voz.wav"></audio>` },
        ],
        files: {
          [`content/resources/${P}/voz.wav`]: fakeWav(100, 1),
          [`content/resources/${P}/foto.png`]: fakeWav(100, 2),
          // Another recording with the same name.
          [`content/resources/${Q}/voz.wav`]: fakeWav(100, 3),
        },
      }),
    );
    const plan = convert(analysis, [`content/resources/${P}/voz.wav`, `content/resources/${Q}/voz.wav`], { flatten: true });
    expect(plan.moves).toEqual([{ from: `content/resources/${P}/foto.png`, to: 'content/resources/foto.png', references: 1 }]);
    expect(plan.conversions).toEqual([
      { from: `content/resources/${P}/voz.wav`, to: 'content/resources/voz.mp3', references: 1 },
      { from: `content/resources/${Q}/voz.wav`, to: 'content/resources/voz_2.mp3', references: 1 },
    ]);
    expect(plan.emptiedDirectories).toEqual([]);
    expect(htmlView(edited(analysis, plan).get('content.xml')!)).toBe(
      `<audio src="${R}/voz.mp3" type="audio/mpeg"></audio><img src="${R}/foto.png"><audio src="${R}/voz_2.mp3"></audio>`,
    );
  });

  it('keeps a file, and the copies merged into it, when its new name cannot be used', async () => {
    const analysis = await analyzeBytes(
      buildElpx({
        components: [{ html: `<audio src="${CP}/${P}/voz.wav"></audio><audio src="${CP}/${Q}/voz.wav"></audio>` }],
        files: {
          // A published page with a placeholder cannot be rewritten for a new path.
          'index.html': page(`<audio src="${CP}/${P}/voz.wav"></audio>`),
          [`content/resources/${P}/voz.wav`]: fakeWav(100, 1),
          [`content/resources/${Q}/voz.wav`]: fakeWav(100, 1),
        },
      }),
    );
    const plan = convert(analysis, [`content/resources/${P}/voz.wav`, `content/resources/${Q}/voz.wav`], { flatten: true });
    expect(plan.skipped).toEqual([
      { path: `content/resources/${P}/voz.wav`, kind: 'convert', reason: 'reference in index.html cannot be expressed for content/resources/voz.mp3' },
      { path: `content/resources/${Q}/voz.wav`, kind: 'flatten', reason: `identical to content/resources/${P}/voz.wav, which stays in place` },
    ]);
    expect(plan.conversions).toEqual([]);
    expect(plan.merges).toEqual([]);
    expect(plan.edits.size).toBe(0);
  });
});

describe('convert: type attributes that cannot be updated', () => {
  it('refuses a conversion when a stale type has no editable span', async () => {
    const analysis = await analyzeBytes(
      buildElpx({ components: [{ html: `<audio src="${R}/a.wav" type="audio/wav"></audio>` }], files: { 'content/resources/a.wav': fakeWav(100) } }),
    );
    const ref = analysis.references.find((x) => x.value === `${R}/a.wav`)!;
    const { typeSpan: _typeSpan, ...noSpan } = ref.element!;
    const patched: Analysis = { ...analysis, references: analysis.references.map((x): ReferenceInternal => (x === ref ? { ...x, element: noSpan } : x)) };
    expect(convert(patched, ['content/resources/a.wav']).skipped).toEqual([
      { path: 'content/resources/a.wav', kind: 'convert', reason: 'a audio declares type="audio/wav", which cannot be updated' },
    ]);
    // With the span, the same analysis converts.
    expect(convert(analysis, ['content/resources/a.wav']).conversions).toHaveLength(1);
  });

  it('cancels the conversion when the type edit cannot be written in its encoding', async () => {
    // A CDATA boundary inside the type value: the reference can be rewritten, the type cannot.
    const xml = odeXml({ components: [{ html: `<audio src="${R}/a.wav" type="audio/w@@SPLIT@@av"></audio>` }] }).replace('@@SPLIT@@', ']]><![CDATA[');
    const analysis = await analyzeBytes(buildElpx({ contentXml: xml, files: { 'content/resources/a.wav': fakeWav(100) } }));
    expect(analysis.references.find((x) => x.value === `${R}/a.wav`)?.element?.typeSpan).toBeDefined();
    const plan = convert(analysis, ['content/resources/a.wav']);
    expect(plan.skipped).toEqual([{ path: 'content/resources/a.wav', kind: 'convert', reason: 'the type attribute in content.xml cannot be updated' }]);
    expect(plan.conversions).toEqual([]);
    expect(plan.edits.size).toBe(0);
    // Without a location the reason still reads.
    const ref = analysis.references.find((x) => x.value === `${R}/a.wav`)!;
    const nowhere: Analysis = { ...analysis, references: analysis.references.map((x) => (x === ref ? { ...x, location: {} } : x)) };
    expect(convert(nowhere, ['content/resources/a.wav']).skipped[0]?.reason).toBe('the type attribute in ? cannot be updated');
  });
});

describe('convert: verification of the new names', () => {
  it('cancels a conversion whose new name would capture another reference, without renaming the others again', async () => {
    const analysis = await analyzeBytes(
      buildElpx({
        components: [{ html: `<audio src="${R}/tema.flac"></audio><audio src="${R}/tema.wav"></audio><a href="${R}/tema.mp3">tema</a>` }],
        files: { 'content/resources/tema.flac': fakeFlac(100, 1), 'content/resources/tema.wav': fakeWav(100, 2) },
      }),
    );
    expect(analysis.references.find((x) => x.value === `${R}/tema.mp3`)?.status).toBe('missing');
    const plan = convert(analysis, ['content/resources/tema.flac', 'content/resources/tema.wav']);
    expect(plan.skipped).toEqual([{ path: 'content/resources/tema.flac', kind: 'convert', reason: `would change how "${R}/tema.mp3" resolves` }]);
    // Names are chosen once: the WAV keeps the suffixed name it got next to the FLAC.
    expect(plan.conversions).toEqual([{ from: 'content/resources/tema.wav', to: 'content/resources/tema_2.mp3', references: 1 }]);
    // Alone, the WAV would take the plain name and meet the same check.
    expect(convert(analysis, ['content/resources/tema.wav']).skipped).toEqual([
      { path: 'content/resources/tema.wav', kind: 'convert', reason: `would change how "${R}/tema.mp3" resolves` },
    ]);
  });
});

describe('convert: names planned earlier', () => {
  it('keeps the planned name of each conversion, and only moves it on when that name is taken', async () => {
    const analysis = await analyzeBytes(
      buildElpx({
        components: [{ html: `<audio src="${R}/tema.flac"></audio><audio src="${R}/tema.wav"></audio><a href="${R}/otro.mp3">otro</a>` }],
        files: {
          'content/resources/tema.flac': fakeFlac(100, 1),
          'content/resources/tema.wav': fakeWav(100, 2),
          'content/resources/otro.mp3': fakeMp3(100, 3),
        },
      }),
    );
    // At execution only tema.wav was converted; the plan had named it tema_2.mp3 (tema.flac held tema.mp3).
    expect(convert(analysis, ['content/resources/tema.wav']).conversions[0]!.to).toBe('content/resources/tema.mp3');
    const kept = convert(analysis, ['content/resources/tema.wav'], { convertNames: new Map([['content/resources/tema.wav', 'content/resources/tema_2.mp3']]) });
    expect(kept.conversions).toEqual([{ from: 'content/resources/tema.wav', to: 'content/resources/tema_2.mp3', references: 1 }]);
    const taken = convert(analysis, ['content/resources/tema.wav'], { convertNames: new Map([['content/resources/tema.wav', 'content/resources/otro.mp3']]) });
    expect(taken.conversions[0]!.to).toBe('content/resources/otro_2.mp3');
  });

  it('leaves frozen files exactly as they are: no move and no clean name', async () => {
    const analysis = await analyzeBytes(
      buildElpx({
        components: [{ html: `<audio src="${CP}/${P}/Voz Uno.wav"></audio><img src="${CP}/${P}/Foto Uno.png"><a href="${R}/Otro Nombre.pdf">pdf</a>` }],
        files: {
          [`content/resources/${P}/Voz Uno.wav`]: fakeWav(100, 1),
          [`content/resources/${P}/Foto Uno.png`]: fakeWav(100, 2),
          'content/resources/Otro Nombre.pdf': '%PDF-1.4\n',
        },
      }),
    );
    const options = normalizeOptions({ flatten: 'legacy', normalizeNames: 'slug' });
    const all = restructurePlan(analysis, options, new Set());
    expect(Object.fromEntries(all.renames)).toEqual({
      'content/resources/Otro Nombre.pdf': 'content/resources/otro-nombre.pdf',
      [`content/resources/${P}/Foto Uno.png`]: 'content/resources/foto-uno.png',
      [`content/resources/${P}/Voz Uno.wav`]: 'content/resources/voz-uno.wav',
    });
    // A file whose planned conversion did not happen is frozen: the plan showed no other change for it.
    const frozen = restructurePlan(
      analysis,
      options,
      new Set(),
      new Map(),
      undefined,
      new Set([`content/resources/${P}/Voz Uno.wav`, 'content/resources/Otro Nombre.pdf']),
    );
    expect(Object.fromEntries(frozen.renames)).toEqual({ [`content/resources/${P}/Foto Uno.png`]: 'content/resources/foto-uno.png' });
    expect(frozen.skipped).toEqual([]);
    expect(frozen.emptiedDirectories).toEqual([]);
  });
});
