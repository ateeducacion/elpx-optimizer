import { APP_DEFAULTS } from '../../../src/core/plan/options.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { optionsFromFlags, renderPlan } from '../../../src/cli/commands/optimize.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { OptimizationPlan, PlanOperation } from '../../../src/core/plan/plan.js';
import { captureIO, ELPX, removeDir, runCli, singleJson, tempDir } from '../../helpers/cli.js';
import { configureLocalTools, nativeVideoAvailable } from '../../helpers/native.js';

/** CLI support for audio: --no-audio, --audio-bitrate, --audio-force and the plan lines. */

const AUDIO = join(ELPX, 'audio-course.elpx');
let dir: string;

beforeAll(async () => {
  configureLocalTools();
  dir = await tempDir('elpx-audio-cli-');
});
afterAll(async () => {
  await removeDir(dir);
});

describe('optimize: audio flags', () => {
  it('maps the flags onto options.audio, over --config', async () => {
    const io = captureIO({ cwd: dir }).io;
    expect(await optionsFromFlags({ 'no-audio': true }, io)).toEqual({ ...APP_DEFAULTS, audio: { enabled: false } });
    expect(await optionsFromFlags({ 'audio-bitrate': '192', 'audio-force': true }, io)).toEqual({ ...APP_DEFAULTS, audio: { bitrate: 192, force: true } });
    await writeFile(join(dir, 'audio.json'), JSON.stringify({ audio: { bitrate: 96, force: true }, preset: 'aggressive' }));
    expect(await optionsFromFlags({ config: 'audio.json', 'audio-bitrate': '160' }, io)).toEqual({
      ...APP_DEFAULTS,
      preset: 'aggressive',
      audio: { bitrate: 160, force: true },
    });
    // No audio flag: no audio options at all.
    expect(await optionsFromFlags({ 'no-video': true }, io)).toEqual({ ...APP_DEFAULTS, video: { enabled: false } });
  });

  it.each([
    ['--audio-bitrate', 'fast', 'Invalid options: --audio-bitrate must be an integer between 0 and 10000\n'],
    ['--audio-bitrate', '32', 'Invalid options: audio.bitrate must be an integer between 64 and 320\n'],
    ['--audio-bitrate', '400', 'Invalid options: audio.bitrate must be an integer between 64 and 320\n'],
  ])('rejects %s %s', async (flag, value, stderr) => {
    const r = await runCli(['optimize', AUDIO, '--dry-run', flag, value]);
    expect(r).toMatchObject({ code: EXIT.USAGE, stdout: '', stderr });
  });

  it('documents the audio options', async () => {
    const { stdout } = await runCli(['optimize', '--help']);
    expect(stdout).toContain('--no-audio                 Do not touch audio files');
    expect(stdout).toContain('--audio-bitrate N          kb/s for stereo, mono uses half (64-320; default 192/128/96)');
    expect(stdout).toContain('--audio-force              Re-encode MP3/M4A even when their bitrate is close to the target');
  });

  it.runIf(nativeVideoAvailable())('plans audio work in dry runs, and none with --no-audio', async () => {
    const json = await runCli(['optimize', AUDIO, '--dry-run', '--json', '--quiet', '--no-images', '--audio-bitrate', '160'], { cwd: dir });
    expect(json.code).toBe(EXIT.SUCCESS);
    const { plan } = singleJson<{ plan: OptimizationPlan }>(json.stdout);
    expect(plan.options.audio).toMatchObject({ enabled: true, bitrateKbps: 160 });
    const audio = plan.operations.filter((o): o is Extract<PlanOperation, { op: 'transcode-audio' }> => o.op === 'transcode-audio');
    expect(audio.map((o) => [o.path, o.to, o.job.bitrateKbps])).toEqual([
      ['content/resources/audio/alta.mp3', undefined, 160],
      ['content/resources/audio/lectura.wav', 'content/resources/audio/lectura.mp3', 160],
      ['content/resources/audio/musica.flac', 'content/resources/audio/musica.mp3', 80],
      ['content/resources/audio/pista.aiff', 'content/resources/audio/pista.mp3', 80],
    ]);
    const text = await runCli(['optimize', AUDIO, '--dry-run', '--quiet', '--verbose', '--no-images']);
    expect(text.stdout).toContain(
      '  • transcode-audio content/resources/audio/lectura.wav → content/resources/audio/lectura.mp3 (516.9 KiB) [lossy]: WAV (pcm_s16le) converted to MP3 at 128 kb/s (lossy); the file is renamed to .mp3\n',
    );
    expect(text.stdout).toContain('Note: WAV, AIFF and FLAC recordings become MP3 files with the .mp3 extension; their references are rewritten.\n');
    const off = singleJson<{ plan: OptimizationPlan }>((await runCli(['optimize', AUDIO, '--dry-run', '--json', '--quiet', '--no-audio'])).stdout);
    expect(off.plan.operations.some((o) => o.op === 'transcode-audio')).toBe(false);
    expect(off.plan.skipped.filter((s) => s.kind === 'audio').every((s) => s.reason === 'audio-disabled')).toBe(true);
  });
});

describe('renderPlan: audio operations', () => {
  it('shows the new name of converted files', () => {
    const plan = {
      input: { name: 'p.elpx', size: 10 },
      options: { preset: 'balanced' },
      engine: { engine: 'native' },
      operations: [
        { op: 'transcode-audio', path: 'content/resources/a.wav', to: 'content/resources/a.mp3', size: 2048, conversions: ['WAV to MP3', 'renamed'] },
        { op: 'transcode-audio', path: 'content/resources/b.mp3', size: 1024, conversions: ['MP3 re-encoded'] },
      ] as unknown as PlanOperation[],
      skipped: [],
      estimate: { savedBytes: 0 },
      risks: [],
    } as unknown as OptimizationPlan;
    expect(renderPlan(plan)).toBe(
      [
        'Plan for p.elpx (10 B), preset balanced, engine native',
        '  • transcode-audio content/resources/a.wav → content/resources/a.mp3 (2.0 KiB) [lossy]: WAV to MP3; renamed',
        '  • transcode-audio content/resources/b.mp3 (1.0 KiB) [lossy]: MP3 re-encoded',
        'Estimated saving (estimate, not measured): 0 B',
        '',
      ].join('\n'),
    );
  });
});
