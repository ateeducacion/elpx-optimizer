import { errorMessage } from '../../core/errors.js';
import type { ImageVerification } from '../../core/media/engine.js';
import type { ImageJob } from '../../core/media/image-policy.js';

/**
 * Browser image codecs: jSquash builds of MozJPEG, OxiPNG, libwebp and a
 * Rust resizer, all WebAssembly running inside the pipeline worker. They
 * decode without colour conversion and never change the format. Loaded on
 * first use.
 */

export interface RawImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface ImageCodecs {
  decode(format: 'jpeg' | 'png' | 'webp', bytes: Uint8Array): Promise<RawImage>;
  encode(job: ImageJob, original: Uint8Array): Promise<Uint8Array>;
}

export const CODEC_VERSIONS = {
  '@jsquash/jpeg': '1.6.0 (MozJPEG)',
  '@jsquash/oxipng': '2.3.0 (OxiPNG)',
  '@jsquash/png': '3.1.1',
  '@jsquash/webp': '1.5.0 (libwebp)',
  '@jsquash/resize': '2.1.1',
} as const;

function toImageData(img: RawImage): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

/** Default codecs backed by jSquash (single-threaded builds). */
export function createJsquashCodecs(): ImageCodecs {
  let oxipng:
    | Promise<{
        optimise: (d: Uint8Array, level: number, interlace: boolean, alpha: boolean) => Uint8Array;
        optimise_raw: (d: Uint8ClampedArray, w: number, h: number, level: number, interlace: boolean, alpha: boolean) => Uint8Array;
      }>
    | undefined;
  const loadOxipng = () => {
    oxipng ??= (async () => {
      const mod = await import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js');
      await mod.default();
      return { optimise: mod.optimise, optimise_raw: mod.optimise_raw };
    })();
    return oxipng;
  };
  const decode = async (format: 'jpeg' | 'png' | 'webp', bytes: Uint8Array): Promise<RawImage> => {
    const buffer = bytes.slice().buffer;
    let img: ImageData;
    if (format === 'jpeg') img = await (await import('@jsquash/jpeg/decode.js')).default(buffer, { preserveOrientation: false });
    else if (format === 'png') img = await (await import('@jsquash/png/decode.js')).default(buffer);
    else img = await (await import('@jsquash/webp/decode.js')).default(buffer);
    return { data: img.data, width: img.width, height: img.height };
  };
  const resize = async (img: RawImage, width: number, height: number): Promise<RawImage> => {
    const out = await (
      await import('@jsquash/resize')
    ).default(toImageData(img), { width, height, method: 'lanczos3', fitMethod: 'stretch', premultiply: true, linearRGB: true });
    return { data: out.data, width: out.width, height: out.height };
  };
  return {
    decode,
    async encode(job, original) {
      if (job.format === 'png' && !job.resize) {
        const { optimise } = await loadOxipng();
        return optimise(original.slice(), 3, false, false);
      }
      let img = await decode(job.format, original);
      if (job.resize) img = await resize(img, job.resize.width, job.resize.height);
      if (job.format === 'png') {
        const { optimise_raw } = await loadOxipng();
        return optimise_raw(new Uint8ClampedArray(img.data), img.width, img.height, 3, false, false);
      }
      if (job.format === 'jpeg') {
        const encode = (await import('@jsquash/jpeg/encode.js')).default;
        return new Uint8Array(await encode(toImageData(img), { quality: job.quality ?? 82, progressive: true, optimize_coding: true }));
      }
      const encode = (await import('@jsquash/webp/encode.js')).default;
      const options = job.mode === 'lossless' ? { lossless: 1, exact: 1, method: 6 } : { quality: job.quality ?? 82, method: 6 };
      return new Uint8Array(await encode(toImageData(img), options));
    },
  };
}

/** True when any pixel is not fully opaque (RGBA data). */
function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
  return false;
}

/**
 * Decodes original and candidate and compares them: size, exact pixels for
 * lossless jobs without resizing, and kept transparency otherwise. `guard`
 * bounds the candidate decode (a time limit when running in-process).
 */
export async function verifyWithCodecs(
  codecs: ImageCodecs,
  original: Uint8Array,
  candidate: Uint8Array,
  job: ImageJob,
  guard: (p: Promise<RawImage>) => Promise<RawImage> = (p) => p,
): Promise<ImageVerification> {
  const problems: string[] = [];
  let cand: RawImage;
  try {
    cand = await guard(codecs.decode(job.format, candidate));
  } catch (error) {
    return { ok: false, width: 0, height: 0, hasAlpha: false, problems: [`candidate cannot be decoded: ${errorMessage(error)}`] };
  }
  const hasAlpha = hasTransparency(cand.data);
  if (cand.width !== job.expected.width || cand.height !== job.expected.height) {
    problems.push(`size ${cand.width}x${cand.height} instead of ${job.expected.width}x${job.expected.height}`);
  }
  let identicalPixels: boolean | undefined;
  if (job.mode === 'lossless' && !job.resize) {
    const orig = await codecs.decode(job.format, original);
    identicalPixels = orig.data.length === cand.data.length && orig.data.every((v, i) => v === cand.data[i]);
    if (!identicalPixels) problems.push('lossless re-encoding changed pixel values');
  } else if (job.expected.hasAlpha) {
    const orig = await codecs.decode(job.format, original);
    if (hasTransparency(orig.data) && !hasAlpha) problems.push('transparency was lost');
  }
  return {
    ok: problems.length === 0,
    width: cand.width,
    height: cand.height,
    hasAlpha,
    ...(identicalPixels !== undefined ? { identicalPixels } : {}),
    problems,
  };
}
