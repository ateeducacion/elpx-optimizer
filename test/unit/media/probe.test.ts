import { describe, expect, it } from 'vitest';
import {
  effectiveDuration,
  FFPROBE_ARGS,
  hasAlphaPixFmt,
  isHdr,
  isHighBitDepth,
  normalizeProbe,
  normalizeRotation,
  parseProbeJson,
  parseRational,
  videoStreams,
  type ProbeStream,
} from '../../../src/core/media/probe.js';

/** Minimal stream with the required fields. */
function stream(extra: Partial<ProbeStream> = {}): ProbeStream {
  return { index: 0, type: 'video', codec: 'h264', rotation: 0, attachedPic: false, isDefault: false, alphaMode: false, ...extra };
}

describe('normalizeProbe', () => {
  it('normalizes a typical ffprobe document', () => {
    const p = normalizeProbe({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5', bit_rate: '800000', size: '1250000', tags: { title: 'Clase', count: 3 } },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          codec_tag_string: 'avc1',
          profile: 'High',
          width: 1280,
          height: 720,
          pix_fmt: 'yuv420p',
          field_order: 'progressive',
          avg_frame_rate: '30000/1001',
          r_frame_rate: '30/1',
          duration: '12.5',
          bit_rate: '700000',
          nb_frames: '375',
          sample_aspect_ratio: '1:1',
          color_transfer: 'bt709',
          color_primaries: 'bt709',
          color_space: 'bt709',
          bits_per_raw_sample: '8',
          disposition: { default: 1, attached_pic: 0 },
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
          tags: { handler_name: 'VideoHandler', language: 'und' },
        },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          channels: 2,
          channel_layout: 'stereo',
          sample_rate: '48000',
          tags: { language: 'spa', title: 'Español' },
        },
      ],
      chapters: [{ id: 0 }, { id: 1 }],
    });
    expect(p).toMatchObject({ formatName: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 12.5, bitRate: 800000, size: 1250000, chapters: 2, tags: { title: 'Clase' } });
    expect(p.tags).not.toHaveProperty('count');
    const [v, a] = p.streams;
    expect(v).toMatchObject({
      index: 0,
      type: 'video',
      codec: 'h264',
      codecTag: 'avc1',
      profile: 'High',
      width: 1280,
      height: 720,
      pixFmt: 'yuv420p',
      fieldOrder: 'progressive',
      duration: 12.5,
      bitRate: 700000,
      frames: 375,
      sampleAspectRatio: '1:1',
      colorTransfer: 'bt709',
      colorPrimaries: 'bt709',
      colorSpace: 'bt709',
      bitsPerRawSample: 8,
      rotation: 270,
      isDefault: true,
      attachedPic: false,
      alphaMode: false,
      handler: 'VideoHandler',
      language: 'und',
    });
    expect(v!.frameRate).toBeCloseTo(29.97, 2);
    expect(a).toMatchObject({ type: 'audio', codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48000, language: 'spa', title: 'Español' });
    expect(a).not.toHaveProperty('width');
  });

  it('uses the legacy rotate tag only when no display matrix rotates the frame', () => {
    const legacy = normalizeProbe({ streams: [{ codec_type: 'video', tags: { rotate: '90' } }] });
    expect(legacy.streams[0]!.rotation).toBe(270);
    const both = normalizeProbe({ streams: [{ codec_type: 'video', tags: { rotate: '90' }, side_data_list: [{ rotation: 180 }, { other: 1 }] }] });
    expect(both.streams[0]!.rotation).toBe(180);
    const zeroMatrix = normalizeProbe({ streams: [{ codec_type: 'video', tags: { rotate: '-90' }, side_data_list: [{ rotation: 0 }] }] });
    expect(zeroMatrix.streams[0]!.rotation).toBe(90);
  });

  it('detects cover art, alpha mode and unknown stream types, with defaults', () => {
    const p = normalizeProbe({
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        { index: 2, codec_type: 'video', codec_name: 'vp9', tags: { alpha_mode: '1' } },
        { index: 3, codec_type: 'video', codec_name: 'vp9', tags: { ALPHA_MODE: '1' } },
        { index: 4, codec_type: 'subtitle', codec_name: 'mov_text' },
        { index: 5, codec_type: 'data' },
        { index: 6, codec_type: 'attachment' },
        { index: 7, codec_type: 'weird' },
      ],
    });
    expect(p.formatName).toBe('unknown');
    expect(p.chapters).toBe(0);
    expect(p.tags).toEqual({});
    expect(p.streams.map((s) => s.type)).toEqual(['video', 'video', 'video', 'subtitle', 'data', 'attachment', 'unknown']);
    expect(p.streams[0]).toMatchObject({ index: -1, attachedPic: true, codec: 'mjpeg' });
    expect(p.streams[1]!.alphaMode).toBe(true);
    expect(p.streams[2]!.alphaMode).toBe(true);
    expect(p.streams[5]!.codec).toBe('unknown');
    expect(videoStreams(p).map((s) => s.index)).toEqual([2, 3]);
  });

  it('ignores N/A, empty and non-numeric values', () => {
    const p = normalizeProbe({
      format: { format_name: 'matroska,webm', duration: 'N/A', bit_rate: '', size: 'abc' },
      streams: [
        { codec_type: 'video', width: Number.POSITIVE_INFINITY, height: '  ', avg_frame_rate: '0/0', r_frame_rate: '25/1', duration: {}, codec_name: '' },
      ],
    });
    expect(p).not.toHaveProperty('duration');
    expect(p).not.toHaveProperty('bitRate');
    expect(p).not.toHaveProperty('size');
    const s = p.streams[0]!;
    expect(s).not.toHaveProperty('width');
    expect(s).not.toHaveProperty('height');
    expect(s).not.toHaveProperty('duration');
    expect(s.frameRate).toBe(25);
    expect(s.codec).toBe('unknown');
  });

  it('rejects unusable input', () => {
    expect(() => normalizeProbe(null)).toThrow(/no data/);
    expect(() => normalizeProbe('text')).toThrow(/no data/);
    expect(() => normalizeProbe({})).toThrow(/could not identify/);
    expect(() => normalizeProbe({ format: { format_name: '' }, streams: 'x' })).toThrow(/could not identify/);
    expect(normalizeProbe({ format: { format_name: 'mp3' } }).streams).toEqual([]);
  });

  it('parses JSON text', () => {
    expect(parseProbeJson('{"format":{"format_name":"ogg"}}').formatName).toBe('ogg');
    expect(() => parseProbeJson('{')).toThrow(/not valid JSON/);
  });

  it('exposes the fixed ffprobe arguments', () => {
    expect(FFPROBE_ARGS).toEqual(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters']);
  });
});

describe('probe helpers', () => {
  it('parses rationals', () => {
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRational('25/1')).toBe(25);
    expect(parseRational('1/0')).toBeUndefined();
    expect(parseRational('-1/2')).toBeUndefined();
    expect(parseRational('0/1')).toBeUndefined();
    expect(parseRational('24')).toBe(24);
    expect(parseRational('fast')).toBeUndefined();
    expect(parseRational(12.5)).toBe(12.5);
    expect(parseRational(undefined)).toBeUndefined();
  });

  it('normalizes rotations', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-180.2)).toBe(180);
    expect(normalizeRotation(45)).toBe(45);
  });

  it('computes the effective duration', () => {
    const base = { formatName: 'mp4', chapters: 0, tags: {} };
    expect(effectiveDuration({ ...base, duration: 10, streams: [stream({ duration: 12 })] })).toBe(10);
    expect(effectiveDuration({ ...base, duration: 0, streams: [stream({ duration: 3 }), stream({ duration: 12 }), stream()] })).toBe(12);
    expect(effectiveDuration({ ...base, streams: [stream()] })).toBeUndefined();
  });

  it('recognizes alpha pixel formats', () => {
    for (const f of ['yuva420p', 'rgba', 'bgra', 'argb', 'abgr', 'gbrap', 'ya8', 'pal8', 'ayuv64le', 'x_a64le']) expect(hasAlphaPixFmt(f)).toBe(true);
    for (const f of ['yuv420p', 'rgb24', 'gray', undefined, '']) expect(hasAlphaPixFmt(f)).toBe(false);
  });

  it('recognizes high bit depth and HDR', () => {
    expect(isHighBitDepth(stream({ bitsPerRawSample: 10 }))).toBe(true);
    expect(isHighBitDepth(stream({ pixFmt: 'yuv420p10le' }))).toBe(true);
    expect(isHighBitDepth(stream({ pixFmt: 'rgb48be' }))).toBe(true);
    expect(isHighBitDepth(stream({ pixFmt: 'yuv420p', bitsPerRawSample: 8 }))).toBe(false);
    expect(isHighBitDepth(stream())).toBe(false);
    expect(isHdr(stream({ colorTransfer: 'smpte2084' }))).toBe(true);
    expect(isHdr(stream({ colorTransfer: 'arib-std-b67' }))).toBe(true);
    expect(isHdr(stream({ colorTransfer: 'bt709' }))).toBe(false);
    expect(isHdr(stream())).toBe(false);
  });
});
