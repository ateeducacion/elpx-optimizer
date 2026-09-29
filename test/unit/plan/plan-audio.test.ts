import { describe, expect, it } from 'vitest';
import { buildOptimizationPlan, type OptimizationPlan, type PlanOperation } from '../../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../../src/core/plan/options.js';
import type { Analysis } from '../../../src/core/analyze/model.js';
import type { EngineInfo } from '../../../src/core/media/engine.js';
import { analyzeBytes, buildElpx, elpxFixture, limits } from '../../helpers/core-kit.js';
import { AUDIO_CAPS, MemoryStore, audioEngine, engineInfo, fakeAiff, fakeFlac, fakeM4a, fakeMp3, fakeWav } from '../../helpers/fake-platform.js';

/** Planning of audio re-encoding: decisions, renames verified by the restructuring, skips, manifest, estimate and risks. */

const R = '{{context_path}}/content/resources';
const AUDIO = 'content/resources/audio';

/** Analyzes with the fake audio engine (inputs probed by extension). */
function analyze(bytes: Uint8Array): Promise<Analysis> {
  const store = new MemoryStore();
  return analyzeBytes(bytes, { media: { engine: audioEngine(store), store } });
}

/** Plans with the given options and engine (audio-capable by default). */
function plan(analysis: Analysis, options: OptionsInput = {}, engine: EngineInfo = engineInfo({ audio: AUDIO_CAPS })): OptimizationPlan {
  return buildOptimizationPlan(analysis, normalizeOptions({ images: { enabled: false }, ...options }), engine, limits());
}

/** Audio operations as [path, to, conversions]. */
function audioOps(p: OptimizationPlan): [string, string | undefined, readonly string[]][] {
  return p.operations
    .filter((o): o is Extract<PlanOperation, { op: 'transcode-audio' }> => o.op === 'transcode-audio')
    .map((o) => [o.path, o.to, o.conversions]);
}

/** Audio skips as [path, reason, detail]. */
function audioSkips(p: OptimizationPlan): [string, string, string][] {
  return p.skipped.filter((s) => s.kind === 'audio').map((s) => [s.path, s.reason, s.detail]);
}

describe('buildOptimizationPlan: audio (audio-course.elpx)', () => {
  it('converts WAV, FLAC and AIFF to MP3 and re-encodes a high-bitrate MP3', async () => {
    const analysis = await analyze(elpxFixture('audio-course.elpx'));
    const p = plan(analysis);
    expect(audioOps(p)).toEqual([
      [`${AUDIO}/alta.mp3`, undefined, ['MP3 re-encoded from 320 to 128 kb/s (lossy)']],
      [`${AUDIO}/lectura.wav`, `${AUDIO}/lectura.mp3`, ['WAV (pcm_s16le) converted to MP3 at 128 kb/s (lossy); the file is renamed to .mp3']],
      [`${AUDIO}/musica.flac`, `${AUDIO}/musica.mp3`, ['FLAC (flac) converted to MP3 at 64 kb/s (lossy); the file is renamed to .mp3']],
      [`${AUDIO}/pista.aiff`, `${AUDIO}/pista.mp3`, ['AIFF (pcm_s16be) converted to MP3 at 64 kb/s (lossy); the file is renamed to .mp3']],
    ]);
    const lectura = p.operations.find((o) => o.id === `audio:${AUDIO}/lectura.wav`) as Extract<PlanOperation, { op: 'transcode-audio' }>;
    expect(lectura).toMatchObject({ size: entrySize(analysis, `${AUDIO}/lectura.wav`), lossy: true, estimatedBytes: 160_000 });
    expect(lectura.job).toMatchObject({ target: 'mp3', encoder: 'libmp3lame', rename: true, bitrateKbps: 128, expected: { duration: 10 } });
    // A file named from a script keeps its name, so it is not converted at all.
    expect(audioSkips(p)).toEqual([
      [
        `${AUDIO}/codigo.wav`,
        'kept',
        'Not converted: its references cannot follow a new name (uncertain references: possible reference in script or obfuscated data)',
      ],
    ]);
    expect(p.operations.filter((o) => o.op === 'rewrite-references').map((o) => [o.path, o.reason])).toEqual([
      ['content.xml', 'references to converted audio'],
      ['index.html', 'references to converted audio'],
      ['search_index.js', 'references to converted audio'],
    ]);
    // Renames change the file list: the download manifest is rewritten.
    expect(p.operations.some((o) => o.op === 'update-manifest')).toBe(true);
    expect(p.risks).toEqual([
      'Lossy re-encoding changes image, audio or video quality; originals are kept when a result is not valid or not smaller.',
      'WAV, AIFF and FLAC recordings become MP3 files with the .mp3 extension; their references are rewritten.',
    ]);
    // Estimate: size minus bitrate × duration for each job.
    const expected = p.operations
      .filter((o): o is Extract<PlanOperation, { op: 'transcode-audio' }> => o.op === 'transcode-audio')
      .reduce((sum, o) => sum + o.size - o.estimatedBytes!, 0);
    expect(p.estimate.savedBytes).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('reports why each file is left alone', async () => {
    const analysis = await analyze(elpxFixture('audio-course.elpx'));
    const disabled = plan(analysis, { audio: { enabled: false } });
    expect(audioOps(disabled)).toEqual([]);
    expect(audioSkips(disabled).map(([path, reason]) => [path.slice(AUDIO.length + 1), reason])).toEqual([
      ['alta.mp3', 'audio-disabled'],
      ['codigo.wav', 'audio-disabled'],
      ['lectura.wav', 'audio-disabled'],
      ['musica.flac', 'audio-disabled'],
      ['pista.aiff', 'audio-disabled'],
    ]);
    expect(disabled.operations.some((o) => o.op === 'update-manifest' || o.op === 'rewrite-references')).toBe(false);
    // Excluded files, an engine without audio, and a bitrate close to the target.
    const other = plan(analysis, { exclude: [`${AUDIO}/lectura.wav`], audio: { bitrate: 256 } }, engineInfo());
    expect(audioSkips(other).map(([path, reason, detail]) => [path.slice(AUDIO.length + 1), reason, detail])).toEqual([
      ['alta.mp3', 'engine-unavailable', 'This engine does not process audio'],
      ['codigo.wav', 'engine-unavailable', 'This engine does not process audio'],
      ['lectura.wav', 'excluded', 'Kept as original by request'],
      ['musica.flac', 'engine-unavailable', 'This engine does not process audio'],
      ['pista.aiff', 'engine-unavailable', 'This engine does not process audio'],
    ]);
    expect(audioSkips(plan(analysis, { audio: { bitrate: 256 } })).find(([path]) => path.endsWith('alta.mp3'))).toEqual([
      `${AUDIO}/alta.mp3`,
      'already-efficient',
      '320 kb/s is close to the 256 kb/s target',
    ]);
    // Forcing re-encodes it anyway; without a rename the manifest stays.
    const forced = plan(analysis, { audio: { bitrate: 256, force: true }, exclude: [`${AUDIO}/lectura.wav`, `${AUDIO}/musica.flac`, `${AUDIO}/pista.aiff`] });
    expect(audioOps(forced)).toEqual([[`${AUDIO}/alta.mp3`, undefined, ['MP3 re-encoded from 320 to 256 kb/s (lossy)']]]);
    expect(forced.operations.some((o) => o.op === 'update-manifest')).toBe(false);
    expect(forced.risks).toEqual(['Lossy re-encoding changes image, audio or video quality; originals are kept when a result is not valid or not smaller.']);
  });
});

/** Size of an inventory entry. */
function entrySize(a: Analysis, path: string): number {
  return a.result.entries.find((e) => e.path === path)!.size;
}

describe('buildOptimizationPlan: audio without a probe', () => {
  const bytes = buildElpx({
    components: [{ html: `<audio src="${R}/voz.wav"></audio><audio src="${R}/enorme.wav"></audio><audio src="${R}/voz.m4a"></audio>` }],
    files: {
      'content/resources/voz.wav': fakeWav(4000),
      'content/resources/enorme.wav': fakeWav(6000),
      'content/resources/voz.m4a': fakeM4a(3000),
    },
  });

  it('tells an unavailable engine, a file above the limit and a failed probe apart', async () => {
    const store = new MemoryStore();
    const engine = audioEngine(store);
    engine.probeInput = (r) => {
      if (r.name.endsWith('.wav')) throw new Error('Invalid data found when processing input');
      return { formatName: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 10, streams: [], chapters: 0, tags: {} };
    };
    // enorme.wav is above the probing limit.
    const small = limits({ maxVideoBytes: 5000 });
    const analysis = await analyzeBytes(bytes, { media: { engine, store }, limits: small });
    expect([...analysis.probes.keys()]).toEqual(['content/resources/voz.m4a']);
    expect(analysis.result.diagnostics.filter((d) => d.code === 'media-probe-failed').map((d) => d.resource)).toEqual(['content/resources/voz.wav']);
    const p = buildOptimizationPlan(analysis, normalizeOptions(), engineInfo({ audio: AUDIO_CAPS }), small);
    expect(audioSkips(p)).toEqual([
      ['content/resources/enorme.wav', 'exceeds-size-limit', 'File is larger than 5000 bytes'],
      ['content/resources/voz.m4a', 'no-audio-stream', 'No audio stream'],
      // The probe failed: said as such, not as an unsupported format.
      ['content/resources/voz.wav', 'not-probed', 'The audio file could not be inspected'],
    ]);
    // Without an audio engine nothing else is said.
    const off = buildOptimizationPlan(await analyzeBytes(bytes), normalizeOptions(), engineInfo({ audio: { available: false, encoders: [] } }), limits());
    expect(audioSkips(off)).toEqual([
      ['content/resources/enorme.wav', 'engine-unavailable', 'No audio engine'],
      ['content/resources/voz.m4a', 'engine-unavailable', 'No audio engine'],
      ['content/resources/voz.wav', 'engine-unavailable', 'No audio engine'],
    ]);
    expect(
      audioSkips(
        buildOptimizationPlan(
          await analyzeBytes(bytes),
          normalizeOptions(),
          engineInfo({ audio: { available: false, encoders: [], reason: 'no ffmpeg' } }),
          limits(),
        ),
      )[0],
    ).toEqual(['content/resources/enorme.wav', 'engine-unavailable', 'no ffmpeg']);
  });
});

describe('buildOptimizationPlan: audio renames', () => {
  it('picks free names, merges identical recordings first and leaves removed or runtime files alone', async () => {
    const bytes = buildElpx({
      components: [
        {
          html:
            `<audio src="${R}/tema.wav"></audio><audio src="${R}/tema.flac"></audio><audio src="${R}/Voz.WAV"></audio>` +
            `<audio src="${R}/copia-a.wav"></audio><audio src="${R}/copia-b.wav"></audio><audio src="${R}/alta.m4a"></audio>` +
            `<a href="${R}/voz.MP3">voz</a>`,
        },
      ],
      manifest: true,
      files: {
        'content/resources/tema.wav': fakeWav(4000, 1),
        'content/resources/tema.flac': fakeFlac(4000, 2),
        // An existing file already has the MP3 name (in another letter case).
        'content/resources/Voz.WAV': fakeWav(4000, 3),
        'content/resources/voz.MP3': fakeMp3(4000, 4),
        'content/resources/copia-a.wav': fakeWav(4000, 5),
        'content/resources/copia-b.wav': fakeWav(4000, 5),
        'content/resources/alta.m4a': fakeM4a(400_000, 6),
        'content/resources/sin-uso.aiff': fakeAiff(4000, 7),
        'theme/sonido.wav': fakeWav(4000, 8),
      },
    });
    const analysis = await analyze(bytes);
    expect(analysis.probes.has('theme/sonido.wav')).toBe(false);
    const p = plan(analysis, { deduplicate: 'exact', removeUnused: 'safe' });
    expect(audioOps(p).map(([path, to]) => [path, to])).toEqual([
      ['content/resources/Voz.WAV', 'content/resources/Voz_2.mp3'],
      ['content/resources/alta.m4a', undefined],
      // Only the kept copy of two identical recordings is converted.
      ['content/resources/copia-a.wav', 'content/resources/copia-a.mp3'],
      ['content/resources/tema.flac', 'content/resources/tema.mp3'],
      ['content/resources/tema.wav', 'content/resources/tema_2.mp3'],
      // A lossy file keeps its name and extension.
      ['content/resources/voz.MP3', undefined],
    ]);
    expect(p.operations.filter((o) => o.op === 'deduplicate').map((o) => [o.keep, o.remove])).toEqual([
      ['content/resources/copia-a.wav', ['content/resources/copia-b.wav']],
    ]);
    expect(p.operations.filter((o) => o.op === 'remove-unused').map((o) => o.path)).toEqual(['content/resources/sin-uso.aiff']);
    expect(p.operations.find((o) => o.op === 'rewrite-references')).toMatchObject({
      path: 'content.xml',
      reason: 'references to converted audio; references to removed duplicates',
    });
    expect(audioOps(p).find(([path]) => path.endsWith('alta.m4a'))![2]).toEqual(['AAC re-encoded from 256 to 128 kb/s (lossy)']);
  });
});
