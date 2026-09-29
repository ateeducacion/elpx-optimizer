import type { Limits } from '../limits.js';
import type { Preset } from './video-policy.js';
import { effectiveDuration, type ProbeResult } from './probe.js';

/**
 * Audio policy shared by both engines. Uncompressed or lossless recordings
 * (WAV, AIFF, FLAC) become MP3, which every browser and eXeLearning's audio
 * players accept; the file gets the .mp3 extension and its references are
 * rewritten by the restructuring planner. MP3, M4A (AAC) and Opus (in WebM
 * or Ogg, as eXeLearning's recorder writes) are only re-encoded, keeping
 * their codec, container and name, when their bitrate is far above the
 * target. Vorbis and other formats are left alone.
 */

export interface AudioProfile {
  /** Target bitrate for stereo; mono uses half (at least 64 kb/s). */
  readonly bitrateKbps: number;
}

export const AUDIO_PROFILES: Readonly<Record<Preset, AudioProfile>> = Object.freeze({
  conservative: { bitrateKbps: 192 },
  balanced: { bitrateKbps: 128 },
  aggressive: { bitrateKbps: 96 },
});

/** Normalized, validated audio options. */
export interface AudioOptions {
  readonly enabled: boolean;
  readonly preset: Preset;
  readonly bitrateKbps: number;
  readonly minSavingsPercent: number;
  readonly minSavingsBytes: number;
  /** Re-encode MP3/M4A even when their bitrate is close to the target. */
  readonly force: boolean;
}

/** Capabilities an engine advertises for audio. */
export interface AudioCapabilities {
  readonly available: boolean;
  readonly reason?: string;
  /** Usable encoders among libmp3lame and aac. */
  readonly encoders: readonly string[];
}

export type AudioSkipReason =
  | 'audio-disabled'
  | 'engine-unavailable'
  | 'engine-capability'
  | 'unsupported-format'
  | 'no-audio-stream'
  | 'multiple-audio-streams'
  | 'has-video'
  | 'unknown-duration'
  | 'exceeds-size-limit'
  | 'exceeds-duration-limit'
  | 'already-efficient';

/** A fully decided audio re-encoding job. */
export interface AudioJob {
  /** Demuxer forced for the input (never guessed from the name). */
  readonly demuxer: string;
  readonly audioIndex: number;
  readonly sourceFormat: string;
  /** Output format (and extension, when it changes). */
  readonly target: AudioTarget;
  readonly encoder: 'libmp3lame' | 'aac' | 'libopus';
  /** Codec name the candidate must report. */
  readonly codec: 'mp3' | 'aac' | 'opus';
  readonly bitrateKbps: number;
  readonly channels: number;
  readonly sampleRate: number;
  /** True when the extension changes (the file is renamed and its references rewritten). */
  readonly rename: boolean;
  /** Undefined for browser recordings (MediaRecorder WebM) whose header has no duration. */
  readonly expected: { readonly duration?: number };
  /** Human-readable description of every lossy conversion. */
  readonly conversions: readonly string[];
}

export type AudioDecision =
  { readonly action: 'transcode'; readonly job: AudioJob } | { readonly action: 'skip'; readonly reason: AudioSkipReason; readonly detail: string };

export interface AudioInput {
  readonly format: string;
  readonly size: number;
  readonly probe: ProbeResult;
}

export type AudioTarget = 'mp3' | 'm4a' | 'webm' | 'ogg';

/** Sources that become MP3, with the demuxer forced for each. */
const LOSSLESS: Readonly<Record<string, string>> = { wav: 'wav', aiff: 'aiff', flac: 'flac' };

interface LossySource {
  readonly demuxer: string;
  readonly target: AudioTarget;
  readonly encoder: AudioJob['encoder'];
  readonly codec: AudioJob['codec'];
}
/** Lossy sources re-encoded in their own codec and container (only when the stream uses `codec`). */
const LOSSY: Readonly<Record<string, LossySource>> = {
  mp3: { demuxer: 'mp3', target: 'mp3', encoder: 'libmp3lame', codec: 'mp3' },
  m4a: { demuxer: 'mov,mp4,m4a,3gp,3g2,mj2', target: 'm4a', encoder: 'aac', codec: 'aac' },
  webm: { demuxer: 'matroska,webm', target: 'webm', encoder: 'libopus', codec: 'opus' },
  ogg: { demuxer: 'ogg', target: 'ogg', encoder: 'libopus', codec: 'opus' },
  opus: { demuxer: 'ogg', target: 'ogg', encoder: 'libopus', codec: 'opus' },
};
const DEMUXERS: Readonly<Record<AudioTarget, string>> = { mp3: 'mp3', m4a: LOSSY['m4a']!.demuxer, webm: LOSSY['webm']!.demuxer, ogg: 'ogg' };
/** MIME type of each output format. */
export const AUDIO_MIME: Readonly<Record<AudioTarget, string>> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' };
/** Sample rates MPEG audio (and AAC) can carry. */
const MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
/** A lossy source is re-encoded only above this multiple of the target bitrate. */
const LOSSY_HEADROOM = 1.4;

/** Demuxer to read a candidate of the given target format. */
export function audioDemuxer(target: AudioTarget): string {
  return DEMUXERS[target];
}

/** Decides whether and how an audio file is re-encoded. */
export function decideAudio(input: AudioInput, options: AudioOptions, caps: AudioCapabilities, limits: Limits): AudioDecision {
  const skip = (reason: AudioSkipReason, detail: string): AudioDecision => ({ action: 'skip', reason, detail });
  if (!options.enabled) return skip('audio-disabled', 'Audio optimization is disabled');
  if (!caps.available) return skip('engine-unavailable', caps.reason ?? 'No audio engine');
  const lossless = LOSSLESS[input.format];
  const lossy = LOSSY[input.format];
  if (!lossless && !lossy) return skip('unsupported-format', `${input.format.toUpperCase()} is already a compressed format and is left unchanged`);
  const encoder = lossless ? 'libmp3lame' : lossy!.encoder;
  if (!caps.encoders.includes(encoder)) return skip('engine-capability', `The engine lacks the ${encoder} encoder`);
  if (input.size > limits.maxVideoBytes) return skip('exceeds-size-limit', `File is larger than ${limits.maxVideoBytes} bytes`);
  const p = input.probe;
  if (p.streams.some((s) => s.type === 'video')) return skip('has-video', 'The file also holds pictures or video (cover art is not carried over)');
  const audio = p.streams.filter((s) => s.type === 'audio');
  if (audio.length === 0) return skip('no-audio-stream', 'No audio stream');
  if (audio.length > 1) return skip('multiple-audio-streams', `${audio.length} audio streams`);
  const known = effectiveDuration(p);
  const duration = known !== undefined && known > 0 ? known : undefined;
  const s = audio[0]!;
  // Browser recordings (MediaRecorder) have no duration in their header: they are still re-encoded,
  // with FFmpeg stopping at the first read error and the result fully decoded (see buildAudioArgs).
  const recording = duration === undefined && lossy?.codec === 'opus' && s.codec === 'opus';
  if (duration === undefined && !recording) return skip('unknown-duration', 'The duration is unknown');
  if (duration !== undefined && duration > limits.maxVideoDurationSeconds)
    return skip('exceeds-duration-limit', `Longer than ${limits.maxVideoDurationSeconds} s`);
  if (lossy && s.codec !== lossy.codec) {
    return skip('unsupported-format', `${s.codec} audio in ${input.format.toUpperCase()} is left unchanged`);
  }
  const sourceChannels = s.channels ?? 2;
  const channels = Math.min(2, Math.max(1, sourceChannels));
  const opus = lossy?.codec === 'opus';
  // Opus needs about half the bitrate of MP3/AAC for the same quality.
  const bitrateKbps = opus
    ? channels === 1
      ? Math.max(32, Math.round(options.bitrateKbps / 4))
      : Math.max(48, Math.round(options.bitrateKbps / 2))
    : channels === 1
      ? Math.max(64, Math.round(options.bitrateKbps / 2))
      : options.bitrateKbps;
  const sourceRate = s.sampleRate ?? 44100;
  // Opus always works at 48 kHz internally (its streams report 48000).
  const sampleRate = opus ? 48000 : (MP3_RATES.find((r) => r <= sourceRate) ?? 8000);
  const conversions: string[] = [];
  if (lossless) {
    conversions.push(`${input.format.toUpperCase()} (${s.codec}) converted to MP3 at ${bitrateKbps} kb/s (lossy); the file is renamed to .mp3`);
  } else {
    const bits = s.bitRate ?? p.bitRate ?? (duration !== undefined ? (input.size * 8) / duration : undefined);
    if (bits === undefined) {
      conversions.push(`${lossy!.codec.toUpperCase()} re-encoded to ${bitrateKbps} kb/s (lossy); the recording has no duration in its header`);
    } else {
      const sourceKbps = bits / 1000;
      if (!options.force && sourceKbps < bitrateKbps * LOSSY_HEADROOM) {
        return skip('already-efficient', `${Math.round(sourceKbps)} kb/s is close to the ${bitrateKbps} kb/s target`);
      }
      conversions.push(`${lossy!.codec.toUpperCase()} re-encoded from ${Math.round(sourceKbps)} to ${bitrateKbps} kb/s (lossy)`);
    }
  }
  if (channels !== sourceChannels) conversions.push(`${sourceChannels} channels mixed down to stereo`);
  if (sampleRate !== sourceRate && !opus) conversions.push(`sample rate ${sourceRate} Hz changed to ${sampleRate} Hz`);
  return {
    action: 'transcode',
    job: {
      demuxer: lossless ?? lossy!.demuxer,
      audioIndex: s.index,
      sourceFormat: input.format,
      target: lossless ? 'mp3' : lossy!.target,
      encoder,
      codec: lossless ? 'mp3' : lossy!.codec,
      bitrateKbps,
      channels,
      sampleRate,
      rename: lossless !== undefined,
      expected: duration !== undefined ? { duration } : {},
      conversions,
    },
  };
}

/**
 * FFmpeg arguments for an audio job. Like video, the input is limited to the
 * local file protocol and the expected demuxer; only the one audio stream and
 * the global tags are written.
 */
export function buildAudioArgs(job: AudioJob, input: string, output: string, extra: { progressPipe?: boolean } = {}): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  // Without a known duration to compare with, any read error must fail the job.
  if (job.expected.duration === undefined) args.push('-xerror');
  if (extra.progressPipe) args.push('-progress', 'pipe:1', '-nostats');
  args.push('-protocol_whitelist', 'file', '-f', job.demuxer.split(',')[0]!);
  if (job.demuxer.startsWith('mov')) args.push('-enable_drefs', '0');
  args.push('-i', input, '-map', `0:${job.audioIndex}`, '-map_metadata', '0', '-vn', '-sn', '-dn');
  args.push('-c:a', job.encoder, '-b:a', `${job.bitrateKbps}k`, '-ac', String(job.channels), '-ar', String(job.sampleRate));
  // The pinned ffmpeg.wasm core crashes encoding stereo Opus above level 4; both engines use the same arguments.
  if (job.encoder === 'libopus') args.push('-compression_level', '4');
  if (job.target === 'mp3') args.push('-id3v2_version', '3', '-f', 'mp3');
  else if (job.target === 'm4a') args.push('-movflags', '+faststart', '-f', 'ipod');
  else args.push('-f', job.target);
  args.push('-y', output);
  return args;
}

/** Validates a candidate's probe against the job. */
export function validateAudioCandidate(job: AudioJob, candidate: ProbeResult): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const audio = candidate.streams.filter((s) => s.type === 'audio');
  if (audio.length !== 1) problems.push(`expected 1 audio stream, found ${audio.length}`);
  if (candidate.streams.some((s) => s.type !== 'audio')) problems.push('the candidate holds other streams');
  const a = audio[0];
  if (a) {
    if (a.codec !== job.codec) problems.push(`audio codec ${a.codec} instead of ${job.codec}`);
    if (a.channels !== undefined && a.channels !== job.channels) problems.push(`${a.channels} channels instead of ${job.channels}`);
    if (a.sampleRate !== undefined && a.sampleRate !== job.sampleRate) problems.push(`sample rate ${a.sampleRate} instead of ${job.sampleRate}`);
  }
  const duration = effectiveDuration(candidate);
  const expected = job.expected.duration;
  if (expected === undefined) {
    if (duration === undefined || duration <= 0) problems.push('the new file has no duration');
  } else {
    // MP3 frames (1152 samples) and encoder padding shift the end slightly.
    const tolerance = Math.max(0.2, expected * 0.005);
    if (duration === undefined || Math.abs(duration - expected) > tolerance) {
      problems.push(`duration ${duration?.toFixed(3) ?? 'unknown'} s differs from ${expected.toFixed(3)} s by more than ${tolerance.toFixed(2)} s`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The new name of a converted file: same folder and base name, target extension. */
export function convertedName(path: string, target: AudioTarget): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const base = dot > slash ? path.slice(0, dot) : path;
  return `${base}.${target}`;
}
