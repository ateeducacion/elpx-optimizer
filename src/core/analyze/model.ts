import type { Diagnostic, SourceLocation } from '../diagnostics.js';
import type { ImageInfo } from '../media/image-inspect.js';
import type { PdfInfo } from '../media/pdf-policy.js';
import type { OdfInfo } from '../media/odf-policy.js';
import type { ProbeResult } from '../media/probe.js';
import type { ResourceKind } from '../media/sniff.js';
import type { LenientRule, ReferenceForm, ResolutionStatus } from '../refs/resolve.js';
import type { ElementAnchor, Lift, ReferenceKind, Representation, RemovalSite } from '../refs/scan.js';
import type { PackageVariant } from '../format/detect.js';
import type { OdeDocument } from '../format/content-xml.js';
import type { ElpxManifest } from '../format/manifest.js';
import type { ZipArchive } from '../zip/reader.js';

/** Role of an entry in the package. */
export type EntryRole = 'package' | 'page' | 'runtime' | 'user-asset' | 'other';

/** Whether a user asset is used, according to the reference graph. */
export type Usage = 'used' | 'uncertain' | 'protected' | 'unreferenced' | 'not-applicable';

export interface VideoSummary {
  readonly container: string;
  readonly duration?: number;
  readonly width?: number;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly frameRate?: number;
  readonly bitRate?: number;
  readonly rotation?: number;
  readonly audio: readonly { codec: string; channels?: number; language?: string }[];
  readonly subtitles: number;
  readonly chapters: number;
  readonly otherStreams: number;
}

export interface AudioSummary {
  readonly codec: string;
  readonly duration?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly bitRate?: number;
}

export interface ImageSummary {
  readonly width?: number;
  readonly height?: number;
  readonly hasAlpha?: boolean;
  readonly animated: boolean;
  readonly orientation?: number;
  readonly hasIcc: boolean;
  readonly hasExif: boolean;
  readonly hasXmp: boolean;
  readonly colorModel?: string;
  readonly bitDepth?: number;
  readonly jpegQuality?: number;
  readonly lossless?: boolean;
}

export interface InventoryEntry {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: 'stored' | 'deflate';
  readonly role: EntryRole;
  readonly kind: ResourceKind;
  readonly format: string;
  readonly mime: string;
  readonly extensionMatches?: boolean;
  readonly sha256?: string;
  readonly usage: Usage;
  readonly usageReasons: readonly string[];
  /** Number of references that resolve to this entry. */
  readonly references: number;
  /** Entries containing those references (deduplicated). */
  readonly referencedFrom: readonly string[];
  readonly representations: readonly Representation[];
  readonly resolutionSensitive: boolean;
  readonly duplicateGroup?: number;
  readonly image?: ImageSummary;
  readonly video?: VideoSummary;
  /** Present for probed audio files (and audio-only recordings in video containers). */
  readonly audio?: AudioSummary;
  /** Present for PDFs inspected with qpdf. */
  readonly pdf?: PdfInfo;
}

/** Serializable view of a reference. */
export interface ReferenceRecord {
  readonly id: number;
  readonly value: string;
  readonly form: ReferenceForm;
  readonly status: ResolutionStatus;
  readonly target?: string;
  readonly candidates?: readonly string[];
  readonly lenient?: LenientRule;
  readonly percentEncoded?: boolean;
  readonly kind: ReferenceKind;
  readonly representation: Representation;
  readonly location: SourceLocation;
  readonly via: readonly string[];
  readonly rewritable: boolean;
}

export interface DuplicateGroup {
  readonly id: number;
  readonly sha256: string;
  readonly size: number;
  readonly format: string;
  readonly paths: readonly string[];
}

export interface PackageSummary {
  readonly variant: PackageVariant;
  readonly title?: string;
  readonly odeId?: string;
  readonly exeVersion?: string;
  readonly hasDoctype: boolean;
  readonly pages: number;
  readonly components: number;
  readonly ideviceTypes: Readonly<Record<string, number>>;
  readonly hasScreenshot: boolean;
  readonly hasManifest: boolean;
  readonly hasSearchIndex: boolean;
  readonly hasPublishedHtml: boolean;
  /** User files stored in eXeLearning 3 editor folders (content/resources/<ODE-ID>/<file>). */
  readonly legacyFolders: { readonly folders: number; readonly files: number };
}

export interface AnalysisResult {
  readonly schema: 'elpx-optimizer/analysis';
  readonly schemaVersion: number;
  readonly tool: { readonly name: string; readonly version: string; readonly upstream: string };
  readonly input: { readonly name: string; readonly size: number; readonly sha256: string };
  /** False when a fatal problem prevents a reliable analysis. */
  readonly ok: boolean;
  readonly package?: PackageSummary;
  readonly totals: {
    readonly entries: number;
    readonly files: number;
    readonly uncompressedBytes: number;
    readonly userAssetBytes: number;
    readonly imageBytes: number;
    readonly videoBytes: number;
    readonly audioBytes: number;
  };
  readonly entries: readonly InventoryEntry[];
  readonly references: readonly ReferenceRecord[];
  readonly duplicates: readonly DuplicateGroup[];
  readonly diagnostics: readonly Diagnostic[];
  readonly media: { readonly probed: boolean; readonly engine?: string; readonly note?: string };
}

/** A reference plus the non-serializable data needed to rewrite or remove it. */
export interface ReferenceInternal extends ReferenceRecord {
  readonly site?: { readonly entry: string; readonly start: number; readonly end: number; readonly lift: Lift };
  /** The HTML element holding the reference in one of its attributes. */
  readonly element?: ElementAnchor;
  /** How the reference can be removed (explicit, rewritable references only). */
  readonly removal?: RemovalSite;
}

/** Text source kept in memory for rewriting. */
export interface TextSource {
  readonly entry: string;
  readonly text: string;
}

/** Analysis with the in-memory state needed to execute a plan. */
export interface Analysis {
  readonly result: AnalysisResult;
  readonly archive?: ZipArchive;
  readonly ode?: OdeDocument;
  readonly manifest?: ElpxManifest;
  readonly texts: ReadonlyMap<string, TextSource>;
  readonly references: readonly ReferenceInternal[];
  readonly probes: ReadonlyMap<string, ProbeResult>;
  readonly images: ReadonlyMap<string, ImageInfo>;
  /** PDFs inspected with qpdf (absent when no PDF engine was available). */
  readonly pdfs?: ReadonlyMap<string, PdfInfo>;
  /** ODT/ODP attachments opened as packages. */
  readonly odfs?: ReadonlyMap<string, OdfInfo>;
}
