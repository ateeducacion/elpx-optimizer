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
    ['node_modules/@jsquash/jpeg/codec/LICENSE.codec.md', 'mozjpeg-libjpeg-turbo.txt'],
    ['node_modules/@jsquash/webp/codec/LICENSE.codec.md', 'libwebp.txt'],
    ['node_modules/@jsquash/png/codec/LICENSE.codec.md', 'png-codec.txt'],
    ['node_modules/@jsquash/oxipng/codec/LICENSE.codec.md', 'oxipng.txt'],
    ['node_modules/@jsquash/resize/lib/resize/LICENSE.codec.md', 'resize.txt'],
    ['node_modules/@jsquash/resize/lib/hqx/LICENSE.codec.md', 'hqx.txt'],
    ['node_modules/@jsquash/resize/lib/magic-kernel/LICENSE.codec.md', 'magic-kernel.txt'],
    ['node_modules/@jsquash/jpeg/LICENSE', 'jsquash-Apache-2.0.txt'],
    ['node_modules/@fontsource/atkinson-hyperlegible/LICENSE', 'atkinson-hyperlegible-OFL-1.1.txt'],
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

export default defineConfig({
  root: 'src/web',
  base: './',
  publicDir: false,
  plugins: [cspPlugin(), licensesPlugin()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2048,
    sourcemap: false,
  },
  worker: { format: 'es' },
  optimizeDeps: {
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
