import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderInspect } from '../../../src/cli/commands/inspect.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { AnalysisResult, InventoryEntry } from '../../../src/core/analyze/model.js';
import type { Diagnostic } from '../../../src/core/diagnostics.js';
import { ELPX, removeDir, runCli, singleJson, tempDir, UPSTREAM, V3_FIXTURE } from '../../helpers/cli.js';
import { configureLocalTools, nativeVideoAvailable } from '../../helpers/native.js';

const video = nativeVideoAvailable();
const COURSE = join(ELPX, 'course-video.elpx');
const BROKEN = join(ELPX, 'broken-refs.elpx');
const EFFICIENT = join(ELPX, 'efficient.elpx');
const LEGACY = join(UPSTREAM, 'verdaderofalso.elp');
let dir: string;
let notZip: string;
let corrupt: string;

beforeAll(async () => {
  configureLocalTools();
  dir = await tempDir('elpx-inspect-');
  notZip = join(dir, 'not a zip.elpx');
  await writeFile(notZip, 'this is plain text, not a ZIP archive\n');
  corrupt = join(dir, 'corrupt.elpx');
  const bytes = await readFile(EFFICIENT);
  await writeFile(corrupt, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
});
afterAll(async () => {
  await removeDir(dir);
});

interface AnalysisJson {
  schema: string;
  ok: boolean;
  package?: { variant: string; title?: string };
  entries: { path: string; video?: { videoCodec?: string }; image?: unknown }[];
  references: unknown[];
  diagnostics: { code: string; severity: string }[];
  media: { probed: boolean; note?: string };
}

describe('inspect', () => {
  it('prints a human summary of a v4 project', async () => {
    const r = await runCli(['inspect', COURSE]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(/^course-video\.elpx — 2\.8 MiB \(sha256 [0-9a-f]{12}…\)\n/);
    expect(r.stdout).toContain('eXeLearning v4 project: "Curso con vídeo" — 2 pages, 5 iDevices');
    expect(r.stdout).toContain('Largest resources:');
    expect(r.stdout).toMatch(/png\s+uncertain\s+content\/resources\/juego\/secreto\.png 64x48 animated/);
    expect(r.stdout).toMatch(/jpeg\s+used\s+content\/resources\/fotos\/foto&paisaje\.jpg 320x240 q≈98/);
    expect(r.stdout).toContain('Usage: 9 used, 1 uncertain, 1 unreferenced');
    expect(r.stdout).toContain('Duplicates: 2 groups of identical files');
    expect(r.stdout).toMatch(/Diagnostics: 0 errors, 0 warnings, \d+ info\n$/);
    expect(r.stderr).toContain('Reading input\n');
    if (video) expect(r.stdout).toMatch(/clase 1\.mp4 h264 640x360 4\.0 s, audio aac/);
  });

  it('prints exactly one JSON document and no progress with --json', async () => {
    const r = await runCli(['inspect', COURSE, '--json']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stderr).toBe('');
    const analysis = singleJson<AnalysisJson>(r.stdout);
    expect(analysis.schema).toBe('elpx-optimizer/analysis');
    expect(analysis.ok).toBe(true);
    expect(analysis.package?.variant).toBe('v4');
    expect(analysis.references.length).toBeGreaterThan(0);
    expect(analysis.media.probed).toBe(video);
  });

  it('keeps progress on stderr in an interactive terminal, even with --json', async () => {
    const r = await runCli(['inspect', COURSE, '--json'], { interactive: true });
    expect(r.stderr).toContain('Reading input\n');
    expect(singleJson<AnalysisJson>(r.stdout).ok).toBe(true);
    const quiet = await runCli(['inspect', COURSE, '--quiet'], { interactive: true });
    expect(quiet.stderr).toBe('');
  });

  it('omits references and skips ffprobe on request', async () => {
    const r = await runCli(['inspect', COURSE, '--json', '--no-references', '--no-probe']);
    const analysis = singleJson<AnalysisJson>(r.stdout);
    expect(analysis.references).toEqual([]);
    expect(analysis.media.probed).toBe(false);
    expect(analysis.entries.find((e) => e.path.endsWith('.mp4'))?.video).toBeUndefined();
  });

  it('explains when videos cannot be probed', async () => {
    const r = await runCli(['inspect', COURSE, '--ffprobe', '/nonexistent/ffprobe', '--ffmpeg', '/nonexistent/ffmpeg']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(/\nMedia: .+\n/);
  });

  it('describes a v3.0-era project', async () => {
    const r = await runCli(['inspect', V3_FIXTURE]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toContain('eXeLearning v3.0-era project: "Un contenido de ejemplo para probar estilos y catalogación" — 14 pages, 13 iDevices');
    const json = singleJson<AnalysisJson>((await runCli(['inspect', V3_FIXTURE, '--json'])).stdout);
    expect(json.package?.variant).not.toBe('v4');
  });

  it('lists errors and warnings with their location', async () => {
    const r = await runCli(['inspect', BROKEN]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(/Diagnostics: 4 errors, \d+ warnings, \d+ info/);
    expect(r.stdout).toMatch(/ {2}✗ \[missing-resource\] Missing resource ".+" \(content\.xml › page ".+"/);
    expect(r.stdout).toMatch(/ {2}! \[[a-z-]+\] /);
  });

  it.each([
    ['not a ZIP', () => notZip, /✗ The file is not a ZIP archive/],
    ['a legacy .elp', () => LEGACY, /✗ This is a legacy eXeLearning/],
    ['a truncated ZIP', () => corrupt, /✗ /],
  ])('exits 3 for %s', async (_label, file, message) => {
    const r = await runCli(['inspect', file()]);
    expect(r.code).toBe(EXIT.INVALID_INPUT);
    expect(r.stdout).toMatch(message);
    const json = singleJson<AnalysisJson>((await runCli(['inspect', file(), '--json'])).stdout);
    expect(json.ok).toBe(false);
    expect(json.diagnostics.some((d) => d.severity === 'fatal')).toBe(true);
  });

  it('enforces --max-archive-size', async () => {
    const r = await runCli(['inspect', COURSE, '--max-archive-size', '1000', '--json']);
    expect(r.code).toBe(EXIT.INVALID_INPUT);
    expect((await runCli(['inspect', COURSE, '--max-archive-size', 'big'])).code).toBe(EXIT.USAGE);
  });

  it('works with relative paths, spaces and non-ASCII names from another cwd', async () => {
    await copyFile(COURSE, join(dir, 'curso de año ñ.elpx'));
    const r = await runCli(['inspect', 'curso de año ñ.elpx', '--json', '--no-probe'], { cwd: dir });
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(singleJson<{ input: { name: string } }>(r.stdout).input.name).toBe('curso de año ñ.elpx');
  });
});

describe('renderInspect', () => {
  const entry = (over: Partial<InventoryEntry>): InventoryEntry => ({
    path: 'content/resources/x',
    isDirectory: false,
    size: 100,
    compressedSize: 100,
    method: 'stored',
    role: 'user-asset',
    kind: 'image',
    format: 'png',
    mime: 'image/png',
    usage: 'used',
    usageReasons: [],
    references: 1,
    referencedFrom: [],
    representations: [],
    resolutionSensitive: false,
    ...over,
  });
  const diagnostic = (over: Partial<Diagnostic>): Diagnostic =>
    ({ code: 'c', severity: 'warning', category: 'reference', message: 'm', repairable: false, ...over }) as Diagnostic;
  const result = (over: Partial<AnalysisResult>): AnalysisResult => ({
    schema: 'elpx-optimizer/analysis',
    schemaVersion: 1,
    tool: { name: 'elpx-optimizer', version: '0', upstream: 'x' },
    input: { name: 'p.elpx', size: 2048, sha256: 'a'.repeat(64) },
    ok: true,
    package: {
      variant: 'v3',
      hasDoctype: false,
      pages: 1,
      components: 0,
      ideviceTypes: {},
      hasScreenshot: false,
      hasManifest: false,
      hasSearchIndex: false,
      hasPublishedHtml: false,
      legacyFolders: { folders: 0, files: 0 },
    },
    totals: { entries: 0, files: 0, uncompressedBytes: 0, userAssetBytes: 0, imageBytes: 0, videoBytes: 0, audioBytes: 0 },
    entries: [],
    references: [],
    duplicates: [],
    diagnostics: [],
    media: { probed: false },
    ...over,
  });

  it('handles a project without user resources or title', () => {
    const text = renderInspect(result({}));
    expect(text).toContain('eXeLearning v3.0-era project — 1 pages, 0 iDevices\n');
    expect(text).toContain('Usage: no user resources\n');
    expect(text).not.toContain('Largest resources');
    expect(text).not.toContain('Duplicates');
    expect(text).toMatch(/Diagnostics: 0 errors, 0 warnings, 0 info\n$/);
  });

  it('marks unknown media properties with "?"', () => {
    const text = renderInspect(
      result({
        entries: [
          entry({ path: 'v.mp4', format: 'mp4', kind: 'video', size: 300, video: { container: 'mp4', audio: [], subtitles: 0, chapters: 0, otherStreams: 0 } }),
          entry({ path: 'i.png', size: 200, image: { animated: false, hasIcc: false, hasExif: false, hasXmp: false } }),
          entry({ path: 'a.mp3', format: 'mp3', kind: 'audio', size: 100 }),
          entry({ path: 'index.html', role: 'page', usage: 'not-applicable' }),
        ],
        media: { probed: false, note: 'ffprobe not found' },
      }),
    );
    expect(text).toMatch(/v\.mp4 \? \?x\? \? s, audio none\n/);
    expect(text).toMatch(/i\.png \?x\?\n/);
    expect(text).toMatch(/a\.mp3\n/);
    expect(text).not.toContain('index.html');
    expect(text).toContain('Usage: 3 used\n');
    expect(text).toContain('Media: ffprobe not found\n');
  });

  it('shows at most 15 resources and 20 diagnostics, with partial locations', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry({ path: `r${i}.png`, size: 1000 + i }));
    const diagnostics = [
      ...Array.from({ length: 25 }, (_, i) => diagnostic({ code: `w${i}`, severity: 'warning' })),
      diagnostic({ code: 'info-only', severity: 'info' }),
    ];
    const text = renderInspect(result({ entries, diagnostics }));
    expect(text.match(/ r\d+\.png/g)).toHaveLength(15);
    expect(text).toContain(' r19.png');
    expect(text).not.toContain(' r4.png');
    expect(text.match(/ {2}! \[w\d+\]/g)).toHaveLength(20);
    const located = renderInspect(
      result({
        diagnostics: [
          diagnostic({ code: 'a', severity: 'error', location: { entry: 'content.xml', ideviceType: 'text', field: 'html', jsonPath: '$.x' } }),
          diagnostic({ code: 'b', location: { ideviceType: 'quiz', ideviceId: 'id1' } }),
          diagnostic({ code: 'c', location: {} }),
        ],
      }),
    );
    expect(located).toContain('  ✗ [a] m (content.xml › text › html › $.x)\n');
    expect(located).toContain('  ! [b] m (quiz id1)\n');
    expect(located).toContain('  ! [c] m\n');
  });

  it('lists only fatal diagnostics for unusable input', () => {
    const text = renderInspect(result({ ok: false, diagnostics: [diagnostic({ severity: 'fatal', message: 'broken' }), diagnostic({ message: 'noise' })] }));
    expect(text).toBe(`p.elpx — 2.0 KiB (sha256 aaaaaaaaaaaa…)\n✗ broken\n`);
  });
});

interface ValidationJson {
  schema: string;
  verdict: string;
  checks: { name: string; ok: boolean }[];
}

describe('validate', () => {
  it('exits 0 for a valid project', async () => {
    const r = await runCli(['validate', EFFICIENT], { signal: new AbortController().signal });
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(/^efficient\.elpx: valid\n {2}✓ zip-structure: /);
    expect(r.stderr).toBe('');
  });

  it('allows warnings unless --strict', async () => {
    expect((await runCli(['validate', V3_FIXTURE])).code).toBe(EXIT.SUCCESS);
    const strict = await runCli(['validate', V3_FIXTURE, '--strict', '--json']);
    expect(strict.code).toBe(EXIT.PARTIAL);
    expect(singleJson<ValidationJson>(strict.stdout).verdict).toBe('valid-with-warnings');
  });

  it('exits 4 and lists the problems of a project with missing resources', async () => {
    const r = await runCli(['validate', BROKEN]);
    expect(r.code).toBe(EXIT.PARTIAL);
    expect(r.stdout).toContain('broken-refs.elpx: invalid\n');
    expect(r.stdout).toContain('  ✗ local-references: ');
    expect(r.stdout).toMatch(/ {2}- \[error\] missing-resource: Missing resource/);
    expect(r.stdout).not.toMatch(/\[info\]/);
    const json = singleJson<ValidationJson>((await runCli(['validate', BROKEN, '--json'])).stdout);
    expect(json.schema).toBe('elpx-optimizer/validation');
    expect(json.verdict).toBe('invalid');
  });

  it('marks checks that could not run with a dash, not as failed', async () => {
    const r = await runCli(['validate', notZip]);
    expect(r.code).toBe(EXIT.INVALID_INPUT);
    expect(r.stdout).toMatch(/ {2}✗ eXeLearning-project: /);
    expect(r.stdout).toMatch(/ {2}– content-xml: Not checked/);
    const json = singleJson<{ checks: { name: string; ok: boolean; status: string }[] }>((await runCli(['validate', notZip, '--json'])).stdout);
    const contentXml = json.checks.find((c) => c.name === 'content-xml')!;
    expect(contentXml).toMatchObject({ ok: false, status: 'not-run' });
  });

  it.each([
    ['not a ZIP', () => notZip],
    ['a legacy .elp', () => LEGACY],
    ['a truncated ZIP', () => corrupt],
  ])('exits 3 for %s', async (_label, file) => {
    const r = await runCli(['validate', file(), '--json']);
    expect(r.code).toBe(EXIT.INVALID_INPUT);
    expect(singleJson<ValidationJson>(r.stdout).verdict).toBe('unusable');
  });
});
