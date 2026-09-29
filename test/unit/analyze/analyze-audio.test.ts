import { describe, expect, it } from 'vitest';
import type { ProgressEvent } from '../../../src/core/media/engine.js';
import { sniff } from '../../../src/core/media/sniff.js';
import { analyzeBytes, buildElpx, diags, entry, limits } from '../../helpers/core-kit.js';
import { AUDIO_CAPS, MemoryStore, audioEngine, audioProbe, engineInfo, fakeAiff, fakeFlac, fakeM4a, fakeMp3, fakeWav } from '../../helpers/fake-platform.js';

/** Inspection of audio files during the analysis: which files are probed and what their summaries say. */

const R = '{{context_path}}/content/resources';

const bytes = buildElpx({
  components: [{ html: ['voz.wav', 'pista.aiff', 'musica.flac', 'alta.mp3', 'charla.m4a'].map((f) => `<audio src="${R}/${f}"></audio>`).join('') }],
  files: {
    'content/resources/voz.wav': fakeWav(4000),
    'content/resources/pista.aiff': fakeAiff(3000),
    'content/resources/musica.flac': fakeFlac(3500),
    'content/resources/alta.mp3': fakeMp3(2500),
    'content/resources/charla.m4a': fakeM4a(2000),
    'content/resources/enorme.wav': fakeWav(9000),
    // Runtime files are never inspected.
    'theme/sonido.wav': fakeWav(1000),
  },
});

describe('analyzeArchive: audio', () => {
  it('probes the audio formats the policy can act on and summarizes their first audio stream', async () => {
    const store = new MemoryStore();
    const engine = audioEngine(store);
    const events: ProgressEvent[] = [];
    const a = await analyzeBytes(bytes, { media: { engine, store }, limits: limits({ maxVideoBytes: 5000 }), onProgress: (e) => events.push(e) });
    expect([...a.probes.keys()].sort()).toEqual([
      'content/resources/alta.mp3',
      'content/resources/charla.m4a',
      'content/resources/musica.flac',
      'content/resources/pista.aiff',
      'content/resources/voz.wav',
    ]);
    expect(events.filter((e) => e.stage === 'probe').map((e) => [e.resource, e.items])).toContainEqual(['content/resources/enorme.wav', 6]);
    expect(a.result.media).toEqual({ probed: true, engine: 'native' });
    expect(entry(a, 'content/resources/voz.wav')).toMatchObject({
      kind: 'audio',
      format: 'wav',
      audio: { codec: 'pcm_s16le', duration: 10, channels: 2, sampleRate: 44100, bitRate: 1_411_200 },
    });
    expect(entry(a, 'content/resources/voz.wav').video).toBeUndefined();
    // The container bitrate stands in for a stream without one.
    expect(entry(a, 'content/resources/musica.flac').audio).toEqual({ codec: 'flac', duration: 10, channels: 1, sampleRate: 44100, bitRate: 766_000 });
    expect(entry(a, 'content/resources/pista.aiff').audio).toMatchObject({ codec: 'pcm_s16be', sampleRate: 22050 });
    expect(entry(a, 'content/resources/charla.m4a').audio?.codec).toBe('aac');
    expect(entry(a, 'content/resources/enorme.wav').audio).toBeUndefined();
    expect(entry(a, 'theme/sonido.wav').audio).toBeUndefined();
  });

  it('prefers stream values, omits unknown ones and skips probes without audio', async () => {
    const store = new MemoryStore();
    const engine = audioEngine(store);
    engine.probeInput = (r) => {
      if (r.name.endsWith('.wav')) return audioProbe('pcm_s16le', { duration: 9.5, bitRate: 700_000 }, { duration: 10, bitRate: 800_000 });
      if (r.name.endsWith('.mp3')) return audioProbe('mp3', { channels: undefined, sampleRate: undefined }, { duration: undefined, bitRate: undefined });
      return { formatName: 'aiff', streams: [], chapters: 0, tags: {} };
    };
    const a = await analyzeBytes(bytes, { media: { engine, store } });
    expect(entry(a, 'content/resources/voz.wav').audio).toEqual({ codec: 'pcm_s16le', duration: 9.5, channels: 2, sampleRate: 44100, bitRate: 700_000 });
    expect(entry(a, 'content/resources/alta.mp3').audio).toEqual({ codec: 'mp3' });
    expect(entry(a, 'content/resources/pista.aiff').audio).toBeUndefined();
    expect(a.probes.has('content/resources/pista.aiff')).toBe(true);
  });

  it('reports failed probes and engines that cannot inspect media', async () => {
    const store = new MemoryStore();
    const engine = audioEngine(store);
    engine.probeInput = (r) => {
      if (r.name.endsWith('.flac')) throw new Error('Invalid data found when processing input');
      return audioProbe('pcm_s16le');
    };
    const failed = await analyzeBytes(bytes, { media: { engine, store } });
    expect(diags(failed, 'media-probe-failed').map((d) => d.message)).toEqual(['content/resources/musica.flac: Invalid data found when processing input']);
    expect(entry(failed, 'content/resources/musica.flac').audio).toBeUndefined();
    // ffmpeg without libx264 can still convert audio: files are inspected anyway.
    const noVideo = { available: false, encoders: [], engineClass: 'native' as const, slowEncoders: [], reason: 'ffmpeg lacks the libx264 encoder' };
    engine.infoValue = engineInfo({ video: noVideo, audio: AUDIO_CAPS });
    engine.probeInput = (r) => audioProbe(r.name.endsWith('.mp3') ? 'mp3' : 'pcm_s16le');
    const audioOnly = await analyzeBytes(bytes, { media: { engine, store } });
    expect(audioOnly.probes.size).toBe(6);
    expect(diags(audioOnly, 'media-engine-unavailable')).toEqual([]);
    expect(audioOnly.result.media).toEqual({ probed: true, engine: 'native' });
    engine.infoValue = engineInfo({
      video: { ...noVideo, reason: 'ffprobe not found' },
      audio: { available: false, encoders: [], reason: 'ffprobe not found' },
    });
    const off = await analyzeBytes(bytes, { media: { engine, store } });
    expect(off.probes.size).toBe(0);
    expect(diags(off, 'media-engine-unavailable').map((d) => d.message)).toEqual(['Videos and audio were not inspected: ffprobe not found']);
    expect((await analyzeBytes(bytes)).result.media).toEqual({ probed: false, note: 'Videos and audio were not inspected (no media engine)' });
    // Audio support alone is reported by the engine; the plan uses it.
    expect(engineInfo({ audio: AUDIO_CAPS }).audio).toEqual({ available: true, encoders: ['libmp3lame', 'aac', 'libopus'] });
  });
});

describe('sniff: AIFF', () => {
  it('recognizes AIFF and AIFF-C by content and accepts both extensions', () => {
    const aifc = fakeAiff(64);
    aifc.set([0x41, 0x49, 0x46, 0x43], 8);
    expect(sniff(fakeAiff(64), 'a.aiff')).toEqual({ kind: 'audio', format: 'aiff', mime: 'audio/aiff' });
    expect(sniff(aifc, 'a.aif').format).toBe('aiff');
    // FORM chunks of other types are not audio.
    const other = fakeAiff(64);
    other.set([0x49, 0x4c, 0x42, 0x4d], 8);
    expect(sniff(other, 'a.iff').kind).not.toBe('audio');
  });

  it('matches .aif and .aiff names to AIFF content', async () => {
    const a = await analyzeBytes(
      buildElpx({
        components: [],
        files: { 'content/resources/a.aif': fakeAiff(100), 'content/resources/b.aiff': fakeAiff(100), 'content/resources/c.aiff': fakeWav(100) },
      }),
    );
    expect(entry(a, 'content/resources/a.aif').extensionMatches).toBe(true);
    expect(entry(a, 'content/resources/b.aiff').extensionMatches).toBe(true);
    expect(entry(a, 'content/resources/c.aiff').extensionMatches).toBe(false);
  });
});
