import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the static web app. The servers below serve ONLY
 * dist/web through `elpx-optimizer serve` (GET/HEAD static files, no API):
 * - :4173 plain (no COOP/COEP): single-thread ffmpeg.wasm;
 * - :4174 under the /tools/elpx/ subdirectory;
 * - :4175 with --isolation (COOP/COEP) for the optional multi-thread core.
 * Build first: `bun run build:web` (make e2e does it).
 */
const serve = (port: number, extra: string[] = []) => ({
  command: ['bun', 'src/cli/bin.ts', 'serve', '--host', '127.0.0.1', '--port', String(port), ...extra].join(' '),
  url: `http://127.0.0.1:${port}${extra.includes('--base') ? extra[extra.indexOf('--base') + 1] : '/'}`,
  reuseExistingServer: false,
  timeout: 30_000,
});

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 300_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  globalSetup: './test/e2e/global-setup.ts',
  use: { baseURL: 'http://127.0.0.1:4173/', acceptDownloads: true, trace: 'retain-on-failure' },
  webServer: [serve(4173), serve(4174, ['--base', '/tools/elpx/']), serve(4175, ['--isolation'])],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@cross-browser/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@cross-browser/ },
  ],
});
