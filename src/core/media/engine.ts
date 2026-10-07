import type { CancelSignal } from '../cancel.js';
import type { ByteSource } from '../io/byte-source.js';
import type { ZipArchive, ZipEntry } from '../zip/reader.js';
import type { ProbeResult } from './probe.js';
import type { VideoCapabilities, VideoJob } from './video-policy.js';
import type { ImageCapabilities, ImageJob } from './image-policy.js';
import type { AudioCapabilities, AudioJob } from './audio-policy.js';
import type { PdfCapabilities } from './pdf-policy.js';

/**
 * Contract implemented by NativeMediaEngine (ffmpeg/ffprobe + sharp) and
 * BrowserMediaEngine (ffmpeg.wasm + WASM image codecs). The core decides
 * what to do; engines only execute validated jobs and report capabilities.
 */

/** Bytes materialized for a media engine (temp file natively, Blob in the browser). */
export interface StoredResource {
  readonly size: number;
  /** Synthetic, safe name chosen by the store (never the user's file name). */
  readonly name: string;
  open(): Promise<ByteSource>;
  dispose(): Promise<void>;
}

/** Creates and tracks StoredResources for one optimization run. */
export interface ResourceStore {
  /** Extracts an archive entry (CRC-verified, size-limited) into a resource. */
  fromEntry(archive: ZipArchive, entry: ZipEntry, extension: string, signal?: CancelSignal): Promise<StoredResource>;
  /** Wraps bytes produced in memory. */
  fromBytes(bytes: Uint8Array, extension: string): Promise<StoredResource>;
  /** Releases every resource still alive. */
  disposeAll(): Promise<void>;
}

/** Stages reported to the user; percentages are only given when measurable. */
export type ProgressStage =
  'engine-load' | 'read' | 'analyze' | 'duplicates' | 'extract' | 'probe' | 'transcode' | 'encode-image' | 'pdf' | 'validate' | 'package' | 'verify' | 'done';

export interface ProgressEvent {
  readonly stage: ProgressStage;
  /** ZIP path of the resource being processed, if any. */
  readonly resource?: string;
  /** Index/total of the current item in its queue. */
  readonly item?: number;
  readonly items?: number;
  /** Media time processed so far (seconds), from real encoder output. */
  readonly processedSeconds?: number;
  readonly totalSeconds?: number;
  /** 0..1 when a reliable fraction is known; absent means indeterminate. */
  readonly fraction?: number;
  readonly message?: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

/** Per-job execution context. */
export interface JobContext {
  readonly signal?: CancelSignal;
  readonly onProgress?: ProgressListener;
  readonly resourcePath: string;
  readonly timeoutMs: number;
}

/** Tool/library versions and capabilities of an engine. */
export interface EngineInfo {
  readonly engine: 'native' | 'browser';
  readonly versions: Readonly<Record<string, string>>;
  readonly video: VideoCapabilities;
  readonly image: ImageCapabilities;
  /** Absent for engines without audio support (treated as unavailable). */
  readonly audio?: AudioCapabilities;
  /** Absent for engines without PDF support (treated as unavailable). */
  readonly pdf?: PdfCapabilities;
  readonly notes: readonly string[];
}

/** One run of qpdf: its exit code, output and the file it wrote at PDF_OUTPUT, if any. */
export interface QpdfResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output?: Uint8Array;
}

/** Result of decoding two images and comparing them. */
export interface ImageVerification {
  readonly ok: boolean;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  /** Present when pixel comparison was requested (lossless jobs). */
  readonly identicalPixels?: boolean;
  readonly problems: readonly string[];
}

export interface MediaEngine {
  info(): Promise<EngineInfo>;
  /** Runs ffprobe on a resource. */
  probe(resource: StoredResource, ctx: JobContext): Promise<ProbeResult>;
  /** Re-encodes a video according to a job built by the shared policy. */
  transcodeVideo(resource: StoredResource, job: VideoJob, ctx: JobContext): Promise<StoredResource>;
  /** Re-encodes an audio file according to a job built by the shared policy. */
  transcodeAudio?(resource: StoredResource, job: AudioJob, ctx: JobContext): Promise<StoredResource>;
  /** Fully decodes a candidate with the given demuxer; rejects on decoding errors. */
  decodeCheck(resource: StoredResource, job: Pick<VideoJob, 'demuxer'>, ctx: JobContext): Promise<void>;
  /** Optional browser playback check of a candidate (and whether the original played). */
  playbackCheck?(resource: StoredResource, mime: string, ctx: JobContext): Promise<'playable' | 'not-playable' | 'unsupported'>;
  /**
   * Runs qpdf (WebAssembly, the same build in both engines) with `input` at
   * PDF_INPUT; arguments come from the shared PDF policy only.
   */
  runQpdf?(args: readonly string[], input: Uint8Array, ctx: JobContext): Promise<QpdfResult>;
  /** Encodes image pixels (metadata stripped; the core re-injects preserved metadata). */
  encodeImage(input: Uint8Array, job: ImageJob, ctx: JobContext): Promise<Uint8Array>;
  /** Decodes original and candidate and compares them. */
  verifyImage(original: Uint8Array, candidate: Uint8Array, job: ImageJob, ctx: JobContext): Promise<ImageVerification>;
  /** Releases workers/processes. */
  dispose(): Promise<void>;
}
