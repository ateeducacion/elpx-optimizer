import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPackage } from '../helpers/elpx-builder.js';
import { E2E_FIXTURES, ROOT } from './helpers.js';

/**
 * Checks the static build and generates the long-video fixture used for
 * cancellation with NATIVE ffmpeg (allowed to create fixtures; the browser
 * does all the processing in the tests).
 */
export default function globalSetup(): void {
  if (!existsSync(join(ROOT, 'dist', 'web', 'index.html'))) throw new Error('dist/web is missing: run "bun run build:web" first');
  mkdirSync(E2E_FIXTURES, { recursive: true });
  const long = join(E2E_FIXTURES, 'long-video.elpx');
  if (existsSync(long)) return;
  const mp4 = join(E2E_FIXTURES, 'long.mp4');
  execFileSync(process.env['ELPX_OPTIMIZER_FFMPEG'] ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=48000',
    '-t',
    '40',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-qp',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    mp4,
  ]);
  const html = '<p><video controls src="{{context_path}}/content/resources/largo.mp4"></video></p>';
  const png = readFileSync(join(ROOT, 'test', 'fixtures', 'media', 'palette-efficient.png'));
  const pages = [
    {
      id: 'page-1',
      name: 'Vídeo largo',
      file: 'index.html',
      blocks: [{ id: 'block-1', name: '', components: [{ id: 'idevice-1', type: 'text', html, json: { textTextarea: html } }] }],
    },
  ];
  writeFileSync(long, buildPackage(new Uint8Array(png), 'Vídeo largo', pages, { 'content/resources/largo.mp4': new Uint8Array(readFileSync(mp4)) }));
}
