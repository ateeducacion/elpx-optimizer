import { ElpxError } from '../errors.js';
import { IMAGE_PROFILES, type ImageOptions } from '../media/image-policy.js';
import { RESOLUTION_CAPS, VIDEO_PROFILES, X264_PRESETS, type Preset, type ResolutionCap, type VideoOptions } from '../media/video-policy.js';

/**
 * User-facing options and their normalization. The CLI flags, the web form
 * and the skill all produce an OptionsInput; normalizeOptions validates it and
 * fills every default from the selected profile. Unknown keys are rejected,
 * and there is no way to pass arbitrary FFmpeg arguments.
 */

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
  removeUnused?: 'off' | 'safe';
  deduplicate?: 'off' | 'exact';
  minSavingsPercent?: number;
  minSavingsBytes?: number;
  /** ZIP paths that must be left untouched. */
  exclude?: string[];
}

export interface NormalizedOptions {
  readonly preset: Preset;
  readonly video: VideoOptions;
  readonly images: ImageOptions & { readonly includeScreenshot: boolean };
  readonly removeUnused: 'off' | 'safe';
  readonly deduplicate: 'off' | 'exact';
  readonly exclude: readonly string[];
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
  checkKeys(input, ['preset', 'video', 'images', 'removeUnused', 'deduplicate', 'minSavingsPercent', 'minSavingsBytes', 'exclude'], '');
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
  const removeUnused = input.removeUnused ?? 'off';
  if (removeUnused !== 'off' && removeUnused !== 'safe') invalid('removeUnused must be "off" or "safe"');
  const deduplicate = input.deduplicate ?? 'off';
  if (deduplicate !== 'off' && deduplicate !== 'exact') invalid('deduplicate must be "off" or "exact"');
  const exclude = input.exclude ?? [];
  if (!Array.isArray(exclude) || !exclude.every((p) => typeof p === 'string')) invalid('exclude must be a list of paths');
  return { preset, video, images, removeUnused, deduplicate, exclude: [...new Set(exclude)].sort() };
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
