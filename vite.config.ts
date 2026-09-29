import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Content-Security-Policy for the built app: only same-origin scripts,
 * workers, WASM and connections, so neither the page nor a project's data can
 * reach another origin. (Vite's dev server injects inline styles, so the
 * policy is only added to production builds.)
 */
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Where the site is published (e.g. https://example.org/elpx/), from
 * ELPX_SITE_URL at build time. Social networks need absolute image URLs in
 * og:image and twitter:image; without it they are relative to the page.
 */
function siteUrlPlugin(): Plugin {
  const raw = process.env['ELPX_SITE_URL']?.trim() ?? '';
  const site = raw === '' ? './' : raw.endsWith('/') ? raw : `${raw}/`;
  return {
    name: 'elpx-site-url',
    transformIndexHtml(html) {
      const withUrl =
        raw === '' ? html : html.replace('<meta property="og:type"', `<meta property="og:url" content="${site}" />\n    <meta property="og:type"`);
      return withUrl.replaceAll('__ELPX_SITE_URL__', site);
    },
  };
}

function cspPlugin(): Plugin {
  return {
    name: 'elpx-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

/** Copies license texts of redistributed components into dist/web/licenses. */
function licensesPlugin(): Plugin {
  const files: [string, string][] = [
    ['LICENSE', 'elpx-optimizer-AGPL-3.0.txt'],
    ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.txt'],
    ['licenses/GPL-2.0.txt', 'ffmpeg-core-GPL-2.0.txt'],
    ['licenses/ffmpeg.wasm-MIT.txt', 'ffmpeg.wasm-MIT.txt'],
    ['licenses/qpdf-wasm-NOTICES.txt', 'qpdf-wasm-NOTICES.txt'],
    ['node_modules/@jsquash/jpeg/codec/LICENSE.codec.md', 'mozjpeg-libjpeg-turbo.txt'],
    ['node_modules/@jsquash/webp/codec/LICENSE.codec.md', 'libwebp.txt'],
    ['node_modules/@jsquash/png/codec/LICENSE.codec.md', 'png-codec.txt'],
    ['node_modules/@jsquash/oxipng/codec/LICENSE.codec.md', 'oxipng.txt'],
    ['node_modules/@jsquash/resize/lib/resize/LICENSE.codec.md', 'resize.txt'],
    ['node_modules/@jsquash/resize/lib/hqx/LICENSE.codec.md', 'hqx.txt'],
    ['node_modules/@jsquash/resize/lib/magic-kernel/LICENSE.codec.md', 'magic-kernel.txt'],
    ['node_modules/@jsquash/jpeg/LICENSE', 'jsquash-Apache-2.0.txt'],
    ['node_modules/@fontsource/atkinson-hyperlegible/LICENSE', 'atkinson-hyperlegible-OFL-1.1.txt'],
    ['node_modules/bootstrap/LICENSE', 'bootstrap-MIT.txt'],
    ['node_modules/bootstrap-icons/LICENSE', 'bootstrap-icons-MIT.txt'],
    ['node_modules/fflate/LICENSE', 'fflate-MIT.txt'],
    ['node_modules/parse5/LICENSE', 'parse5-MIT.txt'],
    ['node_modules/entities/LICENSE', 'entities-BSD-2-Clause.txt'],
    ['node_modules/@noble/hashes/LICENSE', 'noble-hashes-MIT.txt'],
    ['node_modules/wasm-feature-detect/LICENSE', 'wasm-feature-detect-Apache-2.0.txt'],
  ];
  return {
    name: 'elpx-licenses',
    apply: 'build',
    closeBundle() {
      const out = join(import.meta.dirname, 'dist', 'web', 'licenses');
      mkdirSync(out, { recursive: true });
      for (const [from, to] of files) {
        try {
          copyFileSync(join(import.meta.dirname, from), join(out, to));
        } catch {
          // Optional files that a package may not ship.
        }
      }
    },
  };
}

/**
 * qpdf's Emscripten module requires fs, path and crypto only when it runs
 * under Node; in the browser build they resolve to an empty module (instead
 * of Vite's "externalized for browser compatibility" stubs and warnings).
 */
function qpdfNodeBuiltinsPlugin(): Plugin {
  const EMPTY = '\0elpx-empty-node-builtin';
  return {
    name: 'elpx-qpdf-node-builtins',
    enforce: 'pre',
    resolveId(id, importer) {
      return importer?.includes('@neslinesli93/qpdf-wasm') && ['fs', 'path', 'crypto'].includes(id) ? EMPTY : null;
    },
    load(id) {
      return id === EMPTY ? 'export default {};' : null;
    },
  };
}

export default defineConfig({
  root: 'src/web',
  base: './',
  publicDir: 'public',
  plugins: [cspPlugin(), siteUrlPlugin(), licensesPlugin()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2048,
    sourcemap: false,
  },
  css: {
    // Bootstrap 5.3's Sass still uses @import and global functions; its deprecation notices are not ours.
    preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'] } },
  },
  worker: { format: 'es', plugins: () => [qpdfNodeBuiltinsPlugin()] },
  optimizeDeps: {
    include: ['@neslinesli93/qpdf-wasm'],
    exclude: [
      '@ffmpeg/ffmpeg',
      '@ffmpeg/util',
      '@ffmpeg/core',
      '@ffmpeg/core-mt',
      '@jsquash/jpeg',
      '@jsquash/png',
      '@jsquash/oxipng',
      '@jsquash/webp',
      '@jsquash/resize',
    ],
  },
  server: { fs: { allow: ['../..'] } },
});
