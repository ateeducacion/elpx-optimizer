import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, copyFile, link, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable } from '../../src/adapters/node/tools.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { ELPX, fileSha256, removeDir, runCli, singleJson, tempDir, UPSTREAM, writeFailingFfmpeg, writeScript } from '../helpers/cli.js';
import { MEDIA, nativeVideoAvailable } from '../helpers/native.js';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { OptimizationReport } from '../../src/core/report/report.js';

const video = nativeVideoAvailable();
const COURSE = join(ELPX, 'course-video.elpx');
const EFFICIENT = join(ELPX, 'efficient.elpx');

interface ReportJson {
  schema: string;
  status: string;
  error?: string;
  input: { name: string; size: number; sha256: string };
  output?: { name: string; size: number; sha256: string };
  sizes: { before: number; after: number; saved: number };
  operations: { op: string; path: string; status: string; detail?: string }[];
}

let dir: string;
let work: string;
let courseSha: string;

/** True when the path exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Files left in a directory, ignoring nothing (temporary .partial files included). */
async function listing(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

beforeAll(async () => {
  dir = await tempDir('elpx-optimize-');
  courseSha = await fileSha256(COURSE);
});
afterAll(async () => {
  await removeDir(dir);
});
beforeEach(async (ctx) => {
  work = join(dir, ctx.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60));
  await mkdir(work, { recursive: true });
});

describe.runIf(video)('optimize with the native engine', () => {
  it('optimizes next to the input with the default name and leaves the input untouched', async () => {
    const input = join(work, 'Curso de año ñ.elpx');
    await copyFile(COURSE, input);
    const r = await runCli(['optimize', 'Curso de año ñ.elpx', '--json', '--report', 'informe final.json'], { cwd: work });
    expect(r.code).toBe(EXIT.SUCCESS);
    const report = singleJson<ReportJson>(r.stdout);
    expect(report.schema).toBe('elpx-optimizer/report');
    expect(report.status).toBe('optimized');
    expect(report.output?.name).toBe('Curso de año ñ_optimized.elpx');
    expect(report.sizes.after).toBeLessThan(report.sizes.before);
    expect(report.operations.find((o) => o.op === 'transcode-video')?.status).toBe('applied');
    expect(r.stderr).toMatch(/^Plan: \d+ operations, \d+ resources left unchanged\n$/);
    expect(await listing(work)).toEqual(['Curso de año ñ.elpx', 'Curso de año ñ_optimized.elpx', 'informe final.json']);
    expect(await fileSha256(input)).toBe(courseSha);
    const output = join(work, 'Curso de año ñ_optimized.elpx');
    expect(await fileSha256(output)).toBe(report.output?.sha256);
    expect(JSON.parse(await readFile(join(work, 'informe final.json'), 'utf8'))).toEqual(report);
    const validation = await runCli(['validate', output, '--json']);
    expect(validation.code).toBe(EXIT.SUCCESS);
  });

  it('recompresses the images inside an attached ODP with sharp, keeping its path and other entries', async () => {
    const photo = await readFile(join(MEDIA, 'photo-exif-icc.jpg'));
    const odpFiles: Zippable = {
      mimetype: [strToU8('application/vnd.oasis.opendocument.presentation'), { level: 0 }],
      'content.xml': strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>'),
      'Pictures/photo.jpg': [photo, { level: 0 }],
      'META-INF/manifest.xml': strToU8('<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'),
    };
    const project = unzipSync(await readFile(EFFICIENT));
    const input = join(work, 'slides.elpx');
    await writeFile(input, zipSync({ ...project, 'content/resources/slides.odp': [zipSync(odpFiles), { level: 0 }] }));
    const r = await runCli(['optimize', input, '--output', join(work, 'out.elpx'), '--no-video', '--remove-unused', 'off', '--json']);
    const report = singleJson(r.stdout) as OptimizationReport;
    expect(report.operations.find((o) => o.op === 'optimize-odf')).toMatchObject({
      status: 'applied',
      embedded: [{ path: 'Pictures/photo.jpg', before: photo.length }],
    });
    const inner = unzipSync(unzipSync(await readFile(join(work, 'out.elpx')))['content/resources/slides.odp']!);
    expect(Object.keys(inner)).toEqual(Object.keys(odpFiles));
    expect(inner['Pictures/photo.jpg']!.length).toBeLessThan(photo.length);
  });

  it('prints a human report and progress', async () => {
    const out = join(work, 'out.elpx');
    const r = await runCli(['optimize', COURSE, '--output', out, '--threads', '1', '--image-concurrency', '1', '--timeout-video', '120']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(/^Optimized/);
    expect(r.stderr).toContain('Reading input\n');
    expect(r.stderr).toMatch(/Plan: \d+ operations/);
    expect(await exists(out)).toBe(true);
  });

  it('is silent on stderr with --quiet', async () => {
    const r = await runCli(['optimize', COURSE, '--output', join(work, 'q.elpx'), '--quiet', '--json', '--no-video']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stderr).toBe('');
    expect(singleJson<ReportJson>(r.stdout).status).toBe('optimized');
  });

  it('delivers a byte copy when nothing improves', async () => {
    const out = join(work, 'copy.elpx');
    const r = await runCli(['optimize', EFFICIENT, '--output', out, '--json']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(singleJson<ReportJson>(r.stdout).status).toBe('no-improvement');
    expect(await fileSha256(out)).toBe(await fileSha256(EFFICIENT));
  });

  it('refuses an existing output unless --overwrite', async () => {
    const out = join(work, 'taken.elpx');
    await writeFile(out, 'previous result');
    const refused = await runCli(['optimize', COURSE, '--output', out, '--no-video']);
    expect(refused.code).toBe(EXIT.USAGE);
    expect(refused.stderr).toBe('Output taken.elpx already exists; choose another --output or pass --overwrite\n');
    expect(await readFile(out, 'utf8')).toBe('previous result');
    const dry = await runCli(['optimize', COURSE, '--output', out, '--dry-run', '--quiet']);
    expect(dry.code).toBe(EXIT.SUCCESS);
    const replaced = await runCli(['optimize', COURSE, '--output', out, '--no-video', '--overwrite', '--quiet']);
    expect(replaced.code).toBe(EXIT.SUCCESS);
    expect(await readFile(out, 'utf8')).not.toBe('previous result');
    expect(await listing(work)).toEqual(['taken.elpx']);
  });

  it('does not replace a file that appears while running', async () => {
    const out = join(work, 'race.elpx');
    const r = await runCli(['optimize', COURSE, '--output', out, '--no-video'], {
      onStderr: (t) => {
        if (t.startsWith('Plan:')) void writeFile(out, 'someone else');
      },
    });
    expect(r.code).toBe(EXIT.USAGE);
    expect(await readFile(out, 'utf8')).toBe('someone else');
    expect(await listing(work)).toEqual(['race.elpx']);
  });

  it('refuses the input as output, also through symbolic and hard links', async () => {
    const input = join(work, 'in.elpx');
    await copyFile(COURSE, input);
    await symlink(input, join(work, 'soft.elpx'));
    await link(input, join(work, 'hard.elpx'));
    for (const out of ['in.elpx', './sub/../in.elpx', 'soft.elpx', 'hard.elpx']) {
      const r = await runCli(['optimize', 'in.elpx', '--output', out, '--overwrite'], { cwd: work });
      expect(r.code, out).toBe(EXIT.USAGE);
      expect(r.stderr).toMatch(/^Invalid options: The output (must not be the input file|is a link to the input file)\n$/);
    }
    expect(await fileSha256(input)).toBe(courseSha);
    expect(await listing(work)).toEqual(['hard.elpx', 'in.elpx', 'soft.elpx']);
  });

  it('writes the plan as the report of a dry run', async () => {
    const r = await runCli(['optimize', COURSE, '--dry-run', '--report', 'plan.json', '--quiet'], { cwd: work });
    expect(r.code).toBe(EXIT.SUCCESS);
    const saved = JSON.parse(await readFile(join(work, 'plan.json'), 'utf8')) as { schema: string; status: string };
    expect(saved).toMatchObject({ schema: 'elpx-optimizer/dry-run', status: 'dry-run' });
    expect(await listing(work)).toEqual(['plan.json']);
  });

  it('uses --temp-dir for work files and cleans it up', async () => {
    const temp = join(work, 'scratch space');
    await mkdir(temp);
    const r = await runCli(['optimize', COURSE, '--output', join(work, 'o.elpx'), '--temp-dir', temp, '--quiet']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(await readdir(temp)).toEqual([]);
    const missing = await runCli(['optimize', COURSE, '--output', join(work, 'p.elpx'), '--temp-dir', join(work, 'missing'), '--quiet']);
    expect(missing.code).toBe(EXIT.FAILURE);
    expect(await exists(join(work, 'p.elpx'))).toBe(false);
  });

  it('exits 4 with a valid output when the video fails but images succeed', async () => {
    const ffmpeg = await writeFailingFfmpeg(work);
    const out = join(work, 'partial.elpx');
    const r = await runCli(['optimize', COURSE, '--output', out, '--ffmpeg', ffmpeg, '--json', '--report', join(work, 'partial.json')]);
    expect(r.code).toBe(EXIT.PARTIAL);
    const report = singleJson<ReportJson>(r.stdout);
    expect(report.status).toBe('partial');
    const videoOp = report.operations.find((o) => o.op === 'transcode-video');
    expect(videoOp).toMatchObject({ status: 'failed', detail: 'ffmpeg failed: fake ffmpeg: encoding failed' });
    expect(report.operations.some((o) => o.op === 'recompress-image' && o.status === 'applied')).toBe(true);
    expect(report.sizes.after).toBeLessThan(report.sizes.before);
    expect((await runCli(['validate', out])).code).toBe(EXIT.SUCCESS);
    expect(await listing(work)).toEqual(['ffmpeg', 'partial.elpx', 'partial.json']);
  });

  it('cancels a running encode: kills ffmpeg, delivers nothing and keeps the input', async () => {
    const real = await findExecutable('ffmpeg', process.env['ELPX_OPTIMIZER_FFMPEG']);
    const pidFile = join(work, 'ffmpeg.pid');
    // Real ffmpeg, slowed to real time (-re) during the encode so the cancel lands mid-way.
    const slow = await writeScript(
      join(work, 'slow-ffmpeg'),
      `case "$*" in *-progress*) echo $$ > "${pidFile}"; exec "${real}" -re "$@";; esac\nexec "${real}" "$@"`,
    );
    const temp = join(work, 'tmp');
    await mkdir(temp);
    const input = join(work, 'curso.elpx');
    await copyFile(COURSE, input);
    const controller = new AbortController();
    let abortedAt = 0;
    const r = await runCli(['optimize', input, '--ffmpeg', slow, '--temp-dir', temp, '--report', join(work, 'report.json')], {
      signal: controller.signal,
      onStderr: (t) => {
        // Cancel once ffmpeg itself reports progress ("Transcoding <file> 1.0/4.0 s"); 0.0 is the core's start event.
        const processed = /^Transcoding .* (\d+\.\d)\/\d+\.\d s\n$/.exec(t);
        if (processed && Number(processed[1]) > 0 && !controller.signal.aborted) {
          abortedAt = Date.now();
          controller.abort();
        }
      },
    });
    expect(r.code).toBe(EXIT.CANCELLED);
    expect(abortedAt).toBeGreaterThan(0);
    // The 4 s real-time encode was interrupted, not waited for.
    expect(Date.now() - abortedAt).toBeLessThan(2000);
    expect(r.stdout).toMatch(/cancel/i);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await listing(work)).toEqual(['curso.elpx', 'ffmpeg.pid', 'report.json', 'slow-ffmpeg', 'tmp']);
    expect(await readdir(temp)).toEqual([]);
    expect(await fileSha256(input)).toBe(courseSha);
    expect(JSON.parse(await readFile(join(work, 'report.json'), 'utf8'))).toMatchObject({ status: 'cancelled' });
  });
});

describe('optimize with invalid input', () => {
  it.each([
    ['not a ZIP', async (path: string) => writeFile(path, 'plain text')],
    ['a legacy .elp', async (path: string) => copyFile(join(UPSTREAM, 'verdaderofalso.elp'), path)],
    ['a truncated ZIP', async (path: string) => writeFile(path, (await readFile(COURSE)).subarray(0, 100_000))],
  ])('exits 3 for %s without creating an output', async (_label, make) => {
    const input = join(work, 'input.elpx');
    await make(input);
    const r = await runCli(['optimize', input, '--json', '--report', join(work, 'report.json')]);
    expect(r.code).toBe(EXIT.INVALID_INPUT);
    const report = singleJson<ReportJson>(r.stdout);
    expect(report.status).toBe('invalid-input');
    expect(report.error).toBeTruthy();
    expect(JSON.parse(await readFile(join(work, 'report.json'), 'utf8'))).toEqual(report);
    expect(await listing(work)).toEqual(['input.elpx', 'report.json']);
    const text = await runCli(['optimize', input, '--quiet']);
    expect(text.code).toBe(EXIT.INVALID_INPUT);
    expect(text.stdout).toMatch(/^Invalid input/);
  });

  it('exits 3 when the archive exceeds --max-archive-size', async () => {
    const r = await runCli(['optimize', COURSE, '--output', join(work, 'x.elpx'), '--max-archive-size', '1024', '--quiet']);
    expect(r.code).toBe(EXIT.INVALID_INPUT);
    expect(await listing(work)).toEqual([]);
  });

  it('exits 1 when the output directory does not exist', async () => {
    const r = await runCli(['optimize', EFFICIENT, '--output', join(work, 'no such dir', 'out.elpx'), '--quiet']);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.stderr).toMatch(/^Error: /);
  });
});
