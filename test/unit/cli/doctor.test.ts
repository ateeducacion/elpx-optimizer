import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { FAKE_FFMPEG_IDENTITY, removeDir, runCli, singleJson, tempDir, writeFailingFfmpeg, writeScript } from '../../helpers/cli.js';
import { nativeVideoAvailable } from '../../helpers/native.js';

interface DoctorJson {
  schema: string;
  ok: boolean;
  runtime: { node: string; bun?: string };
  versions: Record<string, string>;
  capabilities: Record<string, { available: boolean; reason?: string; encoders?: unknown; root?: string }>;
  checks: { name: string; ok: boolean; detail: string }[];
  notes: string[];
}

const video = nativeVideoAvailable();
let dir: string;
let env: Record<string, string | undefined>;

/** Runs doctor from the temp dir with a deterministic web root. */
function doctor(args: string[]): ReturnType<typeof runCli> {
  return runCli(['doctor', ...args], { cwd: dir, env });
}

/** The named check of a doctor report. */
function check(report: DoctorJson, name: string): { ok: boolean; detail: string } {
  return report.checks.find((c) => c.name === name)!;
}

beforeAll(async () => {
  dir = await tempDir('elpx-doctor-');
  await mkdir(join(dir, 'web'));
  await writeFile(join(dir, 'web', 'index.html'), '<!doctype html>');
  env = { ...process.env, ELPX_OPTIMIZER_WEB_ROOT: join(dir, 'web') };
});
afterAll(async () => {
  await removeDir(dir);
});

describe.runIf(video)('doctor with working tools', () => {
  it('reports every capability as JSON and exits 0', async () => {
    const r = await doctor(['--json']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stderr).toBe('');
    const report = singleJson<DoctorJson>(r.stdout);
    expect(report.schema).toBe('elpx-optimizer/doctor');
    expect(report.ok).toBe(true);
    expect(report.runtime.node).toBe(process.versions.node);
    expect(Object.keys(report.versions).sort()).toEqual(['ffmpeg', 'ffprobe', 'libvips', 'sharp']);
    expect(report.capabilities['video']).toMatchObject({ available: true });
    expect(report.capabilities['image']).toMatchObject({ available: true });
    expect(report.capabilities['web']).toEqual({ available: true, root: 'web' });
    expect(check(report, 'video-encode')).toEqual({ name: 'video-encode', ok: true, detail: 'libx264 encode and ffprobe succeeded' });
    expect(check(report, 'image-encode')).toEqual({ name: 'image-encode', ok: true, detail: 'sharp encode succeeded' });
  });

  it('prints a human summary', async () => {
    const r = await doctor([]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(/^elpx-optimizer \S+ on Node \S+ \(\w+\/\w+\)\n/);
    expect(r.stdout).toContain('✓ inspect / validate: available (no external tools needed)\n');
    expect(r.stdout).toMatch(/✓ video: ffmpeg \S+, ffprobe \S+, encoders libx264/);
    expect(r.stdout).toMatch(/✓ images: sharp \S+ \(libvips \S+\)/);
    expect(r.stdout).toContain('✓ web app: static files in web\n');
  });

  it('names Bun as the runtime when running under Bun', async () => {
    Object.defineProperty(process.versions, 'bun', { value: '9.9.9', configurable: true, enumerable: true });
    try {
      const r = await doctor(['--ffmpeg', join(dir, 'missing')]);
      expect(r.stdout).toMatch(/ on Bun 9\.9\.9 /);
    } finally {
      delete (process.versions as Record<string, string | undefined>)['bun'];
    }
  });

  it('fails the video check when the probe of the smoke file fails', async () => {
    const ffprobe = await writeScript(join(dir, 'bad-ffprobe'), `${FAKE_FFMPEG_IDENTITY}\nexit 1`);
    const r = await doctor(['--json', '--ffprobe', ffprobe]);
    expect(r.code).toBe(EXIT.DEPENDENCY);
    const report = singleJson<DoctorJson>(r.stdout);
    expect(report.capabilities['video']!.available).toBe(false);
    expect(check(report, 'video-encode').ok).toBe(false);
  });
});

describe('doctor with missing or broken tools', () => {
  it('exits 5 when ffmpeg is missing', async () => {
    const r = await doctor(['--json', '--ffmpeg', '/nonexistent/ffmpeg']);
    expect(r.code).toBe(EXIT.DEPENDENCY);
    const report = singleJson<DoctorJson>(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.capabilities['video']).toMatchObject({ available: false, reason: 'ffmpeg/ffprobe not found' });
    expect(report.capabilities['inspect']).toEqual({ available: true });
    expect(check(report, 'video-encode')).toMatchObject({ ok: false, detail: 'ffmpeg/ffprobe not found' });
    expect(report.notes).toContain('Missing: ffmpeg');
    const text = await doctor(['--ffmpeg', '/nonexistent/ffmpeg']);
    expect(text.code).toBe(EXIT.DEPENDENCY);
    expect(text.stdout).toContain('✗ video: ffmpeg/ffprobe not found\n');
    expect(text.stdout).toContain('  note: Missing: ffmpeg\n');
  });

  it.runIf(video)('exits 5 when the ffmpeg smoke encode fails', async () => {
    const ffmpeg = await writeFailingFfmpeg(dir);
    const report = singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', ffmpeg])).stdout);
    expect(check(report, 'video-encode')).toMatchObject({ ok: false, detail: 'ffmpeg smoke test failed: fake ffmpeg: encoding failed' });
    expect(report.capabilities['video']!.available).toBe(false);
    const text = await doctor(['--ffmpeg', ffmpeg]);
    expect(text.code).toBe(EXIT.DEPENDENCY);
    expect(text.stdout).toContain('✗ video: unavailable\n');
  });

  it.runIf(video)('exits 5 when ffmpeg claims success without writing the file', async () => {
    const ffmpeg = await writeScript(join(dir, 'silent-ffmpeg'), `${FAKE_FFMPEG_IDENTITY}\nexit 0`);
    const r = await doctor(['--json', '--ffmpeg', ffmpeg]);
    expect(r.code).toBe(EXIT.DEPENDENCY);
    expect(check(singleJson<DoctorJson>(r.stdout), 'video-encode')).toMatchObject({ ok: false, detail: 'ffmpeg smoke test failed: ' });
  });
});
