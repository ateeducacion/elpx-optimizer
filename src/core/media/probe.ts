/**
 * Normalization of ffprobe JSON output. Both engines run a real ffprobe
 * (native binary or the ffmpeg.wasm ffprobe entry point) with the same
 * arguments and feed its JSON through this module, so stream decisions are
 * made from identical data structures.
 */

/** Arguments for ffprobe that produce the JSON parsed here (input path appended by the engine). */
export const FFPROBE_ARGS: readonly string[] = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters'];

export type StreamType = 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown';

export interface ProbeStream {
  readonly index: number;
  readonly type: StreamType;
  readonly codec: string;
  readonly codecTag?: string;
  readonly profile?: string;
  readonly width?: number;
  readonly height?: number;
  readonly pixFmt?: string;
  readonly fieldOrder?: string;
  readonly frameRate?: number;
  readonly duration?: number;
  readonly bitRate?: number;
  readonly frames?: number;
  readonly channels?: number;
  readonly channelLayout?: string;
  readonly sampleRate?: number;
  readonly language?: string;
  readonly title?: string;
  readonly handler?: string;
  readonly rotation: number;
  readonly sampleAspectRatio?: string;
  readonly colorTransfer?: string;
  readonly colorPrimaries?: string;
  readonly colorSpace?: string;
  readonly bitsPerRawSample?: number;
  readonly attachedPic: boolean;
  readonly isDefault: boolean;
  readonly alphaMode: boolean;
}

export interface ProbeResult {
  readonly formatName: string;
  readonly duration?: number;
  readonly bitRate?: number;
  readonly size?: number;
  readonly streams: readonly ProbeStream[];
  readonly chapters: number;
  readonly tags: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && v !== 'N/A') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Parses a rational like "30000/1001" into a number. */
export function parseRational(v: unknown): number | undefined {
  if (typeof v !== 'string') return num(v);
  const m = /^(-?\d+)\/(\d+)$/.exec(v);
  if (!m) return num(v);
  const den = Number(m[2]);
  if (den === 0) return undefined;
  const value = Number(m[1]) / den;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Converts ffprobe JSON (already parsed) into a ProbeResult; throws on unusable input. */
export function normalizeProbe(raw: unknown): ProbeResult {
  if (!raw || typeof raw !== 'object') throw new Error('ffprobe returned no data');
  const root = raw as Json;
  const format = (root['format'] ?? {}) as Json;
  const streamsRaw = Array.isArray(root['streams']) ? (root['streams'] as Json[]) : [];
  const chaptersRaw = Array.isArray(root['chapters']) ? root['chapters'] : [];
  if (!text(format['format_name']) && streamsRaw.length === 0) throw new Error('ffprobe could not identify the media');
  const streams = streamsRaw.map((s): ProbeStream => {
    const tags = (s['tags'] ?? {}) as Json;
    const disposition = (s['disposition'] ?? {}) as Json;
    const sideData = Array.isArray(s['side_data_list']) ? (s['side_data_list'] as Json[]) : [];
    let rotation = 0;
    for (const sd of sideData) {
      const r = num(sd['rotation']);
      if (r !== undefined) rotation = r;
    }
    const legacyRotate = num(tags['rotate']);
    if (legacyRotate !== undefined && rotation === 0) rotation = -legacyRotate;
    const type = text(s['codec_type']);
    const pixFmt = text(s['pix_fmt']);
    const stream: ProbeStream = {
      index: num(s['index']) ?? -1,
      type: type === 'video' || type === 'audio' || type === 'subtitle' || type === 'data' || type === 'attachment' ? type : 'unknown',
      codec: text(s['codec_name']) ?? 'unknown',
      rotation: normalizeRotation(rotation),
      attachedPic: disposition['attached_pic'] === 1,
      isDefault: disposition['default'] === 1,
      alphaMode: tags['alpha_mode'] === '1' || tags['ALPHA_MODE'] === '1',
      ...opt('codecTag', text(s['codec_tag_string'])),
      ...opt('profile', text(s['profile'])),
      ...opt('width', num(s['width'])),
      ...opt('height', num(s['height'])),
      ...opt('pixFmt', pixFmt),
      ...opt('fieldOrder', text(s['field_order'])),
      ...opt('frameRate', parseRational(s['avg_frame_rate']) ?? parseRational(s['r_frame_rate'])),
      ...opt('duration', num(s['duration'])),
      ...opt('bitRate', num(s['bit_rate'])),
      ...opt('frames', num(s['nb_frames'])),
      ...opt('channels', num(s['channels'])),
      ...opt('channelLayout', text(s['channel_layout'])),
      ...opt('sampleRate', num(s['sample_rate'])),
      ...opt('language', text(tags['language'])),
      ...opt('title', text(tags['title'])),
      ...opt('handler', text(tags['handler_name'])),
      ...opt('sampleAspectRatio', text(s['sample_aspect_ratio'])),
      ...opt('colorTransfer', text(s['color_transfer'])),
      ...opt('colorPrimaries', text(s['color_primaries'])),
      ...opt('colorSpace', text(s['color_space'])),
      ...opt('bitsPerRawSample', num(s['bits_per_raw_sample'])),
    };
    return stream;
  });
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries((format['tags'] ?? {}) as Json)) if (typeof v === 'string') tags[k] = v;
  return {
    formatName: text(format['format_name']) ?? 'unknown',
    streams,
    chapters: chaptersRaw.length,
    tags,
    ...opt('duration', num(format['duration'])),
    ...opt('bitRate', num(format['bit_rate'])),
    ...opt('size', num(format['size'])),
  };
}

/** Parses ffprobe JSON text and normalizes it. */
export function parseProbeJson(json: string): ProbeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('ffprobe output is not valid JSON');
  }
  return normalizeProbe(raw);
}

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Normalizes a rotation to one of 0, 90, 180, 270 (other angles are kept as-is modulo 360). */
export function normalizeRotation(deg: number): number {
  const r = ((Math.round(deg) % 360) + 360) % 360;
  return r;
}

/** Returns the primary (non-cover-art) video streams. */
export function videoStreams(p: ProbeResult): ProbeStream[] {
  return p.streams.filter((s) => s.type === 'video' && !s.attachedPic);
}

/** Returns the effective duration: container duration or the longest stream. */
export function effectiveDuration(p: ProbeResult): number | undefined {
  if (p.duration !== undefined && p.duration > 0) return p.duration;
  let max: number | undefined;
  for (const s of p.streams) if (s.duration !== undefined && (max === undefined || s.duration > max)) max = s.duration;
  return max;
}

/** Pixel formats that carry an alpha channel. */
export function hasAlphaPixFmt(pixFmt: string | undefined): boolean {
  if (!pixFmt) return false;
  return /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(pixFmt) || pixFmt.includes('a64') || pixFmt === 'ayuv64le';
}

/** Pixel formats with more than 8 bits per component. */
export function isHighBitDepth(stream: ProbeStream): boolean {
  if (stream.bitsPerRawSample !== undefined && stream.bitsPerRawSample > 8) return true;
  return /(p9|p10|p12|p14|p16|48|64)(le|be)?$/.test(stream.pixFmt ?? '');
}

/** Transfer characteristics used by HDR video. */
export function isHdr(stream: ProbeStream): boolean {
  return stream.colorTransfer === 'smpte2084' || stream.colorTransfer === 'arib-std-b67';
}
