import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * Two projects share one V8 coverage report (no double counting: each source
 * file runs in the environment where it belongs):
 * - node: core, native adapters, CLI, skill wrapper;
 * - browser: browser adapters, workers' logic and the UI, in real Chromium
 *   (V8 coverage over CDP), with the real ffmpeg.wasm and WASM codecs.
 */
const critical = { lines: 90, statements: 90, functions: 90, branches: 90 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
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
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            screenshotFailures: false,
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'skills/elpx-optimizer/scripts/**/*.mjs'],
      exclude: [
        // Type declarations only (no runtime code).
        'src/**/*.d.ts',
      ],
      reporter: ['text-summary', 'text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
        'src/core/parse/**': critical,
        'src/core/refs/**': critical,
        'src/core/plan/**': critical,
        'src/core/zip/**': critical,
        'src/core/optimize/**': critical,
      },
    },
  },
});
