import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { delimiter, join, relative } from 'node:path';
import { findExecutable, listEncoders, resolveTools, toolVersion } from '../../../src/adapters/node/tools.js';
import { removeDir, tempDir, writeScript } from '../../helpers/cli.js';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const saved = { PATH: process.env['PATH'], FFMPEG: process.env['ELPX_OPTIMIZER_FFMPEG'], FFPROBE: process.env['ELPX_OPTIMIZER_FFPROBE'] };
let dir: string;

/** Restores an environment variable to a saved value. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  dir = await tempDir('elpx-tools-');
  delete process.env['ELPX_OPTIMIZER_FFMPEG'];
  delete process.env['ELPX_OPTIMIZER_FFPROBE'];
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  restoreEnv('PATH', saved.PATH);
  restoreEnv('ELPX_OPTIMIZER_FFMPEG', saved.FFMPEG);
  restoreEnv('ELPX_OPTIMIZER_FFPROBE', saved.FFPROBE);
  await removeDir(dir);
});

describe('findExecutable', () => {
  it('makes an explicit relative path absolute', async () => {
    const tool = await writeScript(join(dir, 'my ffmpeg'), 'exit 0');
    expect(await findExecutable('ffmpeg', relative(process.cwd(), tool))).toBe(tool);
  });

  it('rejects explicit paths that are missing or not executable', async () => {
    await writeFile(join(dir, 'plain'), 'not executable');
    expect(await findExecutable('ffmpeg', join(dir, 'plain'))).toBeUndefined();
    expect(await findExecutable('ffmpeg', join(dir, 'missing'))).toBeUndefined();
  });

  it('searches absolute PATH entries in order', async () => {
    const first = await tempDir('elpx-tools-first-');
    try {
      await writeScript(join(first, 'ffprobe'), 'exit 0');
      await writeScript(join(dir, 'ffprobe'), 'exit 0');
      process.env['PATH'] = ['', 'relative/bin', first, dir].join(delimiter);
      expect(await findExecutable('ffprobe')).toBe(join(first, 'ffprobe'));
      expect(await findExecutable('not-a-real-tool-name')).toBeUndefined();
    } finally {
      await removeDir(first);
    }
  });

  it('returns undefined without a PATH', async () => {
    delete process.env['PATH'];
    expect(await findExecutable('ffmpeg')).toBeUndefined();
  });

  it('tries Windows executable extensions', async () => {
    await writeScript(join(dir, 'ffmpeg.exe'), 'exit 0');
    process.env['PATH'] = dir;
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    expect(await findExecutable('ffmpeg')).toBe(join(dir, 'ffmpeg.exe'));
  });
});

describe('resolveTools', () => {
  it('prefers explicit overrides, then environment variables, then PATH', async () => {
    const envFfmpeg = await writeScript(join(dir, 'env-ffmpeg'), 'exit 0');
    const envFfprobe = await writeScript(join(dir, 'env-ffprobe'), 'exit 0');
    const flagFfmpeg = await writeScript(join(dir, 'flag-ffmpeg'), 'exit 0');
    process.env['PATH'] = '/nonexistent-dir';
    expect(await resolveTools()).toEqual({ ffmpeg: undefined, ffprobe: undefined });
    process.env['ELPX_OPTIMIZER_FFMPEG'] = envFfmpeg;
    process.env['ELPX_OPTIMIZER_FFPROBE'] = envFfprobe;
    expect(await resolveTools()).toEqual({ ffmpeg: envFfmpeg, ffprobe: envFfprobe });
    expect(await resolveTools({ ffmpeg: flagFfmpeg })).toEqual({ ffmpeg: flagFfmpeg, ffprobe: envFfprobe });
    expect(await resolveTools({ ffprobe: '/nonexistent/ffprobe' })).toEqual({ ffmpeg: envFfmpeg, ffprobe: undefined });
  });
});

describe('toolVersion', () => {
  it('extracts the version from the first line', async () => {
    const tool = await writeScript(join(dir, 'ffmpeg'), 'echo "ffmpeg version 7.1-static Copyright (c) 2000"; echo "built with gcc"');
    expect(await toolVersion(tool)).toBe('7.1-static');
  });

  it('falls back to the whole first line, or undefined when empty', async () => {
    expect(await toolVersion(await writeScript(join(dir, 'odd'), 'echo "  odd tool 3  "'))).toBe('odd tool 3');
    expect(await toolVersion(await writeScript(join(dir, 'silent'), 'exit 0'))).toBeUndefined();
  });

  it('returns undefined when the tool fails or cannot run', async () => {
    expect(await toolVersion(await writeScript(join(dir, 'broken'), 'echo "ffmpeg version 1"; exit 1'))).toBeUndefined();
    expect(await toolVersion(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('listEncoders', () => {
  it('parses encoder lines', async () => {
    const tool = await writeScript(
      join(dir, 'ffmpeg'),
      `cat <<'EOF'
Encoders:
 ------
 V....D libx264              libx264 H.264 / AVC
 VF.X.. libvpx-vp9           libvpx VP9
 A....D aac                  AAC (Advanced Audio Coding)
 S..... srt                  SubRip subtitle
 not an encoder line
EOF`,
    );
    expect(await listEncoders(tool)).toEqual(['libx264', 'libvpx-vp9', 'aac', 'srt']);
  });

  it('returns an empty list when the tool fails or cannot run', async () => {
    expect(await listEncoders(await writeScript(join(dir, 'broken'), 'exit 2'))).toEqual([]);
    expect(await listEncoders(join(dir, 'missing'))).toEqual([]);
  });
});
