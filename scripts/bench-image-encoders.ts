#!/usr/bin/env bun
/**
 * Evaluation used for docs/decisions.md: encodes the same pixels with
 * eXeLearning's vendored Pixo (from the pinned upstream checkout), the jSquash
 * codecs used by the web app and sharp used by the CLI, and prints sizes and
 * the PSNR against the source pixels. Requires scripts/fetch-upstream.sh.
 * Usage: bun scripts/bench-image-encoders.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const root = join(import.meta.dir, '..');
const pixoDir = join(root, '.cache', 'upstream', 'exelearning', 'public', 'libs', 'pixo');
const pixo = await import(join(pixoDir, 'pixo.js'));
pixo.initSync({ module: readFileSync(join(pixoDir, 'pixo_bg.wasm')) });
const jq = join(root, 'node_modules', '@jsquash');
const jpegEnc = await import(join(jq, 'jpeg', 'encode.js'));
await jpegEnc.init(await WebAssembly.compile(readFileSync(join(jq, 'jpeg', 'codec', 'enc', 'mozjpeg_enc.wasm'))));
const oxi = await import(join(jq, 'oxipng', 'codec', 'pkg', 'squoosh_oxipng.js'));
oxi.initSync(readFileSync(join(jq, 'oxipng', 'codec', 'pkg', 'squoosh_oxipng_bg.wasm')));

/** Peak signal-to-noise ratio between two RGB(A) buffers (dB). */
function psnr(a: Uint8Array, b: Uint8Array, channels: number): number {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (channels === 4 && i % 4 === 3) continue;
    const d = a[i]! - b[i]!;
    se += d * d;
    n++;
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

async function decodeRgb(bytes: Uint8Array, channels: 3 | 4): Promise<Uint8Array> {
  const img = sharp(bytes);
  return new Uint8Array(await (channels === 4 ? img.ensureAlpha() : img.removeAlpha()).raw().toBuffer());
}

const rows: string[] = [];
for (const [file, quality] of [
  ['photo-exif-icc.jpg', 82],
  ['progressive.jpg', 82],
] as const) {
  const src = readFileSync(join(root, 'test', 'fixtures', 'media', file));
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data);
  const rgba = new Uint8ClampedArray(info.width * info.height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i]!;
    rgba[j + 1] = rgb[i + 1]!;
    rgba[j + 2] = rgb[i + 2]!;
    rgba[j + 3] = 255;
  }
  const pixoOut = pixo.encodeJpeg(rgb, info.width, info.height, 2, quality, 1, true) as Uint8Array;
  const mozOut = new Uint8Array(
    await jpegEnc.default({ data: rgba, width: info.width, height: info.height, colorSpace: 'srgb' }, { quality, progressive: true, optimize_coding: true }),
  );
  const sharpOut = new Uint8Array(
    await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer(),
  );
  for (const [name, out] of [
    ['Pixo (eXeLearning)', pixoOut],
    ['MozJPEG via jSquash (web)', mozOut],
    ['sharp mozjpeg (CLI)', sharpOut],
  ] as const) {
    rows.push(`| ${file} JPEG q${quality} | ${name} | ${out.length} | ${psnr(rgb, await decodeRgb(out, 3), 3).toFixed(2)} dB |`);
  }
}
{
  const src = readFileSync(join(root, 'test', 'fixtures', 'media', 'alpha-text.png'));
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8Array(data);
  const pixoOut = pixo.encodePng(rgba, info.width, info.height, 3, 2, false) as Uint8Array;
  const oxiOut = oxi.optimise(new Uint8Array(src), 3, false, false) as Uint8Array;
  const sharpOut = new Uint8Array(await sharp(src).png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: false }).toBuffer());
  for (const [name, out] of [
    ['Pixo lossless (eXeLearning)', pixoOut],
    ['OxiPNG via jSquash (web)', oxiOut],
    ['sharp libpng (CLI)', sharpOut],
  ] as const) {
    const same = psnr(rgba, await decodeRgb(out, 4), 4) === Infinity;
    rows.push(`| alpha-text.png (${src.length} B) | ${name} | ${out.length} | ${same ? 'pixel-identical' : 'changed'} |`);
  }
}
console.log('| Input | Encoder | Bytes | Quality |\n| --- | --- | --- | --- |');
console.log(rows.join('\n'));
