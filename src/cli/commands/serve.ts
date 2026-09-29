import { stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElpxError } from '../../core/errors.js';
import { createStaticServer } from '../static-server.js';
import { EXIT, type ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';
import { intFlag } from '../shared.js';

/** Locates the static web build: --root, ELPX_OPTIMIZER_WEB_ROOT, or dist/web next to the CLI. */
export async function webRoot(explicit: string | undefined, io: CliIO): Promise<{ root: string; relative: string }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = explicit
    ? [resolve(io.cwd, explicit)]
    : [
        io.env['ELPX_OPTIMIZER_WEB_ROOT'],
        resolve(here, '..', 'web'),
        resolve(here, '..', '..', 'dist', 'web'),
        resolve(here, '..', '..', '..', 'dist', 'web'),
      ].filter((c): c is string => typeof c === 'string' && c !== '');
  for (const c of candidates) {
    const ok = await stat(resolve(c, 'index.html')).then(
      (s) => s.isFile(),
      () => false,
    );
    if (ok) return { root: c, relative: relative(io.cwd, c) || '.' };
  }
  throw new ElpxError('io', 'Static web build not found (build it with "make build-web" or pass --root)');
}

/** serve: static hosting of the web app only. */
export async function runServe(values: Record<string, unknown>, io: CliIO): Promise<ExitCode> {
  const host = typeof values['host'] === 'string' ? values['host'] : '127.0.0.1';
  const port = intFlag(values, 'port', 0, 65535) ?? 8080;
  let base = typeof values['base'] === 'string' ? values['base'] : '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  const { root } = await webRoot(typeof values['root'] === 'string' ? values['root'] : undefined, io);
  const server = createStaticServer({ root, host, port, base, isolation: values['isolation'] === true });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });
  const actualPort = (server.address() as AddressInfo).port;
  io.stderr(
    `Serving the static web app from ${root}\nOpen http://${host.includes(':') ? `[${host}]` : host}:${actualPort}${base}\nProjects are processed in the browser; this server has no upload API. Press Ctrl+C to stop.\n`,
  );
  await new Promise<void>((done) => {
    if (io.signal?.aborted) done();
    io.signal?.addEventListener('abort', () => done(), { once: true });
  });
  await new Promise<void>((done) => server.close(() => done()));
  return EXIT.SUCCESS;
}
