import { ElpxError } from '../errors.js';
import { IMAGE_PROFILES, type ImageOptions } from '../media/image-policy.js';
import { RESOLUTION_CAPS, VIDEO_PROFILES, X264_PRESETS, type Preset, type ResolutionCap, type VideoOptions } from '../media/video-policy.js';
import { AUDIO_PROFILES, type AudioOptions } from '../media/audio-policy.js';
import { PDF_PROFILES, type PdfOptions } from '../media/pdf-policy.js';
import { SCREENSHOT_MAX_BYTES } from '../format/screenshot.js';

/**
 * User-facing options and their normalization. The CLI flags, the web form
 * and the skill all produce an OptionsInput; normalizeOptions validates it and
 * fills every default from the selected profile. Unknown keys are rejected,
 * and there is no way to pass arbitrary FFmpeg arguments.
 */

/**
 * What the CLI and the web app start from, so both give the same result: unused files removed,
 * repeated files merged and clean file names. normalizeOptions itself keeps everything off
 * unless asked, for programs that call it directly.
 */
export const APP_DEFAULTS = { removeUnused: 'safe', deduplicate: 'exact', normalizeNames: 'slug' } as const satisfies OptionsInput;

export interface OptionsInput {
  preset?: Preset;
  video?: {
    enabled?: boolean;
    crf?: number;
    maxResolution?: ResolutionCap | number | string;
    audioBitrate?: number;
    x264Preset?: string;
    force?: boolean;
    dropDataStreams?: boolean;
  };
  images?: {
    enabled?: boolean;
    jpegQuality?: number;
    webpQuality?: number;
    maxDimension?: number | null;
    png?: boolean;
    stripMetadata?: boolean;
    force?: boolean;
    includeScreenshot?: boolean;
  };
  audio?: {
    enabled?: boolean;
    /** Target bitrate in kb/s for stereo (mono uses half, at least 64). */
    bitrate?: number;
    /** Re-encode MP3/M4A even when their bitrate is close to the target. */
    force?: boolean;
  };
  pdf?: {
    enabled?: boolean;
    /** Let qpdf convert images inside PDFs to JPEG (lossy); by default on except in the conservative preset. */
    images?: boolean;
  };
  /** ODT and ODP attachments: recompress their embedded images with the image options (on by default). */
  odf?: {
    enabled?: boolean;
  };
  removeUnused?: 'off' | 'safe';
  deduplicate?: 'off' | 'exact';
  /** Move files out of eXeLearning 3 editor folders (content/resources/<ODE-ID>/) into content/resources/. */
  flatten?: 'off' | 'legacy';
  /** Take out references to files that do not exist (off by default: missing files are reported, not hidden). */
  missingReferences?: 'keep' | 'remove';
  /** Give user files clean names: lower case, no spaces, accents or copy markers ("Copia de", "(2)"). */
  normalizeNames?: 'off' | 'slug';
  minSavingsPercent?: number;
  minSavingsBytes?: number;
  /** ZIP paths that must be left untouched. */
  exclude?: string[];
  /** A new screenshot.png; its bytes are given when the plan runs and must match this hash and size. */
  screenshot?: ScreenshotReplacement;
}

/** Identifies the PNG that replaces (or adds) screenshot.png. */
export interface ScreenshotReplacement {
  readonly sha256: string;
  readonly size: number;
}

export interface NormalizedOptions {
  readonly preset: Preset;
  readonly video: VideoOptions;
  readonly images: ImageOptions & { readonly includeScreenshot: boolean };
  readonly audio: AudioOptions;
  readonly pdf: PdfOptions;
  readonly odf: { readonly enabled: boolean };
  readonly removeUnused: 'off' | 'safe';
  readonly deduplicate: 'off' | 'exact';
  readonly flatten: 'off' | 'legacy';
  readonly missingReferences: 'keep' | 'remove';
  readonly normalizeNames: 'off' | 'slug';
  readonly exclude: readonly string[];
  readonly screenshot?: ScreenshotReplacement;
}

const PRESETS: readonly Preset[] = ['conservative', 'balanced', 'aggressive'];

function invalid(message: string): never {
  throw new ElpxError('invalid-options', message);
}

function checkKeys(obj: object, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) invalid(`Unknown option ${where}${k}`);
}

function intIn(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid(`${name} must be an integer between ${min} and ${max}`);
  return v;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') invalid(`${name} must be true or false`);
  return v;
}

/** Parses a resolution cap ("720", "1080p", 720, "original"). */
export function parseResolution(v: unknown): ResolutionCap {
  if (v === 'original') return 'original';
  const n = typeof v === 'string' ? Number(v.replace(/p$/i, '')) : v;
  if (typeof n === 'number' && (RESOLUTION_CAPS as readonly number[]).includes(n)) return n as ResolutionCap;
  return invalid(`maxResolution must be one of ${RESOLUTION_CAPS.join(', ')} or "original"`);
}

/** Validates and completes options with the profile defaults. */
export function normalizeOptions(input: OptionsInput = {}): NormalizedOptions {
  if (typeof input !== 'object' || input === null) invalid('Options must be an object');
  checkKeys(
    input,
    [
      'preset',
      'video',
      'images',
      'audio',
      'pdf',
      'odf',
      'removeUnused',
      'deduplicate',
      'flatten',
      'missingReferences',
      'normalizeNames',
      'minSavingsPercent',
      'minSavingsBytes',
      'exclude',
      'screenshot',
    ],
    '',
  );
  const preset = input.preset ?? 'balanced';
  if (!PRESETS.includes(preset)) invalid(`preset must be one of ${PRESETS.join(', ')}`);
  const minPercent = input.minSavingsPercent === undefined ? 5 : intIn(input.minSavingsPercent, 0, 90, 'minSavingsPercent');
  const minBytes = input.minSavingsBytes === undefined ? 1024 : intIn(input.minSavingsBytes, 0, 1_000_000_000, 'minSavingsBytes');
  const v = input.video ?? {};
  if (typeof v !== 'object' || v === null) invalid('video must be an object');
  checkKeys(v, ['enabled', 'crf', 'maxResolution', 'audioBitrate', 'x264Preset', 'force', 'dropDataStreams'], 'video.');
  const vp = VIDEO_PROFILES[preset];
  const x264 = v.x264Preset;
  if (x264 !== undefined && !(X264_PRESETS as readonly string[]).includes(x264)) invalid(`video.x264Preset must be one of ${X264_PRESETS.join(', ')}`);
  const video: VideoOptions = {
    enabled: v.enabled === undefined ? true : bool(v.enabled, 'video.enabled'),
    preset,
    crf: v.crf === undefined ? vp.crf : intIn(v.crf, 16, 35, 'video.crf'),
    maxShortSide: v.maxResolution === undefined ? vp.maxShortSide : parseResolution(v.maxResolution),
    audioBitrateKbps: v.audioBitrate === undefined ? vp.audioBitrateKbps : intIn(v.audioBitrate, 64, 320, 'video.audioBitrate'),
    x264Preset: x264 as VideoOptions['x264Preset'],
    minSavingsPercent: minPercent,
    minSavingsBytes: Math.max(minBytes, 10 * 1024),
    force: v.force === undefined ? false : bool(v.force, 'video.force'),
    dropDataStreams: v.dropDataStreams === undefined ? false : bool(v.dropDataStreams, 'video.dropDataStreams'),
  };
  const i = input.images ?? {};
  if (typeof i !== 'object' || i === null) invalid('images must be an object');
  checkKeys(i, ['enabled', 'jpegQuality', 'webpQuality', 'maxDimension', 'png', 'stripMetadata', 'force', 'includeScreenshot'], 'images.');
  const ip = IMAGE_PROFILES[preset];
  let maxDimension: number | undefined = ip.maxDimension;
  if (i.maxDimension === null) maxDimension = undefined;
  else if (i.maxDimension !== undefined) maxDimension = intIn(i.maxDimension, 64, 20000, 'images.maxDimension');
  const images = {
    enabled: i.enabled === undefined ? true : bool(i.enabled, 'images.enabled'),
    preset,
    jpegQuality: i.jpegQuality === undefined ? ip.jpegQuality : intIn(i.jpegQuality, 30, 100, 'images.jpegQuality'),
    webpQuality: i.webpQuality === undefined ? ip.webpQuality : intIn(i.webpQuality, 30, 100, 'images.webpQuality'),
    maxDimension,
    png: i.png === undefined ? true : bool(i.png, 'images.png'),
    stripMetadata: i.stripMetadata === undefined ? false : bool(i.stripMetadata, 'images.stripMetadata'),
    minSavingsPercent: minPercent,
    minSavingsBytes: minBytes,
    force: i.force === undefined ? false : bool(i.force, 'images.force'),
    includeScreenshot: i.includeScreenshot === undefined ? false : bool(i.includeScreenshot, 'images.includeScreenshot'),
  };
  const au = input.audio ?? {};
  if (typeof au !== 'object' || au === null) invalid('audio must be an object');
  checkKeys(au, ['enabled', 'bitrate', 'force'], 'audio.');
  const audio: AudioOptions = {
    enabled: au.enabled === undefined ? true : bool(au.enabled, 'audio.enabled'),
    preset,
    bitrateKbps: au.bitrate === undefined ? AUDIO_PROFILES[preset].bitrateKbps : intIn(au.bitrate, 64, 320, 'audio.bitrate'),
    minSavingsPercent: minPercent,
    minSavingsBytes: minBytes,
    force: au.force === undefined ? false : bool(au.force, 'audio.force'),
  };
  const pd = input.pdf ?? {};
  if (typeof pd !== 'object' || pd === null) invalid('pdf must be an object');
  checkKeys(pd, ['enabled', 'images'], 'pdf.');
  const pdf: PdfOptions = {
    enabled: pd.enabled === undefined ? true : bool(pd.enabled, 'pdf.enabled'),
    preset,
    images: pd.images === undefined ? PDF_PROFILES[preset].images : bool(pd.images, 'pdf.images'),
    minSavingsPercent: minPercent,
    minSavingsBytes: minBytes,
  };
  const od = input.odf ?? {};
  if (typeof od !== 'object' || od === null) invalid('odf must be an object');
  checkKeys(od, ['enabled'], 'odf.');
  const odf = { enabled: od.enabled === undefined ? true : bool(od.enabled, 'odf.enabled') };
  const removeUnused = input.removeUnused ?? 'off';
  if (removeUnused !== 'off' && removeUnused !== 'safe') invalid('removeUnused must be "off" or "safe"');
  const deduplicate = input.deduplicate ?? 'off';
  if (deduplicate !== 'off' && deduplicate !== 'exact') invalid('deduplicate must be "off" or "exact"');
  const flatten = input.flatten ?? 'off';
  if (flatten !== 'off' && flatten !== 'legacy') invalid('flatten must be "off" or "legacy"');
  const missingReferences = input.missingReferences ?? 'keep';
  if (missingReferences !== 'keep' && missingReferences !== 'remove') invalid('missingReferences must be "keep" or "remove"');
  const normalizeNames = input.normalizeNames ?? 'off';
  if (normalizeNames !== 'off' && normalizeNames !== 'slug') invalid('normalizeNames must be "off" or "slug"');
  const exclude = input.exclude ?? [];
  if (!Array.isArray(exclude) || !exclude.every((p) => typeof p === 'string')) invalid('exclude must be a list of paths');
  const s = input.screenshot;
  let screenshot: ScreenshotReplacement | undefined;
  if (s !== undefined) {
    if (typeof s !== 'object' || s === null) invalid('screenshot must be an object');
    checkKeys(s, ['sha256', 'size'], 'screenshot.');
    if (typeof s.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256)) invalid('screenshot.sha256 must be a lower-case SHA-256 hex digest');
    screenshot = { sha256: s.sha256, size: intIn(s.size, 1, SCREENSHOT_MAX_BYTES, 'screenshot.size') };
  }
  return {
    preset,
    video,
    images,
    audio,
    pdf,
    odf,
    removeUnused,
    deduplicate,
    flatten,
    missingReferences,
    normalizeNames,
    exclude: [...new Set(exclude)].sort(),
    ...(screenshot ? { screenshot } : {}),
  };
}

/** Canonical JSON (sorted keys) used for hashing plans and options. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
