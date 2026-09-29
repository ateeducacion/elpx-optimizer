#!/usr/bin/env node
/**
 * Generates the small synthetic media fixtures under test/fixtures/media.
 * Requires native ffmpeg and sharp. The generated files are committed so the
 * ordinary test suite runs without ffmpeg; re-run this script to reproduce
 * them (outputs may differ byte-wise across encoder versions, which is fine).
 *
 * Usage: node scripts/generate-media-fixtures.mjs [--ffmpeg /path/to/ffmpeg]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import * as oxipng from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js';

const require = createRequire(import.meta.url);
oxipng.initSync(readFileSync(require.resolve('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm')));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures', 'media');
const argIndex = process.argv.indexOf('--ffmpeg');
const ffmpeg = argIndex > 0 ? process.argv[argIndex + 1] : process.env.ELPX_OPTIMIZER_FFMPEG || 'ffmpeg';

mkdirSync(out, { recursive: true });

/** Runs ffmpeg with the given arguments (no shell). */
function ff(...args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

/** Builds a PNG chunk with CRC. */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

/** Inserts chunks right after IHDR. */
function insertAfterIhdr(png, chunks) {
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}

/** A gradient with some noise so encoders have real work to do. */
async function gradient(width, height, channels = 3) {
  const data = Buffer.alloc(width * height * channels);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const n = (seed >>> 28) - 8;
      const i = (y * width + x) * channels;
      data[i] = Math.max(0, Math.min(255, Math.round((x / width) * 255) + n));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((y / height) * 255) + n));
      data[i + 2] = Math.max(0, Math.min(255, 128 + n));
      if (channels === 4) data[i + 3] = x < width / 2 ? 255 : Math.round((y / height) * 255);
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:rights>CC BY-SA 4.0 Test Author</dc:rights></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

// --- Images ---
const g = await gradient(320, 240);
// High-quality JPEG with EXIF (orientation 6, authorship), Display P3 ICC profile and XMP.
await g
  .clone()
  .jpeg({ quality: 98, chromaSubsampling: '4:4:4' })
  .withIccProfile('p3')
  .withExif({ IFD0: { Artist: 'Test Author', Copyright: 'CC BY-SA 4.0' } })
  .withMetadata({ orientation: 6 })
  .withXmp(xmp)
  .toFile(join(out, 'photo-exif-icc.jpg'));
// Already efficient JPEG (low quality, should be skipped as already optimized).
await g.clone().jpeg({ quality: 45, mozjpeg: true }).toFile(join(out, 'efficient.jpg'));
// Progressive high-quality JPEG without metadata.
await g.clone().jpeg({ quality: 97, progressive: true }).toFile(join(out, 'progressive.jpg'));
// CMYK JPEG (must be preserved).
await g.clone().toColourspace('cmyk').jpeg({ quality: 95 }).toFile(join(out, 'cmyk.jpg'));
// PNG with alpha, a tEXt authorship chunk and poor compression.
const alphaPng = await (await gradient(200, 150, 4)).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
writeFileSync(
  join(out, 'alpha-text.png'),
  insertAfterIhdr(alphaPng, [pngChunk('tEXt', Buffer.from('Author\0Test Author', 'latin1')), pngChunk('tEXt', Buffer.from('Copyright\0CC BY 4.0', 'latin1'))]),
);
// Palette PNG already well compressed.
await g.clone().png({ palette: true, colours: 16, compressionLevel: 9, effort: 10 }).toFile(join(out, 'palette-efficient.png'));
// PNG already optimized with OxiPNG at a high level: neither engine can shrink it (no-improvement cases).
writeFileSync(join(out, 'optimal.png'), oxipng.optimise(new Uint8Array(readFileSync(join(out, 'alpha-text.png'))), 6, false, false));
// 16-bit PNG (bit depth must be preserved).
await g.clone().toColourspace('rgb16').png({ compressionLevel: 0 }).toFile(join(out, 'deep-16bit.png'));
// Lossy WebP with high quality and EXIF + ICC; lossless WebP with alpha.
await g
  .clone()
  .webp({ quality: 100 })
  .withIccProfile('p3')
  .withExif({ IFD0: { Artist: 'Test Author' } })
  .toFile(join(out, 'lossy-meta.webp'));
await (await gradient(160, 120, 4)).webp({ lossless: true, effort: 0 }).toFile(join(out, 'lossless-alpha.webp'));
// Animated images (must be preserved).
ff('-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=5', '-t', '1', '-plays', '0', '-f', 'apng', join(out, 'animated.png'));
ff('-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=5', '-t', '1', '-loop', '0', '-c:v', 'libwebp_anim', '-f', 'webp', join(out, 'animated.webp'));
ff('-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=5', '-t', '1', '-loop', '0', join(out, 'animated.gif'));
// A PNG file that is really a JPEG (extension mismatch).
writeFileSync(join(out, 'jpeg-named.png'), readFileSync(join(out, 'efficient.jpg')));
// Corrupt JPEG (truncated after the header).
writeFileSync(join(out, 'truncated.jpg'), readFileSync(join(out, 'progressive.jpg')).subarray(0, 600));
// SVG (never rasterized).
writeFileSync(join(out, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>\n');

// --- Video ---
const lavfiVideo = (size, rate = 25) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`];
const lavfiAudio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'];
// Deliberately inefficient H.264 (lossless) + AAC, faststart.
ff(
  ...lavfiVideo('640x360'),
  ...lavfiAudio,
  '-t',
  '4',
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
  '-metadata',
  'title=Inefficient sample',
  join(out, 'inefficient.mp4'),
);
// Already efficient H.264 (low bitrate) -> no improvement expected.
ff(
  ...lavfiVideo('320x180', 15),
  ...lavfiAudio,
  '-t',
  '3',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c:v',
  'libx264',
  '-preset',
  'veryslow',
  '-crf',
  '35',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '32k',
  join(out, 'efficient.mp4'),
);
// Rotated (display matrix 90 degrees), with two audio languages and mov_text subtitles + chapters.
writeFileSync(join(out, 'subs.srt'), '1\n00:00:00,000 --> 00:00:01,500\nHola\n\n2\n00:00:01,500 --> 00:00:03,000\nAdiós\n');
writeFileSync(
  join(out, 'chapters.txt'),
  ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1500\nEND=3000\ntitle=End\n',
);
ff(
  ...lavfiVideo('480x270'),
  ...lavfiAudio,
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:sample_rate=48000',
  '-i',
  join(out, 'subs.srt'),
  '-i',
  join(out, 'chapters.txt'),
  '-t',
  '3',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:a',
  '-map',
  '3:s',
  '-map_metadata',
  '4',
  '-map_chapters',
  '4',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-qp',
  '5',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '96k',
  '-c:s',
  'mov_text',
  '-metadata:s:a:0',
  'language=spa',
  '-metadata:s:a:1',
  'language=eng',
  '-metadata:s:s:0',
  'language=spa',
  join(out, 'rotated-tmp.mp4'),
);
// Stream copy keeps the display matrix set on the input (the pixels are not rotated).
ff(
  '-display_rotation:v:0',
  '90',
  '-i',
  join(out, 'rotated-tmp.mp4'),
  '-map',
  '0:v',
  '-map',
  '0:a',
  '-map',
  '0:s',
  '-c',
  'copy',
  '-map_chapters',
  '0',
  join(out, 'rotated-multi.mp4'),
);
rmSync(join(out, 'rotated-tmp.mp4'));
// MOV with PCM audio (audio must be converted for MP4-compatible output -> planned conversion).
ff(
  ...lavfiVideo('320x240'),
  ...lavfiAudio,
  '-t',
  '2',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c:v',
  'mpeg4',
  '-q:v',
  '1',
  '-c:a',
  'pcm_s16le',
  join(out, 'pcm-audio.mov'),
);
// Video with alpha channel (must be preserved).
ff('-f', 'lavfi', '-i', 'color=c=red@0.5:size=64x48:rate=10,format=rgba', '-t', '1', '-c:v', 'png', join(out, 'alpha.mov'));
// 10-bit video (HDR-like, must be preserved by default).
ff(...lavfiVideo('320x180'), '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', join(out, 'tenbit.mp4'));
// WebM (VP8 + Vorbis/Opus) inefficient.
ff(
  ...lavfiVideo('320x180'),
  ...lavfiAudio,
  '-t',
  '2',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c:v',
  'libvpx',
  '-b:v',
  '4M',
  '-c:a',
  'libopus',
  join(out, 'sample.webm'),
);
// Audio only.
ff(...lavfiAudio, '-t', '2', '-c:a', 'aac', '-b:a', '128k', join(out, 'audio-only.m4a'));
// Uncompressed and lossless recordings (converted to MP3) and a high-bitrate MP3 (re-encoded).
const speech = [
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:sample_rate=44100:duration=3',
  '-f',
  'lavfi',
  '-i',
  'anoisesrc=color=pink:amplitude=0.05:sample_rate=44100:duration=3:seed=7',
];
ff(
  ...speech,
  '-filter_complex',
  '[0:a][1:a]amix=inputs=2,aformat=channel_layouts=stereo',
  '-metadata',
  'title=Tono de prueba',
  '-c:a',
  'pcm_s16le',
  join(out, 'tone.wav'),
);
ff(...speech, '-filter_complex', '[0:a][1:a]amix=inputs=2', '-ac', '1', '-c:a', 'flac', join(out, 'tone.flac'));
ff('-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=22050:duration=1', '-c:a', 'pcm_s16be', '-f', 'aiff', join(out, 'tone.aiff'));
ff(...speech, '-filter_complex', '[0:a][1:a]amix=inputs=2,aformat=channel_layouts=stereo', '-c:a', 'libmp3lame', '-b:a', '320k', join(out, 'tone-320.mp3'));
// Truncated (corrupt) MP4.
writeFileSync(join(out, 'truncated.mp4'), readFileSync(join(out, 'inefficient.mp4')).subarray(0, 4000));
// WebVTT track.
writeFileSync(join(out, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.500\nHola\n');

for (const f of ['chapters.txt']) if (existsSync(join(out, f))) rmSync(join(out, f));
console.log('Media fixtures written to', out);
