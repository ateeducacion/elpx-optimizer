#!/usr/bin/env node
/**
 * Measures in-browser optimization of large videos (docs/web.md): starts
 * `elpx-optimizer serve` (plain and --isolation), drives headless Chromium
 * through the real UI and records analysis time, optimization time, sizes and
 * the peak resident memory of the browser processes (sampled with ps).
 * Usage: node scripts/measure-web.mjs file.elpx [...]   (build dist/web first)
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2);
const servers = [
  spawn('bun', ['src/cli/bin.ts', 'serve', '--port', '4280'], { stdio: 'ignore' }),
  spawn('bun', ['src/cli/bin.ts', 'serve', '--port', '4281', '--isolation'], { stdio: 'ignore' }),
];
await new Promise((r) => setTimeout(r, 1500));

/** Sum of RSS (MiB) of the given process ids (this browser only). */
function rssOf(pids) {
  if (pids.length === 0) return 0;
  const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')]).toString();
  return Math.round(out.split('\n').reduce((s, l) => s + (Number(l.trim()) || 0), 0) / 1024);
}

const rows = [];
const browser = await chromium.launch();
try {
  for (const file of files) {
    for (const [mode, port] of [
      ['single', 4280],
      ['multi', 4281],
    ]) {
      const page = await browser.newPage({ acceptDownloads: true });
      let peak = 0;
      const cdp = await browser.newBrowserCDPSession();
      const timer = setInterval(async () => {
        try {
          const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
          peak = Math.max(peak, rssOf(processInfo.map((p) => p.id)));
        } catch {
          // the sampler is best effort
        }
      }, 1000);
      const t0 = Date.now();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.setInputFiles('#file-input', file);
      await page.waitForSelector('.inventory', { timeout: 600_000 });
      const analyzeMs = Date.now() - t0;
      await page.click('form.options button[type=submit]');
      await page.waitForSelector('.step-step4');
      const t1 = Date.now();
      await page.click('.step-step4 .button.primary');
      await page.waitForSelector('.result-status, .step-error', { timeout: 3_600_000 });
      const optimizeMs = Date.now() - t1;
      clearInterval(timer);
      let report;
      if (await page.$('[data-testid=download-report]')) {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=download-report]')]);
        report = JSON.parse(readFileSync(await dl.path(), 'utf8'));
      }
      const video = report?.operations.find((o) => o.op === 'transcode-video');
      rows.push({
        file: basename(file),
        mode,
        engine: (await page.textContent('.engine-line'))?.trim(),
        analyzeS: (analyzeMs / 1000).toFixed(1),
        optimizeS: (optimizeMs / 1000).toFixed(1),
        status: report?.status ?? (await page.textContent('.step-error')),
        video: video ? `${(video.before / 1048576).toFixed(1)} → ${video.after ? (video.after / 1048576).toFixed(1) : '?'} MiB (${video.status})` : 'n/a',
        peakBrowserRssMiB: peak,
      });
      console.log(rows.at(-1));
      await page.close();
    }
  }
} finally {
  await browser.close();
  for (const s of servers) s.kill();
}
console.log('\n| File | Core | Analysis (s) | Optimization (s) | Video | Peak browser RSS (MiB) | Status |\n| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${r.file} | ${r.mode} | ${r.analyzeS} | ${r.optimizeS} | ${r.video} | ${r.peakBrowserRssMiB} | ${r.status} |`);
