import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { removeDir, runCli, singleJson, tempDir, writeFailingFfmpeg, writeScript } from '../../helpers/cli.js';
import { nativeVideoAvailable } from '../../helpers/native.js';

/** The audio capability reported by `doctor` (JSON and text). */

interface DoctorJson {
  capabilities: { audio: { available: boolean; encoders: string[]; reason?: string } };
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
    const text = await doctor([]);
    expect(text.stdout).toContain(`✓ audio: encoders ${report.capabilities.audio.encoders.join(', ')}\n`);
  });

  it('reports why audio is unavailable', async () => {
    const missing = singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', '/nonexistent/ffmpeg'])).stdout);
    expect(missing.capabilities.audio).toEqual({ available: false, encoders: [], reason: 'ffmpeg/ffprobe not found' });
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
  });

  it('marks audio unavailable when the FFmpeg smoke test fails, even with audio encoders', async () => {
    // The fake identity lists aac, but every encode fails.
    const ffmpeg = await writeFailingFfmpeg(dir);
    const report = singleJson<DoctorJson>((await doctor(['--json', '--ffmpeg', ffmpeg, '--ffprobe', ffmpeg])).stdout);
    expect(report.capabilities.audio).toEqual({ available: false, encoders: ['aac'] });
    expect((await doctor(['--ffmpeg', ffmpeg, '--ffprobe', ffmpeg])).stdout).toContain('✗ audio: unavailable\n');
  });
});
