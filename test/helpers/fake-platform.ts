/**
 * In-memory Platform for optimizeArchive tests: a scriptable MediaEngine, a
 * ResourceStore over Uint8Arrays and an OutputTarget built on
 * MemoryByteSink/MemoryByteSource. Every behaviour can be overridden per test
 * to exercise codec failures, rejected candidates and tampered outputs.
 */
import { MemoryByteSink } from '../../src/core/io/byte-sink.js';
import { MemoryByteSource, streamRange, type ByteSource } from '../../src/core/io/byte-source.js';
import { NATIVE_LIMITS, type Limits } from '../../src/core/limits.js';
import { readEntryBytes, type ZipArchive, type ZipEntry } from '../../src/core/zip/reader.js';
import type { CancelSignal } from '../../src/core/cancel.js';
import type { EngineInfo, ImageVerification, JobContext, MediaEngine, ResourceStore, StoredResource } from '../../src/core/media/engine.js';
import type { ProbeResult, ProbeStream } from '../../src/core/media/probe.js';
import type { VideoJob } from '../../src/core/media/video-policy.js';
import type { ImageJob } from '../../src/core/media/image-policy.js';
import type { OutputTarget, Platform } from '../../src/core/optimize/optimize.js';

/** A resource held in memory; `tag` tells originals from engine outputs. */
export class MemoryResource implements StoredResource {
  disposed = false;
  /** When set, dispose() rejects after releasing (cleanup failures must not mask results). */
  failing = false;
  constructor(
    readonly bytes: Uint8Array,
    readonly name: string,
    readonly tag: 'entry' | 'bytes' | 'candidate',
    private readonly onDispose?: () => Promise<void>,
  ) {}

  get size(): number {
    return this.bytes.length;
  }

  open(): Promise<ByteSource> {
    return Promise.resolve(new MemoryByteSource(this.bytes));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.onDispose?.();
    if (this.failing) throw new Error(`cannot delete ${this.name}`);
  }
}

/** ResourceStore keeping everything in memory and tracking live resources. */
export class MemoryStore implements ResourceStore {
  readonly live = new Set<MemoryResource>();
  created = 0;
  failDisposeAll = false;
  failDispose = false;
  /** Extensions requested for every stored resource, in order. */
  readonly extensions: string[] = [];

  async fromEntry(archive: ZipArchive, entry: ZipEntry, extension: string, signal?: CancelSignal): Promise<StoredResource> {
    const bytes = await readEntryBytes(archive, entry, Number.MAX_SAFE_INTEGER, signal ? { signal } : {});
    this.extensions.push(extension);
    return this.track(new MemoryResource(bytes, `r${++this.created}.${extension}`, 'entry'));
  }

  fromBytes(bytes: Uint8Array, extension: string): Promise<StoredResource> {
    this.extensions.push(extension);
    return Promise.resolve(this.track(new MemoryResource(bytes, `r${++this.created}.${extension}`, 'bytes')));
  }

  /** Registers an engine output so disposeAll releases it too. */
  track(r: MemoryResource): MemoryResource {
    r.failing = this.failDispose;
    this.live.add(r);
    return r;
  }

  async disposeAll(): Promise<void> {
    for (const r of this.live) r.disposed = true;
    this.live.clear();
    if (this.failDisposeAll) throw new Error('disposeAll failed');
  }
}

/** OutputTarget over a MemoryByteSink; `tamper` rewrites the finished bytes. */
export class MemoryOutput implements OutputTarget {
  readonly sink = new MemoryByteSink();
  discarded = false;
  failDiscard = false;
  usedOriginal = false;
  bytes: Uint8Array | undefined;

  constructor(private readonly tamper?: (bytes: Uint8Array) => Uint8Array) {}

  finish(): Promise<ByteSource> {
    const raw = this.sink.toBytes();
    this.bytes = this.tamper ? this.tamper(raw) : raw;
    return Promise.resolve(new MemoryByteSource(this.bytes));
  }

  async useOriginal(source: ByteSource): Promise<ByteSource> {
    const copy = new MemoryByteSink();
    for await (const chunk of streamRange(source, 0, source.size)) await copy.write(chunk);
    this.bytes = copy.toBytes();
    this.usedOriginal = true;
    return new MemoryByteSource(this.bytes);
  }

  discard(): Promise<void> {
    this.discarded = true;
    return this.failDiscard ? Promise.reject(new Error('cannot delete the output')) : Promise.resolve();
  }
}

/** Engine capabilities used by default. */
export function engineInfo(overrides: Partial<EngineInfo> = {}): EngineInfo {
  return {
    engine: 'native',
    versions: { fake: '1.0' },
    video: { available: true, encoders: ['libx264', 'aac', 'libvpx-vp9', 'libopus'], engineClass: 'native', slowEncoders: [] },
    image: { available: true, encoders: { jpeg: 'fake-jpeg', png: 'fake-png', webp: 'fake-webp' }, canResize: true },
    notes: [],
    ...overrides,
  };
}

/** Builds a video stream description for fake probes. */
export function videoStream(overrides: Partial<ProbeStream> = {}): ProbeStream {
  return {
    index: 0,
    type: 'video',
    codec: 'h264',
    width: 1280,
    height: 720,
    pixFmt: 'yuv420p',
    frameRate: 25,
    rotation: 0,
    attachedPic: false,
    isDefault: true,
    alphaMode: false,
    ...overrides,
  };
}

/** Probe of an inefficient 10 s H.264/AAC input. */
export function inputProbe(): ProbeResult {
  return {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: 10,
    bitRate: 8_000_000,
    streams: [
      videoStream({ bitRate: 7_800_000 }),
      { index: 1, type: 'audio', codec: 'aac', channels: 2, sampleRate: 48000, rotation: 0, attachedPic: false, isDefault: true, alphaMode: false },
    ],
    chapters: 0,
    tags: {},
  };
}

/** Probe matching a job's expectations (a valid candidate). */
export function candidateProbe(job: VideoJob): ProbeResult {
  return {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: job.expected.duration,
    streams: [
      videoStream({
        codec: job.videoCodec,
        width: job.expected.width,
        height: job.expected.height,
        ...(job.expected.frameRate ? { frameRate: job.expected.frameRate } : {}),
      }),
      ...job.expected.audio.map((a, i) => ({
        index: i + 1,
        type: 'audio' as const,
        codec: a.targetCodec,
        ...(a.channels !== undefined ? { channels: a.channels } : {}),
        rotation: 0,
        attachedPic: false,
        isDefault: true,
        alphaMode: false,
      })),
    ],
    chapters: job.expected.chapters,
    tags: {},
  };
}

/** Bytes that sniff as WebM (EBML header naming the webm doctype) padded to the requested size. */
export function fakeWebm(size: number): Uint8Array {
  const out = new Uint8Array(size).fill(9);
  out.set([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d], 0);
  return out;
}

/** Bytes that sniff as MP4 (ftyp box) padded to the requested size. */
export function fakeMp4(size: number, fill = 7): Uint8Array {
  const out = new Uint8Array(size).fill(fill);
  out.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return out;
}

/** Scriptable media engine; every method can be replaced by a test. */
export class FakeEngine implements MediaEngine {
  calls: string[] = [];
  infoValue: EngineInfo = engineInfo();
  probeInput: (r: MemoryResource) => ProbeResult = () => inputProbe();
  candidateBytes = fakeMp4(20_000, 3);
  probeCandidate: (job: VideoJob) => ProbeResult = candidateProbe;
  lastJob: VideoJob | undefined;
  transcode?: (r: MemoryResource, job: VideoJob, ctx: JobContext) => Promise<StoredResource>;
  decode?: () => Promise<void>;
  playback?: (r: MemoryResource) => Promise<'playable' | 'not-playable' | 'unsupported'>;
  encode: (input: Uint8Array, job: ImageJob) => Promise<Uint8Array> = () => Promise.reject(new Error('no image output configured'));
  verify: (original: Uint8Array, candidate: Uint8Array, job: ImageJob) => Promise<ImageVerification> = (_o, _c, job) =>
    Promise.resolve({
      ok: true,
      width: job.expected.width,
      height: job.expected.height,
      hasAlpha: job.expected.hasAlpha,
      problems: [],
      ...(job.mode === 'lossless' ? { identicalPixels: true } : {}),
    });

  constructor(readonly store: MemoryStore) {}

  info(): Promise<EngineInfo> {
    return Promise.resolve(this.infoValue);
  }

  probe(resource: StoredResource, _ctx: JobContext): Promise<ProbeResult> {
    const r = resource as MemoryResource;
    this.calls.push(`probe:${r.tag}`);
    return Promise.resolve(r.tag === 'candidate' ? this.probeCandidate(this.lastJob!) : this.probeInput(r));
  }

  transcodeVideo(resource: StoredResource, job: VideoJob, ctx: JobContext): Promise<StoredResource> {
    this.calls.push('transcode');
    this.lastJob = job;
    if (this.transcode) return this.transcode(resource as MemoryResource, job, ctx);
    return Promise.resolve(this.store.track(new MemoryResource(this.candidateBytes, 'candidate.mp4', 'candidate')));
  }

  decodeCheck(): Promise<void> {
    this.calls.push('decode');
    return this.decode ? this.decode() : Promise.resolve();
  }

  encodeImage(input: Uint8Array, job: ImageJob, _ctx: JobContext): Promise<Uint8Array> {
    this.calls.push(`encode:${job.format}`);
    return this.encode(input, job);
  }

  verifyImage(original: Uint8Array, candidate: Uint8Array, job: ImageJob, _ctx: JobContext): Promise<ImageVerification> {
    this.calls.push('verify');
    return this.verify(original, candidate, job);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** A playback-capable engine (browser-like). */
export class PlaybackEngine extends FakeEngine {
  playbackCheck(resource: StoredResource, _mime: string, _ctx: JobContext): Promise<'playable' | 'not-playable' | 'unsupported'> {
    this.calls.push(`playback:${(resource as MemoryResource).tag}`);
    return this.playback ? this.playback(resource as MemoryResource) : Promise.resolve('playable');
  }
}

export interface FakePlatform extends Platform {
  readonly engine: FakeEngine;
  readonly store: MemoryStore;
  outputs: MemoryOutput[];
}

/** Assembles a platform around a fake engine. */
export function fakePlatform(
  options: {
    engine?: FakeEngine;
    store?: MemoryStore;
    limits?: Limits;
    tamper?: (b: Uint8Array) => Uint8Array;
    createOutput?: () => Promise<OutputTarget>;
    imageConcurrency?: number;
  } = {},
): FakePlatform {
  const store = options.store ?? options.engine?.store ?? new MemoryStore();
  const engine = options.engine ?? new FakeEngine(store);
  const outputs: MemoryOutput[] = [];
  return {
    engine,
    store,
    limits: options.limits ?? NATIVE_LIMITS,
    imageConcurrency: options.imageConcurrency ?? 2,
    outputs,
    createOutput:
      options.createOutput ??
      (() => {
        const out = new MemoryOutput(options.tamper);
        outputs.push(out);
        return Promise.resolve(out);
      }),
  };
}
