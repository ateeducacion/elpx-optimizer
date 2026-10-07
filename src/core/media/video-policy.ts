import type { Limits } from '../limits.js';
import { effectiveDuration, hasAlphaPixFmt, isHdr, isHighBitDepth, videoStreams, type ProbeResult, type ProbeStream } from './probe.js';

/**
 * Video policy shared by the native and browser engines: profiles, the
 * decision whether a video can be re-encoded safely, the validated FFmpeg
 * argument builder and the validation of candidates. Engines only run the
 * commands; they never build their own argument lists.
 */

export type Preset = 'conservative' | 'balanced' | 'aggressive';

/** Resolution caps expressed as the short side of the frame. */
export const RESOLUTION_CAPS = [360, 480, 720, 1080, 1440, 2160] as const;
export type ResolutionCap = (typeof RESOLUTION_CAPS)[number] | 'original';

export interface VideoProfile {
  readonly crf: number;
  readonly maxShortSide: ResolutionCap;
  readonly audioBitrateKbps: number;
  /** x264 preset, the same in every engine so the CLI and the web app give the same result. */
  readonly x264Preset: string;
  /** Bits per pixel and frame under which a modern-codec source is left alone. */
  readonly efficientBpp: number;
}

export const VIDEO_PROFILES: Readonly<Record<Preset, VideoProfile>> = Object.freeze({
  conservative: { crf: 20, maxShortSide: 1080, audioBitrateKbps: 192, x264Preset: 'faster', efficientBpp: 0.05 },
  balanced: { crf: 23, maxShortSide: 1080, audioBitrateKbps: 128, x264Preset: 'veryfast', efficientBpp: 0.08 },
  aggressive: { crf: 28, maxShortSide: 720, audioBitrateKbps: 96, x264Preset: 'veryfast', efficientBpp: 0.12 },
});

export const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

/** Normalized, validated video options. */
export interface VideoOptions {
  readonly enabled: boolean;
  readonly preset: Preset;
  readonly crf: number;
  readonly maxShortSide: ResolutionCap;
  readonly audioBitrateKbps: number;
  /** Explicit x264 preset override (from an allowlist); undefined = engine default for the profile. */
  readonly x264Preset: (typeof X264_PRESETS)[number] | undefined;
  readonly minSavingsPercent: number;
  readonly minSavingsBytes: number;
  /** Re-encode even when the source already looks efficient. */
  readonly force: boolean;
  /** Allow dropping data streams (timecode, telemetry) that cannot be carried over. */
  readonly dropDataStreams: boolean;
}

/** Capabilities an engine advertises for video. */
export interface VideoCapabilities {
  readonly available: boolean;
  readonly reason?: string;
  /** Encoders that are usable (e.g. libx264, aac, libvpx-vp9, libopus). */
  readonly encoders: readonly string[];
  /** Engine class, used to pick x264 presets and to gate slow codecs. */
  readonly engineClass: 'native' | 'browser';
  /** Encoders present but too slow to enable by default (e.g. VP9 in WASM). */
  readonly slowEncoders: readonly string[];
}

/** Why a video is left unchanged. Codes are stable and documented. */
export type VideoSkipReason =
  | 'video-disabled'
  | 'engine-unavailable'
  | 'engine-capability'
  | 'unsupported-container'
  | 'no-video-stream'
  | 'multiple-video-streams'
  | 'attached-picture'
  | 'alpha-channel'
  | 'high-bit-depth'
  | 'hdr'
  | 'interlaced'
  | 'unsupported-rotation'
  | 'unsupported-subtitle'
  | 'unsupported-data-stream'
  | 'unsupported-audio'
  | 'unknown-duration'
  | 'exceeds-size-limit'
  | 'exceeds-resolution-limit'
  | 'exceeds-duration-limit'
  | 'already-efficient';

/** Audio handling for one output audio stream. */
export interface AudioPlan {
  readonly inputIndex: number;
  readonly codec: string;
  readonly action: 'copy' | 'encode';
  readonly targetCodec: string;
  readonly bitrateKbps?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly language?: string;
}

/** A fully decided re-encoding job. */
export interface VideoJob {
  readonly container: 'mp4' | 'mov' | 'webm';
  readonly demuxer: string;
  readonly videoIndex: number;
  readonly videoCodec: 'h264' | 'vp9';
  readonly encoder: 'libx264' | 'libvpx-vp9';
  readonly crf: number;
  readonly x264Preset: string;
  readonly scale: { width: number; height: number } | undefined;
  readonly expected: {
    readonly width: number;
    readonly height: number;
    readonly duration: number;
    readonly frameRate: number | undefined;
    readonly audio: readonly AudioPlan[];
    readonly subtitleIndexes: readonly number[];
    readonly chapters: number;
  };
  /** Human-readable description of every lossy conversion. */
  readonly conversions: readonly string[];
  /** Streams deliberately not carried over (only with dropDataStreams). */
  readonly droppedStreams: readonly string[];
}

export type VideoDecision =
  { readonly action: 'transcode'; readonly job: VideoJob } | { readonly action: 'skip'; readonly reason: VideoSkipReason; readonly detail: string };

/** Input facts for a video decision. */
export interface VideoInput {
  readonly format: string;
  readonly size: number;
  readonly probe: ProbeResult;
}

const MP4_FAMILY = new Set(['mp4', 'm4v', 'mov', '3gp']);
const MP4_AUDIO_COPY = new Set(['aac', 'mp3']);
const WEBM_AUDIO_COPY = new Set(['opus', 'vorbis']);
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

/** Decides whether and how a video will be re-encoded. */
export function decideVideo(input: VideoInput, options: VideoOptions, caps: VideoCapabilities, limits: Limits): VideoDecision {
  const skip = (reason: VideoSkipReason, detail: string): VideoDecision => ({ action: 'skip', reason, detail });
  if (!options.enabled) return skip('video-disabled', 'Video optimization is disabled');
  if (!caps.available) return skip('engine-unavailable', caps.reason ?? 'No video engine available');
  const container = MP4_FAMILY.has(input.format) ? (input.format === 'mov' ? 'mov' : 'mp4') : input.format === 'webm' ? 'webm' : undefined;
  if (!container) return skip('unsupported-container', `Container "${input.format}" is not re-encoded without a format change`);
  if (input.size > limits.maxVideoBytes) return skip('exceeds-size-limit', `File is larger than ${limits.maxVideoBytes} bytes`);
  const probe = input.probe;
  const videos = videoStreams(probe);
  if (probe.streams.some((s) => s.type === 'video' && s.attachedPic)) return skip('attached-picture', 'Embedded cover art is not preserved');
  if (videos.length === 0) return skip('no-video-stream', 'No video stream');
  if (videos.length > 1) return skip('multiple-video-streams', 'More than one video stream');
  const v = videos[0]!;
  if (hasAlphaPixFmt(v.pixFmt) || v.alphaMode) return skip('alpha-channel', `Transparency (${v.pixFmt ?? 'alpha_mode'}) would be lost`);
  if (isHdr(v)) return skip('hdr', 'HDR video would lose its dynamic range');
  if (isHighBitDepth(v)) return skip('high-bit-depth', `High bit depth (${v.pixFmt ?? ''}) would be reduced`);
  if (v.fieldOrder && v.fieldOrder !== 'progressive' && v.fieldOrder !== 'unknown') return skip('interlaced', 'Interlaced video');
  if (v.rotation % 90 !== 0) return skip('unsupported-rotation', `Rotation of ${v.rotation} degrees`);
  if (!v.width || !v.height) return skip('no-video-stream', 'Video stream without dimensions');
  const duration = effectiveDuration(probe);
  if (duration === undefined || duration <= 0) return skip('unknown-duration', 'Duration is unknown');
  if (duration > limits.maxVideoDurationSeconds) return skip('exceeds-duration-limit', `Longer than ${limits.maxVideoDurationSeconds} s`);
  if (v.width * v.height > limits.maxVideoPixels) return skip('exceeds-resolution-limit', `${v.width}x${v.height} exceeds the limit`);

  const encoder = container === 'webm' ? 'libvpx-vp9' : 'libx264';
  if (!caps.encoders.includes(encoder)) return skip('engine-capability', `Encoder ${encoder} is not available in this engine`);
  if (caps.slowEncoders.includes(encoder) && !options.force) {
    return skip('engine-capability', `Encoder ${encoder} is too slow in this engine (enable with force)`);
  }

  const conversions: string[] = [];
  const dropped: string[] = [];
  const audio: AudioPlan[] = [];
  const subtitleIndexes: number[] = [];
  for (const s of probe.streams) {
    if (s.index === v.index) continue;
    if (s.type === 'audio') {
      const plan = planAudio(s, container, options, caps);
      if (!plan) return skip('unsupported-audio', `Audio stream ${s.index} (${s.codec}) cannot be carried over`);
      if (plan.action === 'encode') {
        conversions.push(`audio stream ${s.index}: ${s.codec} → ${plan.targetCodec} ${plan.bitrateKbps} kb/s`);
      }
      audio.push(plan);
    } else if (s.type === 'subtitle') {
      const ok = container === 'webm' ? s.codec === 'webvtt' : s.codec === 'mov_text';
      if (!ok) return skip('unsupported-subtitle', `Subtitle stream ${s.index} (${s.codec}) cannot be carried over`);
      subtitleIndexes.push(s.index);
    } else if (s.type === 'data' && isChapterTrack(s, probe)) {
      // Recreated by the muxer from -map_chapters.
    } else if (s.type === 'data' || s.type === 'attachment' || s.type === 'unknown') {
      if (!options.dropDataStreams) {
        return skip('unsupported-data-stream', `Stream ${s.index} (${s.type}/${s.codecTag ?? s.codec}) cannot be carried over`);
      }
      dropped.push(`stream ${s.index} (${s.type}/${s.codecTag ?? s.codec})`);
    }
  }

  const rotated = v.rotation === 90 || v.rotation === 270;
  // Anamorphic sources are converted to square pixels with the same display aspect.
  const squareW = Math.round(v.width * parseSar(v.sampleAspectRatio));
  const displayW = rotated ? v.height : squareW;
  const displayH = rotated ? squareW : v.height;
  const target = targetSize(displayW, displayH, options.maxShortSide);
  const needsScale = target.width !== displayW || target.height !== displayH;

  const frameRate = v.frameRate;
  const bitRate = v.bitRate ?? (probe.bitRate !== undefined ? probe.bitRate * 0.9 : (input.size * 8) / duration);
  // Measured on the displayed (square) pixels the output will have, so anamorphic sources are not over-credited.
  const bpp = frameRate ? bitRate / (squareW * v.height * frameRate) : undefined;
  const modern = ['h264', 'hevc', 'vp9', 'av1'].includes(v.codec);
  if (!options.force && !needsScale && modern && bpp !== undefined && bpp < VIDEO_PROFILES[options.preset].efficientBpp) {
    return skip('already-efficient', `Source ${v.codec} at ${bpp.toFixed(3)} bits/pixel is already efficient for this profile`);
  }
  const x264Preset = options.x264Preset ?? VIDEO_PROFILES[options.preset].x264Preset;
  conversions.unshift(
    `video: ${v.codec} ${displayW}x${displayH} → ${encoder === 'libx264' ? 'h264' : 'vp9'} ${target.width}x${target.height} (CRF ${options.crf})`,
  );
  if (v.rotation !== 0) conversions.push(`rotation of ${v.rotation}° applied to the pixels (display unchanged)`);
  return {
    action: 'transcode',
    job: {
      container,
      demuxer: container === 'webm' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2',
      videoIndex: v.index,
      videoCodec: encoder === 'libx264' ? 'h264' : 'vp9',
      encoder,
      crf: options.crf,
      x264Preset,
      scale: needsScale ? target : undefined,
      expected: {
        width: target.width,
        height: target.height,
        duration,
        frameRate,
        audio,
        subtitleIndexes,
        chapters: probe.chapters,
      },
      conversions,
      droppedStreams: dropped,
    },
  };
}

/** Parses a sample aspect ratio like "4:3"; returns 1 for square or unknown values. */
export function parseSar(sar: string | undefined): number {
  const m = /^(\d+):(\d+)$/.exec(sar ?? '');
  if (!m) return 1;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (num === 0 || den === 0) return 1;
  return num / den;
}

/** Recognizes the QuickTime chapter text track written alongside chapters. */
function isChapterTrack(s: ProbeStream, probe: ProbeResult): boolean {
  return probe.chapters > 0 && s.codec === 'bin_data' && s.codecTag === 'text';
}

/** Decides how an audio stream is carried into the target container. */
function planAudio(s: ProbeStream, container: 'mp4' | 'mov' | 'webm', options: VideoOptions, caps: VideoCapabilities): AudioPlan | undefined {
  const base = {
    inputIndex: s.index,
    codec: s.codec,
    ...(s.channels !== undefined ? { channels: s.channels } : {}),
    ...(s.sampleRate !== undefined ? { sampleRate: s.sampleRate } : {}),
    ...(s.language !== undefined ? { language: s.language } : {}),
  };
  const copyable = container === 'webm' ? WEBM_AUDIO_COPY : MP4_AUDIO_COPY;
  if (copyable.has(s.codec)) return { ...base, action: 'copy', targetCodec: s.codec };
  const target = container === 'webm' ? 'libopus' : 'aac';
  if (!caps.encoders.includes(target)) return undefined;
  if (s.channels !== undefined && s.channels > 8) return undefined;
  const sourceKbps = s.bitRate !== undefined ? Math.round(s.bitRate / 1000) : undefined;
  const bitrate = Math.max(64, Math.min(options.audioBitrateKbps, sourceKbps ?? options.audioBitrateKbps));
  let sampleRate = s.sampleRate;
  if (target === 'aac' && sampleRate !== undefined && !AAC_RATES.includes(sampleRate)) sampleRate = 48000;
  if (target === 'libopus') sampleRate = 48000;
  return {
    ...base,
    action: 'encode',
    targetCodec: target === 'libopus' ? 'opus' : 'aac',
    bitrateKbps: bitrate,
    ...(sampleRate !== undefined ? { sampleRate } : {}),
  };
}

/** Computes the output size within the resolution cap, keeping aspect and even dimensions. */
export function targetSize(width: number, height: number, cap: ResolutionCap): { width: number; height: number } {
  let scale = 1;
  if (cap !== 'original') {
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);
    const maxLong = Math.round((cap * 16) / 9);
    scale = Math.min(1, cap / shortSide, maxLong / longSide);
  }
  const even = (n: number): number => Math.max(2, 2 * Math.round(n / 2));
  if (scale === 1) return { width: width - (width % 2), height: height - (height % 2) };
  return { width: even(width * scale), height: even(height * scale) };
}

/** Engine-specific extras allowed in the argument list. */
export interface EngineArgs {
  /** Encoder thread count (native only). */
  threads?: number;
  /** Emit machine-readable progress on stdout (native only). */
  progressPipe?: boolean;
}

/**
 * Builds the FFmpeg argument vector for a job. `input` and `output` are
 * engine-controlled paths (never user-provided names). Input is restricted to
 * the local file protocol and the expected demuxer, so playlists, concat
 * scripts or references cannot make FFmpeg read other files or the network.
 */
export function buildVideoArgs(job: VideoJob, input: string, output: string, extra: EngineArgs = {}): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (extra.progressPipe) args.push('-progress', 'pipe:1', '-nostats');
  args.push('-protocol_whitelist', 'file', '-f', job.demuxer.split(',')[0]!);
  if (job.container !== 'webm') args.push('-enable_drefs', '0');
  args.push('-i', input, '-map', `0:${job.videoIndex}`);
  for (const a of job.expected.audio) args.push('-map', `0:${a.inputIndex}`);
  for (const s of job.expected.subtitleIndexes) args.push('-map', `0:${s}`);
  args.push('-map_metadata', '0', '-map_chapters', '0');
  if (job.encoder === 'libx264') {
    args.push('-c:v', 'libx264', '-preset', job.x264Preset, '-crf', String(job.crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high');
  } else {
    args.push('-c:v', 'libvpx-vp9', '-crf', String(job.crf + 10), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p');
  }
  if (extra.threads !== undefined) args.push('-threads', String(extra.threads));
  const { width, height } = job.expected;
  args.push('-vf', `scale=${width}:${height}:flags=lanczos,setsar=1`);
  job.expected.audio.forEach((a, i) => {
    if (a.action === 'copy') {
      args.push(`-c:a:${i}`, 'copy');
    } else {
      args.push(`-c:a:${i}`, a.targetCodec === 'opus' ? 'libopus' : 'aac', `-b:a:${i}`, `${a.bitrateKbps}k`);
      if (a.sampleRate !== undefined) args.push(`-ar:a:${i}`, String(a.sampleRate));
    }
  });
  if (job.expected.subtitleIndexes.length > 0) args.push('-c:s', 'copy');
  if (job.container !== 'webm') args.push('-movflags', '+faststart', '-f', job.container === 'mov' ? 'mov' : 'mp4');
  else args.push('-f', 'webm');
  args.push('-y', output);
  return args;
}

/** Arguments for a full decode check of a candidate (errors make FFmpeg fail). */
export function buildDecodeCheckArgs(job: Pick<VideoJob, 'demuxer'>, input: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-xerror',
    '-protocol_whitelist',
    'file',
    '-f',
    job.demuxer.split(',')[0]!,
    '-i',
    input,
    '-map',
    '0',
    '-f',
    'null',
    '-',
  ];
}

/** Temporal tolerance for duration checks: codec delay and frame quantization. */
export function durationTolerance(frameRate: number | undefined): number {
  return Math.max(0.25, frameRate ? 3 / frameRate : 0);
}

/** Result of validating a candidate against its job. */
export interface CandidateCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Validates a candidate's probe against the job expectations. */
export function validateVideoCandidate(job: VideoJob, candidate: ProbeResult): CandidateCheck {
  const problems: string[] = [];
  const videos = videoStreams(candidate);
  if (videos.length !== 1) problems.push(`expected 1 video stream, found ${videos.length}`);
  const v = videos[0];
  if (v) {
    if (v.codec !== job.videoCodec) problems.push(`video codec ${v.codec} instead of ${job.videoCodec}`);
    const w = v.rotation === 90 || v.rotation === 270 ? v.height : v.width;
    const h = v.rotation === 90 || v.rotation === 270 ? v.width : v.height;
    if (w !== job.expected.width || h !== job.expected.height) {
      problems.push(`size ${w}x${h} instead of ${job.expected.width}x${job.expected.height}`);
    }
    if (v.pixFmt !== 'yuv420p') problems.push(`pixel format ${v.pixFmt ?? 'unknown'} instead of yuv420p`);
    if (job.expected.frameRate && v.frameRate && Math.abs(v.frameRate - job.expected.frameRate) / job.expected.frameRate > 0.01) {
      problems.push(`frame rate ${v.frameRate.toFixed(3)} instead of ${job.expected.frameRate.toFixed(3)}`);
    }
  }
  const duration = effectiveDuration(candidate);
  const tolerance = durationTolerance(job.expected.frameRate);
  if (duration === undefined || Math.abs(duration - job.expected.duration) > tolerance) {
    problems.push(`duration ${duration?.toFixed(3) ?? 'unknown'} s differs from ${job.expected.duration.toFixed(3)} s by more than ${tolerance.toFixed(2)} s`);
  }
  const audio = candidate.streams.filter((s) => s.type === 'audio');
  if (audio.length !== job.expected.audio.length) problems.push(`expected ${job.expected.audio.length} audio streams, found ${audio.length}`);
  job.expected.audio.forEach((a, i) => {
    const s = audio[i];
    if (!s) return;
    if (s.codec !== a.targetCodec) problems.push(`audio stream ${i} codec ${s.codec} instead of ${a.targetCodec}`);
    if (a.channels !== undefined && s.channels !== a.channels) problems.push(`audio stream ${i} has ${s.channels ?? '?'} channels instead of ${a.channels}`);
    if (a.language !== undefined && s.language !== a.language) problems.push(`audio stream ${i} lost its language (${a.language})`);
  });
  const subtitles = candidate.streams.filter((s) => s.type === 'subtitle');
  if (subtitles.length !== job.expected.subtitleIndexes.length) {
    problems.push(`expected ${job.expected.subtitleIndexes.length} subtitle streams, found ${subtitles.length}`);
  }
  if (candidate.chapters !== job.expected.chapters) problems.push(`expected ${job.expected.chapters} chapters, found ${candidate.chapters}`);
  return { ok: problems.length === 0, problems };
}

/** Decides whether a valid candidate saves enough to replace the original. */
export function isWorthReplacing(originalSize: number, candidateSize: number, options: Pick<VideoOptions, 'minSavingsPercent' | 'minSavingsBytes'>): boolean {
  const saved = originalSize - candidateSize;
  return saved >= options.minSavingsBytes && saved >= (originalSize * options.minSavingsPercent) / 100;
}
