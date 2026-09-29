import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { FAKE_FFMPEG_IDENTITY, removeDir, runCli, singleJson, tempDir, writeFailingFfmpeg, writeScript } from '../../helpers/cli.js';
import { nativeVideoAvailable } from '../../helpers/native.js';

/** The audio capability reported by `doctor` (JSON and text). */

interface DoctorJson {
  capabilities: { audio: { available: boolean; encoders: string[]; reason?: string }; video: { available: boolean } };
  checks: { name: string; ok: boolean; detail: string }[];
}

/** The audio smoke test of a doctor report. */
function audioCheck(report: DoctorJson): { ok: boolean; detail: string } | undefined {
  const c = report.checks.find((x) => x.name === 'audio-encode');
  return c && { ok: c.ok, detail: c.detail };
}

const video = nativeVideoAvailable();
let dir: string;
let env: Record<string, string | undefined>;

/** Runs doctor from the temp dir with a deterministic web root. */
function doctor(args: string[]): ReturnType<typeof runCli> {
  return runCli(['doctor', ...args], { cwd: dir, env });
}

beforeAll(async () => {
  dir = await tempDir('elpx-doctor-audio-');
  await mkdir(join(dir, 'web'));
  await writeFile(join(dir, 'web', 'index.html'), '<!doctype html>');
  env = { ...process.env, ELPX_OPTIMIZER_WEB_ROOT: join(dir, 'web') };
});
afterAll(async () => {
  await removeDir(dir);
});

describe('doctor: audio', () => {
  it.runIf(video)('lists the audio encoders of a working ffmpeg', async () => {
    const report = singleJson<DoctorJson>((await doctor(['--json'])).stdout);
    expect(report.capabilities.audio.available).toBe(true);
    expect(report.capabilities.audio.encoders).toEqual(expect.arrayContaining(['libmp3lame', 'aac']));
    expect(report.capabilities.audio.reason).toBeUndefined();
    // Its own smoke test: a short tone encoded with libmp3lame (preferred over aac), then probed.
    expect(audioCheck(report)).toEqual({ ok: true, detail: 'libmp3lame encode and ffprobe succeeded' });
    const text = await doctor([]);
    expect(text.stdout).toContain(`✓ audio: encoders ${report.capabilities.audio.encoders.join(', ')}\n`);
  });

  it('reports why audio is unavailable', async () => {
    const missing = singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', '/nonexistent/ffmpeg'])).stdout);
    expect(missing.capabilities.audio).toEqual({ available: false, encoders: [], reason: 'ffmpeg/ffprobe not found' });
    expect(audioCheck(missing)).toEqual({ ok: false, detail: 'ffmpeg/ffprobe not found' });
    expect((await doctor(['--ffmpeg', '/nonexistent/ffmpeg'])).stdout).toContain('✗ audio: ffmpeg/ffprobe not found\n');
    // An ffmpeg without MP3, AAC or Opus encoders.
    const videoOnly = await writeScript(
      join(dir, 'video-only-ffmpeg'),
      `case "$*" in *-version*) echo "ffmpeg version 9.9-fake"; exit 0;; *-encoders*) printf ' V....D libx264  H.264\\n'; exit 0;; esac\nexit 1`,
    );
    const r = await doctor(['--json', '--ffmpeg', videoOnly, '--ffprobe', videoOnly]);
    expect(r.code).toBe(EXIT.DEPENDENCY);
    expect(singleJson<DoctorJson>(r.stdout).capabilities.audio).toMatchObject({ available: false, encoders: [] });
    expect(singleJson<DoctorJson>(r.stdout).capabilities.audio.reason).toMatch(/^ffmpeg lacks the libmp3lame and aac encoders/);
    expect(audioCheck(singleJson<DoctorJson>(r.stdout))?.detail).toMatch(/^ffmpeg lacks the libmp3lame and aac encoders/);
    // An ffmpeg with only the Opus encoder has no MP3/AAC encoder for the smoke test.
    const opusOnly = await writeScript(
      join(dir, 'opus-only-ffmpeg'),
      `case "$*" in *-version*) echo "ffmpeg version 9.9-fake"; exit 0;; *-encoders*) printf ' A....D libopus  Opus\\n'; exit 0;; esac\nexit 1`,
    );
    const opus = singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', opusOnly, '--ffprobe', opusOnly])).stdout);
    expect(opus.capabilities.audio).toEqual({ available: false, encoders: ['libopus'] });
    expect(audioCheck(opus)).toEqual({ ok: false, detail: 'unavailable' });
  });

  it('marks audio unavailable when its smoke test fails, even with audio encoders', async () => {
    // The fake identity lists aac, but every encode fails.
    const ffmpeg = await writeFailingFfmpeg(dir);
    const report = singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', ffmpeg, '--ffprobe', ffmpeg])).stdout);
    expect(report.capabilities.audio).toEqual({ available: false, encoders: ['aac'] });
    expect(audioCheck(report)).toEqual({ ok: false, detail: 'ffmpeg audio smoke test failed: fake ffmpeg: encoding failed' });
    expect((await doctor(['--ffmpeg', ffmpeg, '--ffprobe', ffmpeg])).stdout).toContain('✗ audio: unavailable\n');
    // An encode that exits 0 without writing anything, and one whose output ffprobe cannot read.
    const silent = await writeScript(join(dir, 'silent-audio-ffmpeg'), `${FAKE_FFMPEG_IDENTITY}\nexit 0`);
    expect(audioCheck(singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', silent, '--ffprobe', silent])).stdout))).toEqual({
      ok: false,
      detail: 'ffmpeg audio smoke test failed: ',
    });
    const writes = await writeScript(join(dir, 'writing-ffmpeg'), `${FAKE_FFMPEG_IDENTITY}\nfor last; do :; done\nprintf "not audio" > "$last"`);
    const unreadable = await writeScript(join(dir, 'failing-ffprobe'), `${FAKE_FFMPEG_IDENTITY}\nexit 1`);
    expect(audioCheck(singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', writes, '--ffprobe', unreadable])).stdout))?.ok).toBe(false);
  });

  it.runIf(video)('checks audio on its own: an ffmpeg without libx264 still converts audio', async () => {
    // Real ffmpeg behind an encoder list without libx264.
    const noX264 = await writeScript(
      join(dir, 'no-x264-ffmpeg'),
      `case "$*" in *-encoders*) printf ' A....D libmp3lame  MP3\\n A....D aac  AAC\\n'; exit 0;; esac\nexec "${process.env['ELPX_OPTIMIZER_FFMPEG'] ?? 'ffmpeg'}" "$@"`,
    );
    const report = singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', noX264])).stdout);
    expect(report.capabilities.video.available).toBe(false);
    expect(report.capabilities.audio).toEqual({ available: true, encoders: ['libmp3lame', 'aac'] });
    expect(audioCheck(report)).toEqual({ ok: true, detail: 'libmp3lame encode and ffprobe succeeded' });
  });
});
