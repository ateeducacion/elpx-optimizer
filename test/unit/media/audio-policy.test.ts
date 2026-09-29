import { describe, expect, it } from 'vitest';
import { NATIVE_LIMITS, resolveLimits } from '../../../src/core/limits.js';
import type { ProbeResult, ProbeStream } from '../../../src/core/media/probe.js';
import {
  AUDIO_MIME,
  AUDIO_PROFILES,
  audioDemuxer,
  buildAudioArgs,
  convertedName,
  decideAudio,
  validateAudioCandidate,
  type AudioCapabilities,
  type AudioDecision,
  type AudioInput,
  type AudioJob,
  type AudioOptions,
} from '../../../src/core/media/audio-policy.js';

/** A stream with defaults for the required fields. */
function stream(extra: Partial<ProbeStream> & Pick<ProbeStream, 'index' | 'type'>): ProbeStream {
  return { codec: 'unknown', rotation: 0, attachedPic: false, isDefault: true, alphaMode: false, ...extra };
}

/** A stereo 44.1 kHz audio stream. */
function audio(extra: Partial<ProbeStream> = {}): ProbeStream {
  return stream({ index: 0, type: 'audio', codec: 'pcm_s16le', channels: 2, sampleRate: 44100, ...extra });
}

/** A probe result around streams (10 s by default). */
function probe(streams: ProbeStream[], extra: Partial<ProbeResult> = {}): ProbeResult {
  return { formatName: 'wav', duration: 10, streams, chapters: 0, tags: {}, ...extra };
}

const caps: AudioCapabilities = { available: true, encoders: ['libmp3lame', 'aac', 'libopus'] };
const options: AudioOptions = { enabled: true, preset: 'balanced', bitrateKbps: 128, minSavingsPercent: 5, minSavingsBytes: 1024, force: false };

/** Runs decideAudio with overrides. */
function decide(
  p: ProbeResult,
  i: Partial<AudioInput> = {},
  o: Partial<AudioOptions> = {},
  c: Partial<AudioCapabilities> = {},
  limits = NATIVE_LIMITS,
): AudioDecision {
  return decideAudio({ format: 'wav', size: 1_764_044, probe: p, ...i }, { ...options, ...o }, { ...caps, ...c }, limits);
}

/** Asserts a transcode decision and returns its job. */
function job(d: AudioDecision): AudioJob {
  if (d.action !== 'transcode') throw new Error(`expected transcode, got skip ${d.reason}: ${d.detail}`);
  return d.job;
}

/** Asserts a skip decision and returns its reason and detail. */
function skipped(d: AudioDecision): [string, string] {
  if (d.action !== 'skip') throw new Error(`expected skip, got ${JSON.stringify(d.job)}`);
  return [d.reason, d.detail];
}

describe('AUDIO_PROFILES', () => {
  it('sets a stereo bitrate per preset and cannot be changed', () => {
    expect(AUDIO_PROFILES).toEqual({ conservative: { bitrateKbps: 192 }, balanced: { bitrateKbps: 128 }, aggressive: { bitrateKbps: 96 } });
    expect(Object.isFrozen(AUDIO_PROFILES)).toBe(true);
  });
});

describe('decideAudio skip reasons', () => {
  const ok = probe([audio()]);
  it.each<[string, () => AudioDecision, [string, string]]>([
    ['disabled', () => decide(ok, {}, { enabled: false }), ['audio-disabled', 'Audio optimization is disabled']],
    ['no engine (with a reason)', () => decide(ok, {}, {}, { available: false, reason: 'ffmpeg not found' }), ['engine-unavailable', 'ffmpeg not found']],
    ['no engine (without a reason)', () => decide(ok, {}, {}, { available: false }), ['engine-unavailable', 'No audio engine']],
    ['AAC in MP4', () => decide(ok, { format: 'mp4' }), ['unsupported-format', 'MP4 is already a compressed format and is left unchanged']],
    ['Ogg Vorbis', () => decide(probe([audio({ codec: 'vorbis' })]), { format: 'ogg' }), ['unsupported-format', 'vorbis audio in OGG is left unchanged']],
    ['Vorbis in WebM', () => decide(probe([audio({ codec: 'vorbis' })]), { format: 'webm' }), ['unsupported-format', 'vorbis audio in WEBM is left unchanged']],
    [
      'no Opus encoder for Ogg',
      () => decide(ok, { format: 'opus' }, {}, { encoders: ['libmp3lame', 'aac'] }),
      ['engine-capability', 'The engine lacks the libopus encoder'],
    ],
    ['no MP3 encoder for WAV', () => decide(ok, {}, {}, { encoders: ['aac'] }), ['engine-capability', 'The engine lacks the libmp3lame encoder']],
    [
      'no AAC encoder for M4A',
      () => decide(ok, { format: 'm4a' }, {}, { encoders: ['libmp3lame'] }),
      ['engine-capability', 'The engine lacks the aac encoder'],
    ],
    [
      'too large',
      () => decide(ok, { size: 101 }, {}, {}, resolveLimits(NATIVE_LIMITS, { maxVideoBytes: 100 })),
      ['exceeds-size-limit', 'File is larger than 100 bytes'],
    ],
    [
      'cover art',
      () => decide(probe([stream({ index: 0, type: 'video', codec: 'mjpeg', attachedPic: true }), audio({ index: 1 })]), { format: 'mp3' }),
      ['has-video', 'The file also holds pictures or video (cover art is not carried over)'],
    ],
    ['no audio stream', () => decide(probe([stream({ index: 0, type: 'data' })])), ['no-audio-stream', 'No audio stream']],
    ['two audio streams', () => decide(probe([audio(), audio({ index: 1 })])), ['multiple-audio-streams', '2 audio streams']],
    ['unknown duration', () => decide(probe([audio()], { duration: undefined })), ['unknown-duration', 'The duration is unknown']],
    [
      'Vorbis recording without a duration',
      () => decide(probe([audio({ codec: 'vorbis' })], { duration: undefined }), { format: 'webm' }),
      ['unknown-duration', 'The duration is unknown'],
    ],
    ['zero duration', () => decide(probe([audio({ duration: 0 })], { duration: 0 })), ['unknown-duration', 'The duration is unknown']],
    ['too long', () => decide(ok, {}, {}, {}, resolveLimits(NATIVE_LIMITS, { maxVideoDurationSeconds: 9 })), ['exceeds-duration-limit', 'Longer than 9 s']],
    [
      'an MP3 close to the target',
      () => decide(probe([audio({ codec: 'mp3', bitRate: 160_000 })]), { format: 'mp3' }),
      ['already-efficient', '160 kb/s is close to the 128 kb/s target'],
    ],
  ])('%s', (_name, run, expected) => {
    expect(skipped(run())).toEqual(expected);
  });
});

describe('decideAudio jobs', () => {
  it('converts WAV, AIFF and FLAC to MP3 with a rename', () => {
    const wav = job(decide(probe([audio()])));
    expect(wav).toEqual({
      demuxer: 'wav',
      audioIndex: 0,
      sourceFormat: 'wav',
      target: 'mp3',
      encoder: 'libmp3lame',
      codec: 'mp3',
      bitrateKbps: 128,
      channels: 2,
      sampleRate: 44100,
      rename: true,
      expected: { duration: 10 },
      conversions: ['WAV (pcm_s16le) converted to MP3 at 128 kb/s (lossy); the file is renamed to .mp3'],
    });
    expect(job(decide(probe([audio({ codec: 'pcm_s16be', sampleRate: 22050 })]), { format: 'aiff' }))).toMatchObject({
      demuxer: 'aiff',
      sampleRate: 22050,
      conversions: ['AIFF (pcm_s16be) converted to MP3 at 128 kb/s (lossy); the file is renamed to .mp3'],
    });
    expect(job(decide(probe([audio({ codec: 'flac', index: 3 })]), { format: 'flac' }))).toMatchObject({ demuxer: 'flac', audioIndex: 3 });
  });

  it('halves the bitrate for mono (never below 64 kb/s)', () => {
    const mono = probe([audio({ channels: 1 })]);
    expect(job(decide(mono)).bitrateKbps).toBe(64);
    expect(job(decide(mono, {}, { bitrateKbps: 192 })).bitrateKbps).toBe(96);
    expect(job(decide(mono, {}, { bitrateKbps: 96 }))).toMatchObject({ bitrateKbps: 64, channels: 1 });
    expect(job(decide(mono, {}, { bitrateKbps: 96 })).conversions[0]).toContain('at 64 kb/s');
  });

  it('mixes surround down to stereo and picks an MPEG sample rate', () => {
    const surround = job(decide(probe([audio({ channels: 6, sampleRate: 96000 })])));
    expect(surround).toMatchObject({ channels: 2, sampleRate: 48000, bitrateKbps: 128 });
    expect(surround.conversions.slice(1)).toEqual(['6 channels mixed down to stereo', 'sample rate 96000 Hz changed to 48000 Hz']);
    // 22.05 kHz is kept; odd rates go down to the next MPEG rate, and below 8 kHz up to 8 kHz.
    expect(job(decide(probe([audio({ sampleRate: 23000 })]))).sampleRate).toBe(22050);
    expect(job(decide(probe([audio({ sampleRate: 7000 })]))).conversions).toContain('sample rate 7000 Hz changed to 8000 Hz');
    // Unknown channel count and rate: assumed stereo at 44.1 kHz, with nothing to report.
    const unknown = job(decide(probe([audio({ channels: undefined, sampleRate: undefined })])));
    expect(unknown).toMatchObject({ channels: 2, sampleRate: 44100 });
    expect(unknown.conversions).toHaveLength(1);
  });

  it('re-encodes MP3 and M4A in their own format only far above the target, or when forced', () => {
    // 1.4 × 128 = 179.2 kb/s: 180 kb/s is worth it, 179 is not.
    expect(skipped(decide(probe([audio({ codec: 'mp3', bitRate: 179_000 })]), { format: 'mp3' }))[0]).toBe('already-efficient');
    const mp3 = job(decide(probe([audio({ codec: 'mp3', bitRate: 320_000 })]), { format: 'mp3' }));
    expect(mp3).toMatchObject({ demuxer: 'mp3', target: 'mp3', encoder: 'libmp3lame', codec: 'mp3', rename: false });
    expect(mp3.conversions).toEqual(['MP3 re-encoded from 320 to 128 kb/s (lossy)']);
    const m4a = job(decide(probe([audio({ codec: 'aac', bitRate: 256_000, sampleRate: 48000 })]), { format: 'm4a' }));
    expect(m4a).toMatchObject({ demuxer: 'mov,mp4,m4a,3gp,3g2,mj2', target: 'm4a', encoder: 'aac', codec: 'aac', rename: false, sampleRate: 48000 });
    expect(m4a.conversions).toEqual(['AAC re-encoded from 256 to 128 kb/s (lossy)']);
    // The bitrate falls back to the container's, then to size / duration.
    expect(job(decide(probe([audio({ codec: 'mp3' })], { bitRate: 256_000 }), { format: 'mp3' })).conversions[0]).toContain('from 256 to');
    expect(skipped(decide(probe([audio({ codec: 'mp3' })]), { format: 'mp3', size: 200_000 }))).toEqual([
      'already-efficient',
      '160 kb/s is close to the 128 kb/s target',
    ]);
    expect(job(decide(probe([audio({ codec: 'mp3', bitRate: 160_000 })]), { format: 'mp3' }, { force: true })).conversions).toEqual([
      'MP3 re-encoded from 160 to 128 kb/s (lossy)',
    ]);
  });

  it('uses the longest stream when the container has no duration', () => {
    expect(job(decide(probe([audio({ duration: 12.5 })], { duration: undefined }))).expected).toEqual({ duration: 12.5 });
  });
});

describe('decideAudio: Opus in WebM and Ogg', () => {
  const opus = (extra: Partial<ProbeStream> = {}, p: Partial<ProbeResult> = {}): ProbeResult =>
    probe([audio({ codec: 'opus', sampleRate: 48000, ...extra })], { formatName: 'matroska,webm', ...p });

  it('re-encodes high-bitrate Opus in its own container at half the MP3 bitrate, always at 48 kHz', () => {
    const webm = job(decide(opus({ bitRate: 256_000 }), { format: 'webm' }));
    expect(webm).toMatchObject({
      demuxer: 'matroska,webm',
      target: 'webm',
      encoder: 'libopus',
      codec: 'opus',
      bitrateKbps: 64,
      channels: 2,
      sampleRate: 48000,
      rename: false,
      expected: { duration: 10 },
    });
    expect(webm.conversions).toEqual(['OPUS re-encoded from 256 to 64 kb/s (lossy)']);
    // Mono uses a quarter (at least 32 kb/s); Ogg and .opus files stay Ogg; a 44.1 kHz source is not reported as resampled.
    const ogg = job(decide(opus({ channels: 1, bitRate: 128_000, sampleRate: 44100 }), { format: 'opus' }));
    expect(ogg).toMatchObject({ demuxer: 'ogg', target: 'ogg', bitrateKbps: 32, channels: 1, sampleRate: 48000 });
    expect(ogg.conversions).toEqual(['OPUS re-encoded from 128 to 32 kb/s (lossy)']);
    expect(job(decide(opus({ channels: 1, bitRate: 128_000 }), { format: 'ogg' }, { bitrateKbps: 192 })).bitrateKbps).toBe(48);
    expect(job(decide(opus({ bitRate: 256_000 }), { format: 'ogg' }, { bitrateKbps: 64 })).bitrateKbps).toBe(48);
    expect(skipped(decide(opus({ bitRate: 80_000 }), { format: 'webm' }))).toEqual(['already-efficient', '80 kb/s is close to the 64 kb/s target']);
  });

  it('re-encodes browser recordings without a duration, and measures their bitrate when it is known', () => {
    const recording = job(decide(opus({ bitRate: undefined }, { duration: undefined, bitRate: undefined }), { format: 'webm', size: 500_000 }));
    expect(recording.expected).toEqual({});
    expect(recording.conversions).toEqual(['OPUS re-encoded to 64 kb/s (lossy); the recording has no duration in its header']);
    // A zero duration counts as unknown.
    expect(job(decide(opus({ bitRate: undefined, duration: 0 }, { duration: 0, bitRate: undefined }), { format: 'webm' })).expected).toEqual({});
    // Without a duration but with a stream bitrate, the usual threshold applies.
    expect(skipped(decide(opus({ bitRate: 70_000 }, { duration: undefined }), { format: 'webm' }))[0]).toBe('already-efficient');
    expect(job(decide(opus({ bitRate: 200_000 }, { duration: undefined }), { format: 'webm' })).conversions).toEqual([
      'OPUS re-encoded from 200 to 64 kb/s (lossy)',
    ]);
  });
});

describe('FFmpeg arguments for audio', () => {
  const wav = job(decide(probe([audio()])));
  const m4a = job(decide(probe([audio({ codec: 'aac', bitRate: 256_000, index: 1 })]), { format: 'm4a' }));

  it('locks the input down and writes one MP3 stream', () => {
    expect(buildAudioArgs(wav, 'in.wav', 'out.mp3')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'file',
      '-f',
      'wav',
      '-i',
      'in.wav',
      '-map',
      '0:0',
      '-map_metadata',
      '0',
      '-vn',
      '-sn',
      '-dn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-id3v2_version',
      '3',
      '-f',
      'mp3',
      '-y',
      'out.mp3',
    ]);
    expect(buildAudioArgs(wav, 'in.wav', 'out.mp3', { progressPipe: true }).slice(4, 7)).toEqual(['-progress', 'pipe:1', '-nostats']);
  });

  it('reads M4A with the MOV demuxer without external references and writes an iPod-compatible file', () => {
    const args = buildAudioArgs(m4a, 'in.m4a', 'out.m4a');
    expect(args.slice(4, 10)).toEqual(['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0']);
    expect(args).toContain('0:1');
    expect(args.slice(-6)).toEqual(['-movflags', '+faststart', '-f', 'ipod', '-y', 'out.m4a']);
    expect(args).not.toContain('-id3v2_version');
  });

  it('writes Opus to WebM or Ogg, and stops at the first read error when the duration is unknown', () => {
    const webm = job(decide(probe([audio({ codec: 'opus', bitRate: 256_000 })]), { format: 'webm' }));
    const args = buildAudioArgs(webm, 'in.webm', 'out.webm');
    expect(args.slice(4, 8)).toEqual(['-protocol_whitelist', 'file', '-f', 'matroska']);
    expect(args.slice(-4)).toEqual(['-f', 'webm', '-y', 'out.webm']);
    expect(args).not.toContain('-xerror');
    const recording = job(decide(probe([audio({ codec: 'opus' })], { duration: undefined }), { format: 'ogg' }));
    const strict = buildAudioArgs(recording, 'in.ogg', 'out.ogg', { progressPipe: true });
    expect(strict.slice(0, 8)).toEqual(['-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror', '-progress', 'pipe:1', '-nostats']);
    expect(strict.slice(-4)).toEqual(['-f', 'ogg', '-y', 'out.ogg']);
  });
});

describe('validateAudioCandidate', () => {
  const wav = job(decide(probe([audio()])));
  const good = (extra: Partial<ProbeStream> = {}, p: Partial<ProbeResult> = {}): ProbeResult =>
    probe([audio({ codec: 'mp3', ...extra })], { formatName: 'mp3', duration: 10.05, ...p });

  it('accepts a matching candidate, with MP3 padding and unknown channel or rate fields', () => {
    expect(validateAudioCandidate(wav, good())).toEqual({ ok: true, problems: [] });
    expect(validateAudioCandidate(wav, good({ channels: undefined, sampleRate: undefined }, { duration: 9.81 })).ok).toBe(true);
  });

  it('reports every mismatch', () => {
    expect(validateAudioCandidate(wav, good({ codec: 'aac', channels: 1, sampleRate: 22050 }, { duration: 10.3 })).problems).toEqual([
      'audio codec aac instead of mp3',
      '1 channels instead of 2',
      'sample rate 22050 instead of 44100',
      'duration 10.300 s differs from 10.000 s by more than 0.20 s',
    ]);
    expect(validateAudioCandidate(wav, probe([], { duration: undefined })).problems).toEqual([
      'expected 1 audio stream, found 0',
      'duration unknown s differs from 10.000 s by more than 0.20 s',
    ]);
    const extra = probe([audio({ codec: 'mp3' }), audio({ codec: 'mp3', index: 1 }), stream({ index: 2, type: 'video', codec: 'mjpeg' })]);
    expect(validateAudioCandidate(wav, extra).problems).toEqual(['expected 1 audio stream, found 2', 'the candidate holds other streams']);
  });

  it('only asks for a duration when none was expected', () => {
    const recording = job(decide(probe([audio({ codec: 'opus' })], { duration: undefined }), { format: 'webm' }));
    const candidate = (duration: number | undefined): ProbeResult =>
      probe([audio({ codec: 'opus', channels: 2, sampleRate: 48000 })], { formatName: 'matroska,webm', duration });
    expect(validateAudioCandidate(recording, candidate(7.5))).toEqual({ ok: true, problems: [] });
    expect(validateAudioCandidate(recording, candidate(undefined)).problems).toEqual(['the new file has no duration']);
    expect(validateAudioCandidate(recording, candidate(0)).problems).toEqual(['the new file has no duration']);
  });

  it('allows 0.5 % of drift on long recordings', () => {
    const long = { ...wav, expected: { duration: 600 } };
    expect(validateAudioCandidate(long, good({}, { duration: 602.9 })).ok).toBe(true);
    expect(validateAudioCandidate(long, good({}, { duration: 603.1 })).problems).toEqual(['duration 603.100 s differs from 600.000 s by more than 3.00 s']);
  });
});

describe('convertedName and audioDemuxer', () => {
  it('replaces only the extension of the file name', () => {
    expect(convertedName('content/resources/audio/lectura.wav', 'mp3')).toBe('content/resources/audio/lectura.mp3');
    expect(convertedName('content/resources/pista.final.aiff', 'mp3')).toBe('content/resources/pista.final.mp3');
    expect(convertedName('content/resources/v1.0/grabacion', 'mp3')).toBe('content/resources/v1.0/grabacion.mp3');
    expect(convertedName('voz.m4a', 'm4a')).toBe('voz.m4a');
  });

  it('names the demuxer and MIME type of each target', () => {
    expect(audioDemuxer('mp3')).toBe('mp3');
    expect(audioDemuxer('m4a')).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(audioDemuxer('webm')).toBe('matroska,webm');
    expect(audioDemuxer('ogg')).toBe('ogg');
    expect(AUDIO_MIME).toEqual({ mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' });
    expect(convertedName('grabacion.webm', 'ogg')).toBe('grabacion.ogg');
  });
});
