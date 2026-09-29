import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../../src/adapters/node/platform.js';
import { MemoryByteSource } from '../../src/core/io/byte-source.js';
import { analyzeArchive } from '../../src/core/analyze/analyze.js';
import { buildOptimizationPlan } from '../../src/core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../src/core/plan/options.js';
import { optimizeArchive, type OptimizeOutcome } from '../../src/core/optimize/optimize.js';
import { openZip, readEntryBytes } from '../../src/core/zip/reader.js';
import { NATIVE_LIMITS } from '../../src/core/limits.js';
import { sha256Hex } from '../../src/core/io/hash.js';
import { dec, elpxFixture, upstream } from '../helpers/core-kit.js';
import { nativeVideoAvailable } from '../helpers/native.js';

const available = nativeVideoAvailable();
const work = mkdtempSync(join(tmpdir(), 'elpx-core-e2e-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Runs analyze → plan → optimize with the native platform on in-memory input. */
async function optimizeNative(bytes: Uint8Array, name: string, options: OptionsInput): Promise<{ outcome: OptimizeOutcome; output: Uint8Array | undefined }> {
  const platform = await createNodePlatform({ limits: NATIVE_LIMITS, outputPath: join(work, name), threads: 2 });
  const source = new MemoryByteSource(bytes);
  const analysis = await analyzeArchive(source, { limits: NATIVE_LIMITS, inputName: name, media: { engine: platform.engine, store: platform.store } });
  const plan = buildOptimizationPlan(analysis, normalizeOptions(options), await platform.engine.info(), NATIVE_LIMITS);
  const outcome = await optimizeArchive(source, analysis, plan, platform, { outputName: name });
  const output = outcome.output ? new Uint8Array(await outcome.output.read(0, outcome.output.size)) : undefined;
  await platform.lastOutput()?.discard();
  return { outcome, output };
}

/** Reads the text entries of an archive. */
async function texts(bytes: Uint8Array): Promise<Map<string, string>> {
  const archive = await openZip(new MemoryByteSource(bytes), NATIVE_LIMITS);
  const out = new Map<string, string>();
  for (const e of archive.entries) if (/\.(xml|html|js)$/.test(e.name)) out.set(e.name, dec.decode(await readEntryBytes(archive, e, 1 << 24)));
  return out;
}

describe.runIf(available)('optimizeArchive with the native platform', () => {
  it('optimizes the course fixture end to end and keeps every reference valid', async () => {
    const input = elpxFixture('course-video.elpx');
    const { outcome, output } = await optimizeNative(input, 'course.elpx', { removeUnused: 'safe', deduplicate: 'exact', video: { x264Preset: 'veryfast' } });
    const report = outcome.report;
    expect(report.status).toBe('optimized');
    expect(report.validations.filter((v) => !v.ok)).toEqual([]);
    expect(report.sizes.saved).toBeGreaterThan(input.length / 2);
    const applied = report.operations.filter((o) => o.status === 'applied').map((o) => o.id);
    expect(applied).toEqual(
      expect.arrayContaining([
        'video:content/resources/media/clase 1.mp4',
        'remove:content/resources/sin-uso/viejo.webp',
        'dedup:content/resources/fotos/foto&paisaje.jpg',
        'manifest:libs/elpx-manifest.js',
      ]),
    );
    expect(report.operations.find((o) => o.op === 'transcode-video')?.checks).toEqual([
      'streams, duration and size match the plan',
      'full decode without errors',
    ]);
    const t = await texts(output!);
    expect(t.get('content.xml')).not.toContain('copia-foto.jpg');
    expect(t.get('html/juego.html')).not.toContain('copia-foto.jpg');
    expect(t.get('search_index.js')).not.toContain('copia-foto.jpg');
    expect(t.get('libs/elpx-manifest.js')).not.toContain('viejo.webp');
    // The re-analysis of the delivered file has no new problems.
    const after = await analyzeArchive(new MemoryByteSource(output!), { limits: NATIVE_LIMITS });
    expect(after.result.ok).toBe(true);
    expect(after.result.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'fatal')).toEqual([]);
  });

  it('delivers a byte-identical copy of an already efficient package', async () => {
    const input = elpxFixture('efficient.elpx');
    const { outcome, output } = await optimizeNative(input, 'efficient.elpx', { removeUnused: 'safe', deduplicate: 'exact' });
    expect(outcome.report.status).toBe('no-improvement');
    expect(output).toEqual(input);
    expect(outcome.report.output?.sha256).toBe(sha256Hex(input));
    expect(outcome.report.validations.find((v) => v.name === 'no-improvement-copy')?.ok).toBe(true);
    expect(outcome.report.operations.every((o) => o.status !== 'applied')).toBe(true);
  });

  it('recompresses the images of a real v4 export without breaking it', async () => {
    const input = upstream('un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx');
    const { outcome, output } = await optimizeNative(input, 'real.elpx', { preset: 'aggressive', images: { force: true } });
    expect(['optimized', 'no-improvement']).toContain(outcome.report.status);
    expect(outcome.report.validations.filter((v) => !v.ok)).toEqual([]);
    const delivered = output ?? readFileSync(join(work, 'real.elpx'));
    const after = await analyzeArchive(new MemoryByteSource(delivered), { limits: NATIVE_LIMITS });
    expect(after.result.package).toMatchObject({ variant: 'v4', pages: 14, components: 13 });
  });
});
