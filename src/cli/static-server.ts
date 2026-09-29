import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream';

/**
 * Static file server for the web app. It serves files only (GET/HEAD); any
 * other method is rejected, so there is no way to upload a project. Paths are
 * confined to the root directory.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticServerOptions {
  root: string;
  host: string;
  port: number;
  /** URL prefix under which the app is served (e.g. "/tools/elpx/"). */
  base: string;
  /** Adds Cross-Origin-Opener-Policy/Embedder-Policy headers (enables SharedArrayBuffer). */
  isolation: boolean;
}

/** Maps a request path to a file inside root, or undefined when it escapes or is invalid. */
export function resolveRequestPath(root: string, base: string, urlPath: string): string | undefined {
  if (!urlPath.startsWith(base)) return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.slice(base.length));
  } catch {
    return undefined;
  }
  if (rel.includes('\0') || rel.includes('\\')) return undefined;
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return undefined;
  if (rel === '' || rel.endsWith('/')) parts.push('index.html');
  return join(root, ...parts);
}

/**
 * Opens a regular file that resolves (after symlinks) inside root. Missing,
 * unreadable or escaping paths give undefined, so they are answered as not
 * found instead of failing after the headers were sent.
 */
async function openInside(root: string, file: string): Promise<{ handle: FileHandle; real: string; size: number } | undefined> {
  let handle: FileHandle | undefined;
  try {
    const real = await realpath(file);
    if (!real.startsWith(root + sep)) return undefined;
    handle = await open(real, 'r');
    const info = await handle.stat();
    if (info.isFile()) return { handle, real, size: info.size };
  } catch {
    // Not found or not readable.
  }
  await handle?.close();
  return undefined;
}

/** Security headers applied to every response. */
export function securityHeaders(isolation: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (isolation) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }
  return headers;
}

/** Creates the server (not listening yet). */
export function createStaticServer(options: StaticServerOptions): Server {
  const rootPromise = realpath(options.root);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = securityHeaders(options.isolation);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed: this server only provides static files.\n');
      return;
    }
    const root = await rootPromise;
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === options.base.replace(/\/$/, '') && options.base !== '/') {
      res.writeHead(301, { ...headers, Location: options.base });
      res.end();
      return;
    }
    const file = resolveRequestPath(root, options.base, url.pathname);
    const found = file ? await openInside(root, file) : undefined;
    if (!found) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    const ext = extname(found.real).toLowerCase();
    const immutable = found.real.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      ...headers,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': String(found.size),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      await found.handle.close();
      res.end();
      return;
    }
    // pipeline closes the file and the response on errors and client aborts.
    pipeline(found.handle.createReadStream(), res, () => undefined);
  }
}
