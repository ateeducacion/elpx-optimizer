import { describe, expect, it } from 'vitest';
import { NATIVE_LIMITS, resolveLimits } from '../../../src/core/limits.js';
import type { ProbeResult, ProbeStream } from '../../../src/core/media/probe.js';
import {
  buildDecodeCheckArgs,
  buildVideoArgs,
  decideVideo,
  durationTolerance,
  isWorthReplacing,
  parseSar,
  targetSize,
  validateVideoCandidate,
  VIDEO_PROFILES,
  type VideoCapabilities,
  type VideoDecision,
  type VideoInput,
  type VideoJob,
  type VideoOptions,
} from '../../../src/core/media/video-policy.js';

/** A stream with defaults for the required fields. */
function stream(extra: Partial<ProbeStream> & Pick<ProbeStream, 'index' | 'type'>): ProbeStream {
  return { codec: 'unknown', rotation: 0, attachedPic: false, isDefault: false, alphaMode: false, ...extra };
}

/** A 1080p H.264 video stream with a high bitrate (worth re-encoding). */
function video(extra: Partial<ProbeStream> = {}): ProbeStream {
  return stream({ index: 0, type: 'video', codec: 'h264', width: 1920, height: 1080, pixFmt: 'yuv420p', frameRate: 25, bitRate: 20_000_000, ...extra });
}

/** An audio stream. */
function audio(index: number, codec: string, extra: Partial<ProbeStream> = {}): ProbeStream {
  return stream({ index, type: 'audio', codec, channels: 2, sampleRate: 48000, ...extra });
}

/** A probe result around streams. */
function probe(streams: ProbeStream[], extra: Partial<ProbeResult> = {}): ProbeResult {
  return { formatName: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 10, streams, chapters: 0, tags: {}, ...extra };
}

const caps: VideoCapabilities = { available: true, encoders: ['libx264', 'aac', 'libvpx-vp9', 'libopus'], engineClass: 'native', slowEncoders: [] };
const options: VideoOptions = {
  enabled: true,
  preset: 'balanced',
  crf: 23,
  maxShortSide: 1080,
  audioBitrateKbps: 128,
  x264Preset: undefined,
  minSavingsPercent: 5,
  minSavingsBytes: 10240,
  force: false,
  dropDataStreams: false,
};
const input = (p: ProbeResult, extra: Partial<VideoInput> = {}): VideoInput => ({ format: 'mp4', size: 25_000_000, probe: p, ...extra });

/** Runs decideVideo with option/capability overrides. */
function decide(
  p: ProbeResult,
  o: Partial<VideoOptions> = {},
  c: Partial<VideoCapabilities> = {},
  i: Partial<VideoInput> = {},
  limits = NATIVE_LIMITS,
): VideoDecision {
  return decideVideo(input(p, i), { ...options, ...o }, { ...caps, ...c }, limits);
}

/** Asserts a transcode decision and returns its job. */
function job(d: VideoDecision): VideoJob {
  if (d.action !== 'transcode') throw new Error(`expected transcode, got skip ${d.reason}: ${d.detail}`);
  return d.job;
}

/** Asserts a skip decision and returns its reason and detail. */
function skipped(d: VideoDecision): { reason: string; detail: string } {
  if (d.action !== 'skip') throw new Error('expected skip');
  return { reason: d.reason, detail: d.detail };
}

describe('decideVideo skip reasons', () => {
  const ok = probe([video(), audio(1, 'aac')]);

  it.each<[string, () => VideoDecision, RegExp]>([
    ['video-disabled', () => decide(ok, { enabled: false }), /disabled/],
    ['engine-unavailable', () => decide(ok, {}, { available: false, reason: 'ffmpeg not found' }), /ffmpeg not found/],
    ['engine-unavailable', () => decide(ok, {}, { available: false }), /No video engine/],
    ['unsupported-container', () => decide(ok, {}, {}, { format: 'avi' }), /avi/],
    ['exceeds-size-limit', () => decide(ok, {}, {}, { size: NATIVE_LIMITS.maxVideoBytes + 1 }), /larger than/],
    ['attached-picture', () => decide(probe([video(), stream({ index: 1, type: 'video', codec: 'mjpeg', attachedPic: true })])), /cover art/],
    ['no-video-stream', () => decide(probe([audio(0, 'aac')])), /No video stream/],
    ['multiple-video-streams', () => decide(probe([video(), video({ index: 1 })])), /More than one/],
    ['alpha-channel', () => decide(probe([video({ pixFmt: 'yuva420p' })])), /yuva420p/],
    ['alpha-channel', () => decide(probe([video({ pixFmt: undefined, alphaMode: true })])), /alpha_mode/],
    ['hdr', () => decide(probe([video({ colorTransfer: 'smpte2084', pixFmt: 'yuv420p' })])), /HDR/],
    ['high-bit-depth', () => decide(probe([video({ pixFmt: 'yuv420p10le' })])), /yuv420p10le/],
    ['high-bit-depth', () => decide(probe([video({ pixFmt: undefined, bitsPerRawSample: 10 })])), /High bit depth \(\)/],
    ['interlaced', () => decide(probe([video({ fieldOrder: 'tt' })])), /Interlaced/],
    ['unsupported-rotation', () => decide(probe([video({ rotation: 45 })])), /45 degrees/],
    ['no-video-stream', () => decide(probe([video({ width: undefined })])), /without dimensions/],
    ['unknown-duration', () => decide(probe([video()], { duration: undefined })), /unknown/],
    ['exceeds-duration-limit', () => decide(probe([video()], { duration: NATIVE_LIMITS.maxVideoDurationSeconds + 1 })), /Longer than/],
    ['exceeds-resolution-limit', () => decide(probe([video({ width: 16000, height: 9000 })])), /16000x9000/],
    ['engine-capability', () => decide(ok, {}, { encoders: ['aac'] }), /libx264 is not available/],
    ['engine-capability', () => decide(probe([video({ codec: 'vp8' })]), {}, { slowEncoders: ['libvpx-vp9'] }, { format: 'webm' }), /too slow/],
    ['unsupported-audio', () => decide(probe([video(), audio(1, 'pcm_s16le')]), {}, { encoders: ['libx264'] }), /pcm_s16le/],
    ['unsupported-audio', () => decide(probe([video(), audio(1, 'pcm_s16le', { channels: 12 })])), /cannot be carried/],
    ['unsupported-subtitle', () => decide(probe([video(), stream({ index: 1, type: 'subtitle', codec: 'subrip' })])), /subrip/],
    [
      'unsupported-subtitle',
      () => decide(probe([video({ codec: 'vp8' }), stream({ index: 1, type: 'subtitle', codec: 'mov_text' })]), {}, {}, { format: 'webm' }),
      /mov_text/,
    ],
    ['unsupported-data-stream', () => decide(probe([video(), stream({ index: 1, type: 'data', codec: 'bin_data', codecTag: 'tmcd' })])), /data\/tmcd/],
    ['unsupported-data-stream', () => decide(probe([video(), stream({ index: 1, type: 'attachment', codec: 'ttf' })])), /attachment\/ttf/],
    ['unsupported-data-stream', () => decide(probe([video(), stream({ index: 1, type: 'unknown' })])), /unknown\/unknown/],
    ['already-efficient', () => decide(probe([video({ bitRate: 1_000_000 })])), /bits\/pixel/],
  ])('skips with %s', (reason, run, detail) => {
    const s = skipped(run());
    expect(s.reason).toBe(reason);
    expect(s.detail).toMatch(detail);
  });

  it('accepts progressive and unknown field orders', () => {
    expect(decide(probe([video({ fieldOrder: 'progressive' })])).action).toBe('transcode');
    expect(decide(probe([video({ fieldOrder: 'unknown' })])).action).toBe('transcode');
  });

  it('uses a slow encoder only when forced', () => {
    const webm = probe([video({ codec: 'vp8' })]);
    const j = job(decide(webm, { force: true }, { slowEncoders: ['libvpx-vp9'] }, { format: 'webm' }));
    expect(j).toMatchObject({ container: 'webm', encoder: 'libvpx-vp9', videoCodec: 'vp9', demuxer: 'matroska,webm' });
  });
});

describe('decideVideo jobs', () => {
  it('builds an H.264 job for MP4 with copied and encoded audio', () => {
    const p = probe(
      [
        video(),
        audio(1, 'aac', { language: 'spa' }),
        audio(2, 'mp3'),
        audio(3, 'pcm_s16le', { bitRate: 1_536_000, sampleRate: 44100, language: 'eng' }),
        audio(4, 'ac3', { bitRate: 48_000, sampleRate: 7000, channels: undefined }),
        audio(5, 'flac', { sampleRate: undefined }),
        stream({ index: 6, type: 'subtitle', codec: 'mov_text' }),
      ],
      { chapters: 2 },
    );
    const j = job(decide(p));
    expect(j).toMatchObject({
      container: 'mp4',
      demuxer: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoIndex: 0,
      videoCodec: 'h264',
      encoder: 'libx264',
      crf: 23,
      x264Preset: 'medium',
      scale: undefined,
      droppedStreams: [],
    });
    expect(j.expected).toMatchObject({ width: 1920, height: 1080, duration: 10, frameRate: 25, subtitleIndexes: [6], chapters: 2 });
    expect(j.expected.audio).toEqual([
      { inputIndex: 1, codec: 'aac', channels: 2, sampleRate: 48000, language: 'spa', action: 'copy', targetCodec: 'aac' },
      { inputIndex: 2, codec: 'mp3', channels: 2, sampleRate: 48000, action: 'copy', targetCodec: 'mp3' },
      { inputIndex: 3, codec: 'pcm_s16le', channels: 2, sampleRate: 44100, language: 'eng', action: 'encode', targetCodec: 'aac', bitrateKbps: 128 },
      { inputIndex: 4, codec: 'ac3', sampleRate: 48000, action: 'encode', targetCodec: 'aac', bitrateKbps: 64 },
      { inputIndex: 5, codec: 'flac', channels: 2, action: 'encode', targetCodec: 'aac', bitrateKbps: 128 },
    ]);
    expect(j.conversions).toEqual([
      'video: h264 1920x1080 → h264 1920x1080 (CRF 23)',
      'audio stream 3: pcm_s16le → aac 128 kb/s',
      'audio stream 4: ac3 → aac 64 kb/s',
      'audio stream 5: flac → aac 128 kb/s',
    ]);
  });

  it('builds a VP9/Opus job for WebM, copying Opus and Vorbis', () => {
    const p = probe(
      [
        video({ codec: 'vp8', bitRate: undefined }),
        audio(1, 'opus'),
        audio(2, 'vorbis'),
        audio(3, 'aac', { sampleRate: 44100 }),
        stream({ index: 4, type: 'subtitle', codec: 'webvtt' }),
      ],
      {
        formatName: 'matroska,webm',
        bitRate: 30_000_000,
      },
    );
    const j = job(decide(p, {}, {}, { format: 'webm' }));
    expect(j.container).toBe('webm');
    expect(j.expected.audio.map((a) => [a.action, a.targetCodec, a.sampleRate])).toEqual([
      ['copy', 'opus', 48000],
      ['copy', 'vorbis', 48000],
      ['encode', 'opus', 48000],
    ]);
    expect(j.expected.subtitleIndexes).toEqual([4]);
    expect(decide(probe([video(), audio(1, 'aac')]), {}, { encoders: ['libvpx-vp9'] }, { format: 'webm' })).toMatchObject({
      action: 'skip',
      reason: 'unsupported-audio',
    });
  });

  it('maps QuickTime to MOV and the other MP4 brands to MP4', () => {
    expect(job(decide(probe([video()]), {}, {}, { format: 'mov' })).container).toBe('mov');
    expect(job(decide(probe([video()]), {}, {}, { format: 'm4v' })).container).toBe('mp4');
    expect(job(decide(probe([video()]), {}, {}, { format: '3gp' })).container).toBe('mp4');
  });

  it('ignores the chapter text track and drops data streams only on request', () => {
    const chapterTrack = stream({ index: 1, type: 'data', codec: 'bin_data', codecTag: 'text' });
    expect(job(decide(probe([video(), chapterTrack], { chapters: 3 }))).droppedStreams).toEqual([]);
    expect(skipped(decide(probe([video(), chapterTrack], { chapters: 0 }))).reason).toBe('unsupported-data-stream');
    const tmcd = stream({ index: 2, type: 'data', codec: 'bin_data', codecTag: 'tmcd' });
    const telemetry = stream({ index: 3, type: 'data', codec: 'gpmd' });
    expect(job(decide(probe([video(), tmcd, telemetry]), { dropDataStreams: true })).droppedStreams).toEqual(['stream 2 (data/tmcd)', 'stream 3 (data/gpmd)']);
  });

  it('applies rotation, anamorphic pixels and the resolution cap', () => {
    const rotated = job(decide(probe([video({ rotation: 90 })])));
    expect(rotated.expected).toMatchObject({ width: 1080, height: 1920 });
    expect(rotated.conversions).toContain('rotation of 90° applied to the pixels (display unchanged)');
    const r270 = job(decide(probe([video({ rotation: 270, width: 1280, height: 720 })]), { force: true }));
    expect(r270.expected).toMatchObject({ width: 720, height: 1280 });
    const flipped = job(decide(probe([video({ rotation: 180 })])));
    expect(flipped.expected).toMatchObject({ width: 1920, height: 1080 });

    const anamorphic = job(decide(probe([video({ width: 720, height: 576, sampleAspectRatio: '16:15' })])));
    expect(anamorphic.expected).toMatchObject({ width: 768, height: 576 });
    expect(anamorphic.scale).toBeUndefined();

    const capped = job(decide(probe([video({ width: 3840, height: 2160 })]), { maxShortSide: 720 }));
    expect(capped.scale).toEqual({ width: 1280, height: 720 });
    expect(capped.conversions[0]).toBe('video: h264 3840x2160 → h264 1280x720 (CRF 23)');

    const odd = job(decide(probe([video({ width: 1919, height: 1079, bitRate: 100_000 })]), { maxShortSide: 'original' }));
    expect(odd.scale).toEqual({ width: 1918, height: 1078 });
  });

  it('re-encodes efficient sources only when forced, scaled, or with legacy codecs', () => {
    const efficient = probe([video({ bitRate: 1_000_000 })]);
    expect(decide(efficient).action).toBe('skip');
    expect(decide(efficient, { force: true }).action).toBe('transcode');
    expect(job(decide(efficient, { maxShortSide: 720 })).scale).toEqual({ width: 1280, height: 720 });
    expect(decide(probe([video({ bitRate: 1_000_000, codec: 'mpeg4' })])).action).toBe('transcode');
    expect(decide(probe([video({ bitRate: 1_000_000, frameRate: undefined })])).action).toBe('transcode');
    // Without stream bitrate, the container bitrate (90 %) or the file size is used.
    expect(decide(probe([video({ bitRate: undefined })], { bitRate: 1_000_000 })).action).toBe('skip');
    expect(decide(probe([video({ bitRate: undefined })]), {}, {}, { size: 1_000_000 }).action).toBe('skip');
    expect(decide(probe([video({ bitRate: undefined })]), {}, {}, { size: 50_000_000 }).action).toBe('transcode');
    // The threshold depends on the profile.
    const mid = probe([video({ bitRate: 5_000_000 })]); // ~0.096 bpp
    expect(decide(mid, { preset: 'balanced' }).action).toBe('transcode');
    expect(decide(mid, { preset: 'aggressive' }).action).toBe('skip');
    expect(VIDEO_PROFILES.aggressive.efficientBpp).toBeGreaterThan(VIDEO_PROFILES.balanced.efficientBpp);
  });

  it('picks the x264 preset from the override or the engine class', () => {
    const p = probe([video()]);
    expect(job(decide(p, { x264Preset: 'veryfast' })).x264Preset).toBe('veryfast');
    expect(job(decide(p, {}, { engineClass: 'browser' })).x264Preset).toBe('veryfast');
    expect(job(decide(p, { preset: 'conservative', crf: 20 })).x264Preset).toBe('slow');
  });

  it('uses the stream duration when the container has none', () => {
    const j = job(decide(probe([video({ duration: 7.5 })], { duration: undefined })));
    expect(j.expected.duration).toBe(7.5);
    expect(skipped(decide(probe([video()], { duration: 0 }))).reason).toBe('unknown-duration');
  });
});

describe('targetSize and parseSar', () => {
  it('keeps even dimensions within the cap', () => {
    expect(targetSize(1920, 1080, 'original')).toEqual({ width: 1920, height: 1080 });
    expect(targetSize(1921, 1081, 'original')).toEqual({ width: 1920, height: 1080 });
    expect(targetSize(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(targetSize(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
    expect(targetSize(640, 360, 1080)).toEqual({ width: 640, height: 360 });
    // Very wide frames are limited by the long side (16:9 of the cap).
    expect(targetSize(3840, 1080, 720)).toEqual({ width: 1280, height: 360 });
    expect(targetSize(4, 2000, 360)).toEqual({ width: 2, height: 640 });
  });

  it('parses sample aspect ratios', () => {
    expect(parseSar('4:3')).toBeCloseTo(4 / 3);
    expect(parseSar('1:1')).toBe(1);
    expect(parseSar('0:1')).toBe(1);
    expect(parseSar('1:0')).toBe(1);
    expect(parseSar('N/A')).toBe(1);
    expect(parseSar(undefined)).toBe(1);
  });
});

describe('FFmpeg arguments', () => {
  const mp4Job = job(
    decide(
      probe(
        [
          video({ width: 3840, height: 2160 }),
          audio(1, 'aac'),
          audio(2, 'pcm_s16le', { sampleRate: 44100 }),
          audio(3, 'ac3', { sampleRate: undefined }),
          stream({ index: 4, type: 'subtitle', codec: 'mov_text' }),
        ],
        {
          chapters: 1,
        },
      ),
    ),
  );

  it('builds a locked-down x264 command', () => {
    const args = buildVideoArgs(mp4Job, '/tmp/in.mp4', '/tmp/out.mp4', { threads: 2, progressPipe: true });
    expect(args.slice(0, 4)).toEqual(['-hide_banner', '-nostdin', '-loglevel', 'error']);
    expect(args.join(' ')).toContain('-progress pipe:1 -nostats -protocol_whitelist file -f mov -enable_drefs 0 -i /tmp/in.mp4');
    expect(args.join(' ')).toContain('-map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map_metadata 0 -map_chapters 0');
    expect(args.join(' ')).toContain('-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -profile:v high -threads 2');
    expect(args.join(' ')).toContain('-vf scale=1920:1080:flags=lanczos,setsar=1');
    expect(args.join(' ')).toContain('-c:a:0 copy -c:a:1 aac -b:a:1 128k -ar:a:1 44100 -c:a:2 aac -b:a:2 128k -c:s copy');
    expect(args.slice(-6)).toEqual(['-movflags', '+faststart', '-f', 'mp4', '-y', '/tmp/out.mp4']);
  });

  it('omits optional parts and uses the right muxers', () => {
    const plain = job(decide(probe([video()]), {}, {}, { format: 'mov' }));
    const args = buildVideoArgs(plain, 'in', 'out');
    expect(args).not.toContain('-progress');
    expect(args).not.toContain('-threads');
    expect(args).not.toContain('-c:s');
    expect(args.slice(-4)).toEqual(['-f', 'mov', '-y', 'out']);
  });

  it('builds a VP9 command for WebM', () => {
    const webm = job(decide(probe([video({ codec: 'vp8' }), audio(1, 'aac')], { formatName: 'matroska,webm' }), {}, {}, { format: 'webm' }));
    const args = buildVideoArgs(webm, 'in.webm', 'out.webm');
    expect(args).not.toContain('-enable_drefs');
    expect(args.join(' ')).toContain('-f matroska -i in.webm');
    expect(args.join(' ')).toContain('-c:v libvpx-vp9 -crf 33 -b:v 0 -row-mt 1 -deadline good -cpu-used 4 -pix_fmt yuv420p');
    expect(args.join(' ')).toContain('-c:a:0 libopus -b:a:0 128k -ar:a:0 48000');
    expect(args.slice(-4)).toEqual(['-f', 'webm', '-y', 'out.webm']);
  });

  it('builds the decode check command', () => {
    expect(buildDecodeCheckArgs({ demuxer: 'matroska,webm' }, 'c.webm')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-xerror',
      '-protocol_whitelist',
      'file',
      '-f',
      'matroska',
      '-i',
      'c.webm',
      '-map',
      '0',
      '-f',
      'null',
      '-',
    ]);
  });
});

describe('candidate validation', () => {
  const j = job(
    decide(
      probe([video({ rotation: 90 }), audio(1, 'aac', { language: 'spa' }), audio(2, 'pcm_s16le'), stream({ index: 3, type: 'subtitle', codec: 'mov_text' })], {
        chapters: 2,
      }),
    ),
  );

  /** A candidate that matches the job exactly (rotation already applied to the pixels). */
  function good(extra: Partial<ProbeResult> = {}): ProbeResult {
    return probe(
      [
        stream({ index: 0, type: 'video', codec: 'h264', width: 1080, height: 1920, pixFmt: 'yuv420p', frameRate: 25 }),
        audio(1, 'aac', { language: 'spa' }),
        audio(2, 'aac'),
        stream({ index: 3, type: 'subtitle', codec: 'mov_text' }),
      ],
      { chapters: 2, ...extra },
    );
  }

  it('accepts a matching candidate, also when rotation metadata remains', () => {
    expect(validateVideoCandidate(j, good())).toEqual({ ok: true, problems: [] });
    const withMatrix = good();
    const rotatedMeta = probe(
      [
        stream({ index: 0, type: 'video', codec: 'h264', width: 1920, height: 1080, pixFmt: 'yuv420p', frameRate: 25, rotation: 270 }),
        ...withMatrix.streams.slice(1),
      ],
      { chapters: 2 },
    );
    expect(validateVideoCandidate(j, rotatedMeta).ok).toBe(true);
    // A small duration difference within the tolerance is fine.
    expect(validateVideoCandidate(j, good({ duration: 10.2 })).ok).toBe(true);
  });

  it('reports every mismatch', () => {
    const bad = probe(
      [
        stream({ index: 0, type: 'video', codec: 'hevc', width: 640, height: 360, pixFmt: 'yuv444p', frameRate: 30 }),
        audio(1, 'mp3', { channels: 1, language: 'eng' }),
      ],
      { chapters: 0, duration: 9 },
    );
    expect(validateVideoCandidate(j, bad).problems).toEqual([
      'video codec hevc instead of h264',
      'size 640x360 instead of 1080x1920',
      'pixel format yuv444p instead of yuv420p',
      'frame rate 30.000 instead of 25.000',
      'duration 9.000 s differs from 10.000 s by more than 0.25 s',
      'expected 2 audio streams, found 1',
      'audio stream 0 codec mp3 instead of aac',
      'audio stream 0 has 1 channels instead of 2',
      'audio stream 0 lost its language (spa)',
      'expected 1 subtitle streams, found 0',
      'expected 2 chapters, found 0',
    ]);
  });

  it('reports missing or duplicated video, unknown duration and unknown fields', () => {
    const none = validateVideoCandidate(j, probe([], { duration: undefined, chapters: 2 }));
    expect(none.problems).toContain('expected 1 video stream, found 0');
    expect(none.problems).toContain('duration unknown s differs from 10.000 s by more than 0.25 s');
    const two = validateVideoCandidate(j, probe([...good().streams, stream({ index: 9, type: 'video', codec: 'h264' })], { chapters: 2 }));
    expect(two.problems).toContain('expected 1 video stream, found 2');
    const vague = probe(
      [
        stream({ index: 0, type: 'video', codec: 'h264', width: 1080, height: 1920 }),
        audio(1, 'aac', { channels: undefined, language: 'spa' }),
        audio(2, 'aac'),
      ],
      { chapters: 2 },
    );
    const r = validateVideoCandidate(j, vague);
    expect(r.problems).toContain('pixel format unknown instead of yuv420p');
    expect(r.problems).toContain('audio stream 0 has ? channels instead of 2');
  });

  it('computes tolerances and replacement thresholds', () => {
    expect(durationTolerance(undefined)).toBe(0.25);
    expect(durationTolerance(60)).toBe(0.25);
    expect(durationTolerance(10)).toBeCloseTo(0.3);
    const t = { minSavingsPercent: 10, minSavingsBytes: 50 };
    expect(isWorthReplacing(1000, 900, t)).toBe(true);
    expect(isWorthReplacing(1000, 950, t)).toBe(false);
    expect(isWorthReplacing(100, 60, t)).toBe(false);
    expect(isWorthReplacing(1000, 1200, { minSavingsPercent: 0, minSavingsBytes: 0 })).toBe(false);
    expect(isWorthReplacing(1000, 1000, { minSavingsPercent: 0, minSavingsBytes: 0 })).toBe(true);
  });

  it('honours custom limits', () => {
    const small = resolveLimits(NATIVE_LIMITS, { maxVideoPixels: 1000 });
    expect(skipped(decide(probe([video()]), {}, {}, {}, small)).reason).toBe('exceeds-resolution-limit');
  });
});
