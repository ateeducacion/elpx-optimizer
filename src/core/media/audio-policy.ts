import type { Limits } from '../limits.js';
import type { Preset } from './video-policy.js';
import { effectiveDuration, type ProbeResult } from './probe.js';

/**
 * Audio policy shared by both engines. Uncompressed or lossless recordings
 * (WAV, AIFF, FLAC) become MP3, which every browser and eXeLearning's audio
 * players accept; the file gets the .mp3 extension and its references are
 * rewritten by the restructuring planner. MP3 and M4A (AAC) files are only
 * re-encoded, keeping their format and name, when their bitrate is far above
 * the target. Other formats (Ogg Vorbis, Opus, WebM) are already efficient
 * and are left alone.
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
  /** Output format and extension. */
  readonly target: 'mp3' | 'm4a';
  readonly encoder: 'libmp3lame' | 'aac';
  /** Codec name the candidate must report. */
  readonly codec: 'mp3' | 'aac';
  readonly bitrateKbps: number;
  readonly channels: number;
  readonly sampleRate: number;
  /** True when the extension changes (the file is renamed and its references rewritten). */
  readonly rename: boolean;
  readonly expected: { readonly duration: number };
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

/** Sources that become MP3, with the demuxer forced for each. */
const LOSSLESS: Readonly<Record<string, string>> = { wav: 'wav', aiff: 'aiff', flac: 'flac' };
/** Lossy sources re-encoded in their own format, with their demuxer and encoder. */
const LOSSY: Readonly<Record<string, { demuxer: string; target: 'mp3' | 'm4a'; encoder: 'libmp3lame' | 'aac'; codec: 'mp3' | 'aac' }>> = {
  mp3: { demuxer: 'mp3', target: 'mp3', encoder: 'libmp3lame', codec: 'mp3' },
  m4a: { demuxer: 'mov,mp4,m4a,3gp,3g2,mj2', target: 'm4a', encoder: 'aac', codec: 'aac' },
};
/** Sample rates MPEG audio (and AAC) can carry. */
const MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
/** A lossy source is re-encoded only above this multiple of the target bitrate. */
const LOSSY_HEADROOM = 1.4;

/** Demuxer to read a candidate of the given target format. */
export function audioDemuxer(target: AudioJob['target']): string {
  return target === 'mp3' ? 'mp3' : LOSSY['m4a']!.demuxer;
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
  const duration = effectiveDuration(p);
  if (duration === undefined || duration <= 0) return skip('unknown-duration', 'The duration is unknown');
  if (duration > limits.maxVideoDurationSeconds) return skip('exceeds-duration-limit', `Longer than ${limits.maxVideoDurationSeconds} s`);
  const s = audio[0]!;
  const sourceChannels = s.channels ?? 2;
  const channels = Math.min(2, Math.max(1, sourceChannels));
  const bitrateKbps = channels === 1 ? Math.max(64, Math.round(options.bitrateKbps / 2)) : options.bitrateKbps;
  const sourceRate = s.sampleRate ?? 44100;
  const sampleRate = MP3_RATES.find((r) => r <= sourceRate) ?? 8000;
  const conversions: string[] = [];
  if (lossless) {
    conversions.push(`${input.format.toUpperCase()} (${s.codec}) converted to MP3 at ${bitrateKbps} kb/s (lossy); the file is renamed to .mp3`);
  } else {
    const sourceKbps = (s.bitRate ?? p.bitRate ?? (input.size * 8) / duration) / 1000;
    if (!options.force && sourceKbps < bitrateKbps * LOSSY_HEADROOM) {
      return skip('already-efficient', `${Math.round(sourceKbps)} kb/s is close to the ${bitrateKbps} kb/s target`);
    }
    conversions.push(`${lossy!.codec.toUpperCase()} re-encoded from ${Math.round(sourceKbps)} to ${bitrateKbps} kb/s (lossy)`);
  }
  if (channels !== sourceChannels) conversions.push(`${sourceChannels} channels mixed down to stereo`);
  if (sampleRate !== sourceRate) conversions.push(`sample rate ${sourceRate} Hz changed to ${sampleRate} Hz`);
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
      expected: { duration },
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
  if (extra.progressPipe) args.push('-progress', 'pipe:1', '-nostats');
  args.push('-protocol_whitelist', 'file', '-f', job.demuxer.split(',')[0]!);
  if (job.demuxer.startsWith('mov')) args.push('-enable_drefs', '0');
  args.push('-i', input, '-map', `0:${job.audioIndex}`, '-map_metadata', '0', '-vn', '-sn', '-dn');
  args.push('-c:a', job.encoder, '-b:a', `${job.bitrateKbps}k`, '-ac', String(job.channels), '-ar', String(job.sampleRate));
  if (job.target === 'mp3') args.push('-id3v2_version', '3', '-f', 'mp3');
  else args.push('-movflags', '+faststart', '-f', 'ipod');
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
  // MP3 frames (1152 samples) and encoder padding shift the end slightly.
  const tolerance = Math.max(0.2, job.expected.duration * 0.005);
  if (duration === undefined || Math.abs(duration - job.expected.duration) > tolerance) {
    problems.push(`duration ${duration?.toFixed(3) ?? 'unknown'} s differs from ${job.expected.duration.toFixed(3)} s by more than ${tolerance.toFixed(2)} s`);
  }
  return { ok: problems.length === 0, problems };
}

/** The new name of a converted file: same folder and base name, target extension. */
export function convertedName(path: string, target: AudioJob['target']): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const base = dot > slash ? path.slice(0, dot) : path;
  return `${base}.${target}`;
}
