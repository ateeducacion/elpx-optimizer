import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharpConstructor } from 'sharp';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type * as ServeModule from '../../../src/cli/commands/serve.js';
import type { CliRun } from '../../helpers/cli.js';
import { captureIO } from '../../helpers/cli.js';

/**
 * doctor paths that need a broken sharp or a missing web build. Modules are
 * re-imported after each mock so the CLI sees the replacement.
 */

interface DoctorJson {
  ok: boolean;
  capabilities: Record<string, { available: boolean; reason?: string; root?: string }>;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** Runs doctor through a freshly imported main(). */
async function doctor(args: string[]): Promise<CliRun> {
  const { main } = await import('../../../src/cli/main.js');
  const { io, out, err } = captureIO();
  const code = await main(['doctor', '--ffmpeg', '/nonexistent/ffmpeg', ...args], io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** A sharp stand-in whose encode always fails. */
function failingSharp(): SharpConstructor {
  const chain: Record<string, unknown> = {};
  for (const m of ['keepIccProfile', 'resize', 'jpeg', 'png', 'webp']) chain[m] = () => chain;
  chain['toBuffer'] = () => Promise.reject(new Error('libvips: encode failed'));
  return Object.assign(() => chain, { versions: { sharp: '0.0.0', vips: '0.0.0' } }) as unknown as SharpConstructor;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('sharp');
  vi.doUnmock('../../../src/cli/commands/serve.js');
});

describe('doctor without a usable sharp', () => {
  it('reports a sharp that cannot be loaded', async () => {
    vi.doMock('sharp', () => {
      throw new Error('Could not load the "sharp" module using the darwin-arm64 runtime');
    });
    const json = await doctor(['--json']);
    expect(json.code).toBe(EXIT.DEPENDENCY);
    const report = JSON.parse(json.stdout) as DoctorJson;
    expect(report.capabilities['image']).toMatchObject({ available: false, reason: 'sharp could not be loaded' });
    expect(report.checks.find((c) => c.name === 'image-encode')).toMatchObject({ ok: false, detail: 'sharp could not be loaded' });
    const text = await doctor([]);
    expect(text.stdout).toContain('✗ images: sharp could not be loaded\n');
  });

  it('reports a sharp whose encode fails', async () => {
    vi.doMock('sharp', () => ({ default: failingSharp() }));
    const json = await doctor(['--json']);
    const report = JSON.parse(json.stdout) as DoctorJson;
    expect(report.checks.find((c) => c.name === 'image-encode')).toMatchObject({ ok: false, detail: 'libvips: encode failed' });
    expect(report.capabilities['image']!.available).toBe(false);
    const text = await doctor([]);
    expect(text.stdout).toContain('✗ images: unavailable\n');
  });
});

describe('doctor without the web build', () => {
  it('reports the missing static files', async () => {
    vi.doMock('../../../src/cli/commands/serve.js', async (importOriginal) => ({
      ...(await importOriginal<typeof ServeModule>()),
      webRoot: () => Promise.reject(new Error('Static web build not found')),
    }));
    const json = await doctor(['--json']);
    expect((JSON.parse(json.stdout) as DoctorJson).capabilities['web']).toEqual({ available: false, root: '' });
    const text = await doctor([]);
    expect(text.stdout).toContain('✗ web app: dist/web not built (run: make build-web)\n');
  });
});
