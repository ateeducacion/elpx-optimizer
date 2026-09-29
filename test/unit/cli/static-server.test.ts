import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createStaticServer, resolveRequestPath, securityHeaders } from '../../../src/cli/static-server.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { webRoot } from '../../../src/cli/commands/serve.js';
import { captureIO, removeDir, runCli, tempDir } from '../../helpers/cli.js';

let base: string;
let root: string;

/** Minimal HTTP client that sends the path verbatim (no URL normalization). */
function send(port: number, method: string, path: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' || method === 'PUT' ? 'payload' : undefined);
  });
}

/** Starts a static server on an ephemeral port. */
async function start(options: { base?: string; isolation?: boolean } = {}): Promise<{ server: Server; port: number }> {
  const server = createStaticServer({ root, host: '127.0.0.1', port: 0, base: options.base ?? '/', isolation: options.isolation ?? false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Stops a server. */
function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

beforeAll(async () => {
  base = await tempDir('elpx-serve-');
  root = join(base, 'web');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await mkdir(join(root, 'empty'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(join(root, 'docs', 'index.html'), 'docs');
  await writeFile(join(root, 'ffmpeg-core.wasm'), new Uint8Array([0, 0x61, 0x73, 0x6d]));
  await writeFile(join(root, 'assets', 'app-1234.js'), 'console.log(1)');
  await writeFile(join(root, 'data.unknownext'), 'bytes');
  await writeFile(join(root, 'large.bin'), new Uint8Array(4 * 1024 * 1024).fill(7));
  await writeFile(join(root, 'locked.js'), 'unreadable');
  await chmod(join(root, 'locked.js'), 0o000);
  await writeFile(join(base, 'secret.txt'), 'top secret');
  await symlink(join(base, 'secret.txt'), join(root, 'escape.txt'));
});
afterAll(async () => {
  await removeDir(base);
});

describe('resolveRequestPath', () => {
  it('maps paths under the base to files in the root', () => {
    expect(resolveRequestPath('/r', '/', '/')).toBe(join('/r', 'index.html'));
    expect(resolveRequestPath('/r', '/', '/a/./b.js')).toBe(join('/r', 'a', 'b.js'));
    expect(resolveRequestPath('/r', '/', '/docs/')).toBe(join('/r', 'docs', 'index.html'));
    expect(resolveRequestPath('/r', '/app/', '/app/')).toBe(join('/r', 'index.html'));
    expect(resolveRequestPath('/r', '/', '/caf%C3%A9.png')).toBe(join('/r', 'café.png'));
  });

  it.each(['/../secret.txt', '/a/../../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/a%00.html', '/a%5c..%5csecret.txt', '/a\\b', '/%E0%A4%A'])(
    'rejects %s',
    (path) => {
      expect(resolveRequestPath('/r', '/', path)).toBeUndefined();
    },
  );

  it('rejects paths outside the base', () => {
    expect(resolveRequestPath('/r', '/app/', '/other/index.html')).toBeUndefined();
  });
});

describe('securityHeaders', () => {
  it('always sets the hardening headers and COOP/COEP only with isolation', () => {
    const plain = securityHeaders(false);
    expect(plain).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    expect(securityHeaders(true)).toEqual({ ...plain, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  });
});

describe('createStaticServer', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    ({ server, port } = await start());
  });
  afterAll(async () => {
    await stop(server);
  });

  it('serves index.html with security headers and no caching', async () => {
    const r = await send(port, 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toBe('<!doctype html><title>app</title>');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cross-origin-opener-policy']).toBeUndefined();
    expect((await send(port, 'GET', '/index.html?v=1')).status).toBe(200);
    expect((await send(port, 'GET', '/docs/')).body).toBe('docs');
  });

  it('answers HEAD without a body', async () => {
    const r = await send(port, 'HEAD', '/index.html');
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe('33');
    expect(r.body).toBe('');
  });

  it('serves WebAssembly with its MIME type and hashed assets as immutable', async () => {
    const wasm = await send(port, 'GET', '/ffmpeg-core.wasm');
    expect(wasm.headers['content-type']).toBe('application/wasm');
    expect(wasm.headers['content-length']).toBe('4');
    expect((await send(port, 'HEAD', '/ffmpeg-core.wasm')).headers['content-type']).toBe('application/wasm');
    const asset = await send(port, 'GET', '/assets/app-1234.js');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await send(port, 'GET', '/data.unknownext')).headers['content-type']).toBe('application/octet-stream');
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('rejects %s: there is no upload API', async (method) => {
    const r = await send(port, method, '/index.html');
    expect(r.status).toBe(405);
    expect(r.headers['allow']).toBe('GET, HEAD');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).toMatch(/only provides static files/);
  });

  it.each([
    '/../secret.txt',
    '/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/index.html%00',
    '/%00',
    '/..%5csecret.txt',
    '/%E0%A4%A',
    '/escape.txt',
    '/missing.js',
    '/empty',
    '/empty/',
  ])('answers 404 for %s', async (path) => {
    const r = await send(port, 'GET', path);
    expect(r.status).toBe(404);
    expect(r.body).toBe('Not found\n');
    expect(r.body).not.toContain('secret');
  });

  it.skipIf(process.getuid?.() === 0)('answers 404 for an unreadable file and keeps serving', async () => {
    const r = await send(port, 'GET', '/locked.js');
    expect(r.status).toBe(404);
    expect((await send(port, 'HEAD', '/locked.js')).status).toBe(404);
    expect((await send(port, 'GET', '/')).status).toBe(200);
  });

  it('streams large files completely and survives aborted downloads', async () => {
    const r = await send(port, 'GET', '/large.bin');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(4 * 1024 * 1024);
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/large.bin' }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => undefined);
      req.end();
    });
    expect((await send(port, 'GET', '/')).status).toBe(200);
  });

  it('handles a request without a URL', async () => {
    const heads: [number, Record<string, string>][] = [];
    const done = new Promise<void>((resolve) => {
      const res = {
        writeHead: (status: number, headers: Record<string, string>) => heads.push([status, headers]),
        end: () => resolve(),
      } as unknown as ServerResponse;
      server.emit('request', { method: 'HEAD' } as IncomingMessage, res);
    });
    await done;
    expect(heads[0]![0]).toBe(200);
  });
});

describe('createStaticServer with a base path and isolation', () => {
  it('serves under the base, redirects the bare prefix and adds COOP/COEP', async () => {
    const { server, port } = await start({ base: '/sub/', isolation: true });
    try {
      const redirect = await send(port, 'GET', '/sub');
      expect(redirect.status).toBe(301);
      expect(redirect.headers['location']).toBe('/sub/');
      const index = await send(port, 'GET', '/sub/');
      expect(index.status).toBe(200);
      expect(index.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(index.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect((await send(port, 'GET', '/sub/ffmpeg-core.wasm')).headers['content-type']).toBe('application/wasm');
      expect((await send(port, 'GET', '/')).status).toBe(404);
      expect((await send(port, 'GET', '/index.html')).status).toBe(404);
      expect((await send(port, 'GET', '/sub/../secret.txt')).status).toBe(404);
    } finally {
      await stop(server);
    }
  });
});

describe('webRoot', () => {
  it('uses --root relative to the working directory', async () => {
    const { io } = captureIO({ cwd: base });
    expect(await webRoot('web', io)).toEqual({ root: root, relative: 'web' });
    const { io: inside } = captureIO({ cwd: root });
    expect(await webRoot('.', inside)).toEqual({ root, relative: '.' });
  });

  it('uses ELPX_OPTIMIZER_WEB_ROOT before the build next to the CLI', async () => {
    const { io } = captureIO({ cwd: base, env: { ELPX_OPTIMIZER_WEB_ROOT: root } });
    expect((await webRoot(undefined, io)).root).toBe(root);
  });

  it('fails when no candidate has an index.html', async () => {
    const { io } = captureIO({ cwd: base });
    await expect(webRoot('empty-or-missing', io)).rejects.toMatchObject({
      code: 'io',
      message: 'Static web build not found (build it with "make build-web" or pass --root)',
    });
  });
});

describe('serve command', () => {
  /** Runs `serve` until the URL is printed, then returns the port and a stopper. */
  async function serve(args: string[], cwd = base): Promise<{ port: number; url: string; stop: () => Promise<{ code: number; stderr: string }> }> {
    const controller = new AbortController();
    let resolveUrl: (url: string) => void = () => undefined;
    const printed = new Promise<string>((resolve) => (resolveUrl = resolve));
    const running = runCli(['serve', ...args], {
      cwd,
      signal: controller.signal,
      onStderr: (t) => {
        const m = /Open (\S+)/.exec(t);
        if (m) resolveUrl(m[1]!);
      },
    });
    const url = await Promise.race([printed, running.then((r) => Promise.reject(new Error(`serve exited early: ${r.stderr}`)))]);
    const stop = async (): Promise<{ code: number; stderr: string }> => {
      controller.abort();
      return running;
    };
    return { port: Number(new URL(url).port), url, stop };
  }

  it('serves the web root until the signal aborts', async () => {
    const s = await serve(['--root', 'web', '--port', '0', '--host', '127.0.0.1']);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/`);
    expect((await send(s.port, 'GET', '/')).status).toBe(200);
    expect((await send(s.port, 'POST', '/')).status).toBe(405);
    const r = await s.stop();
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stderr).toMatch(/Serving the static web app from .*web\n/);
    expect(r.stderr).toMatch(/no upload API/);
    await expect(send(s.port, 'GET', '/')).rejects.toThrow();
  });

  it('normalizes --base and enables --isolation', async () => {
    const s = await serve(['--root', root, '--port', '0', '--base', 'tools/elpx', '--isolation']);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/tools/elpx/`);
    const r = await send(s.port, 'GET', '/tools/elpx');
    expect(r.status).toBe(301);
    expect(r.headers['location']).toBe('/tools/elpx/');
    expect((await send(s.port, 'GET', '/tools/elpx/')).headers['cross-origin-embedder-policy']).toBe('require-corp');
    await s.stop();
  });

  it('brackets IPv6 hosts in the printed URL', async () => {
    const s = await serve(['--root', root, '--port', '0', '--host', '::1']).catch(() => undefined);
    if (!s) return; // no IPv6 loopback on this machine
    expect(s.url).toBe(`http://[::1]:${s.port}/`);
    await s.stop();
  });

  it('finds the web root through ELPX_OPTIMIZER_WEB_ROOT and defaults to port 8080', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runCli(['serve'], { cwd: base, env: { ELPX_OPTIMIZER_WEB_ROOT: root }, signal: controller.signal });
    // Port 8080 may be taken on this machine: either way the default was used.
    expect(r.stderr).toMatch(/Open http:\/\/127\.0\.0\.1:8080\/|EADDRINUSE.*8080/);
    if (r.code === EXIT.SUCCESS) expect(r.stderr).toContain(`Serving the static web app from ${root}`);
  });

  it('stops immediately when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runCli(['serve', '--root', root, '--port', '0'], { signal: controller.signal });
    expect(r.code).toBe(EXIT.SUCCESS);
  });

  it('reports a missing web root and a busy port', async () => {
    const missing = await runCli(['serve', '--root', join(base, 'nope'), '--port', '0']);
    expect(missing.code).toBe(EXIT.FAILURE);
    expect(missing.stderr).toMatch(/Static web build not found/);
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    try {
      const r = await runCli(['serve', '--root', root, '--port', String((busy.address() as AddressInfo).port)]);
      expect(r.code).toBe(EXIT.FAILURE);
      expect(r.stderr).toMatch(/EADDRINUSE/);
    } finally {
      await stop(busy);
    }
  });

  it('rejects invalid ports', async () => {
    expect((await runCli(['serve', '--root', root, '--port', '70000'])).code).toBe(EXIT.USAGE);
    expect((await runCli(['serve', '--root', root, '--port', 'http'])).code).toBe(EXIT.USAGE);
  });
});
