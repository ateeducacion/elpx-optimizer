import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { HELP } from '../../../src/cli/main.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { TOOL_VERSION, UPSTREAM_VERSION } from '../../../src/core/version.js';
import { ELPX, runCli } from '../../helpers/cli.js';
import { configureLocalTools } from '../../helpers/native.js';

beforeAll(() => {
  configureLocalTools();
});

describe('CLI contract', () => {
  it('prints the help on stderr and exits 2 without a command', async () => {
    const r = await runCli([]);
    expect(r).toEqual({ code: EXIT.USAGE, stdout: '', stderr: HELP });
  });

  it.each(['--help', '-h', 'help'])('prints the help on stdout for %s', async (flag) => {
    const r = await runCli([flag]);
    expect(r).toEqual({ code: EXIT.SUCCESS, stdout: HELP, stderr: '' });
    expect(HELP).toMatch(
      /Exit codes: 0 success, 1 failure, 2 usage error, 3 invalid input,\n4 partial result \/ validation errors, 5 missing dependency, 130 cancelled\./,
    );
  });

  it.each(['--version', '-v'])('prints the version for %s', async (flag) => {
    const r = await runCli([flag]);
    expect(r).toEqual({ code: EXIT.SUCCESS, stdout: `elpx-optimizer ${TOOL_VERSION} (eXeLearning format ${UPSTREAM_VERSION})\n`, stderr: '' });
  });

  it.each(['doctor', 'inspect', 'validate', 'optimize', 'serve'])('prints the help of %s', async (command) => {
    const r = await runCli([command, '--help']);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toMatch(new RegExp(`^Usage: elpx-optimizer ${command}`));
    expect(r.stderr).toBe('');
    const short = await runCli([command, '-h']);
    expect(short.stdout).toBe(r.stdout);
  });

  it('documents every optimize flag in its help', async () => {
    const { stdout } = await runCli(['optimize', '--help']);
    for (const flag of [
      '--output',
      '--overwrite',
      '--report',
      '--dry-run',
      '--preset',
      '--no-video',
      '--no-images',
      '--remove-unused',
      '--deduplicate',
      '--exclude',
      '--config',
      '--video-crf',
      '--video-max-resolution',
      '--video-audio-bitrate',
      '--video-x264-preset',
      '--video-force',
      '--video-drop-data-streams',
      '--image-quality',
      '--webp-quality',
      '--image-max-dimension',
      '--no-png',
      '--strip-metadata',
      '--image-force',
      '--include-screenshot',
      '--min-savings-percent',
      '--min-savings-bytes',
      '--threads',
      '--image-concurrency',
      '--timeout-video',
      '--max-archive-size',
      '--max-video-size',
      '--temp-dir',
      '--ffmpeg',
      '--ffprobe',
    ]) {
      expect(stdout).toContain(flag);
    }
  });

  it('prints the short version after a command', async () => {
    const r = await runCli(['inspect', '--version']);
    expect(r).toEqual({ code: EXIT.SUCCESS, stdout: `elpx-optimizer ${TOOL_VERSION}\n`, stderr: '' });
  });

  it('rejects unknown commands', async () => {
    const r = await runCli(['frobnicate', 'x.elpx']);
    expect(r).toEqual({ code: EXIT.USAGE, stdout: '', stderr: 'Unknown command "frobnicate". Run "elpx-optimizer --help".\n' });
  });

  it('rejects unknown flags and flags of other commands', async () => {
    const unknown = await runCli(['inspect', 'x.elpx', '--frobnicate']);
    expect(unknown.code).toBe(EXIT.USAGE);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toMatch(/--frobnicate/);
    expect(unknown.stderr).toMatch(/Run "elpx-optimizer inspect --help"\.\n$/);
    expect((await runCli(['validate', 'x.elpx', '--output', 'y.elpx'])).code).toBe(EXIT.USAGE);
    expect((await runCli(['optimize', 'x.elpx', '--output'])).code).toBe(EXIT.USAGE);
  });

  it('requires exactly one input file', async () => {
    const none = await runCli(['inspect']);
    expect(none).toEqual({ code: EXIT.USAGE, stdout: '', stderr: 'Invalid options: Expected exactly one input file\n' });
    expect((await runCli(['validate', 'a.elpx', 'b.elpx'])).code).toBe(EXIT.USAGE);
    expect((await runCli(['optimize'])).code).toBe(EXIT.USAGE);
  });

  it('maps operational errors to exit 1 with a short message', async () => {
    const missing = await runCli(['inspect', 'does-not-exist.elpx']);
    expect(missing).toEqual({ code: EXIT.FAILURE, stdout: '', stderr: 'Error: Input file not found\n' });
    const directory = await runCli(['validate', ELPX]);
    expect(directory.stderr).toBe('Error: Input is not a regular file\n');
  });

  it('maps cancellation to exit 130', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runCli(['inspect', join(ELPX, 'efficient.elpx'), '--quiet'], { signal: controller.signal });
    expect(r).toEqual({ code: EXIT.CANCELLED, stdout: '', stderr: 'Cancelled.\n' });
  });

  it('accepts the global flags on every command', async () => {
    const r = await runCli(['validate', join(ELPX, 'efficient.elpx'), '--quiet', '-q', '--no-color']);
    expect(r.code).toBe(EXIT.SUCCESS);
  });
});
