import { Inflate } from 'fflate';
import { ElpxError } from '../errors.js';
import { throwIfCancelled, type CancelSignal } from '../cancel.js';
import type { Limits } from '../limits.js';
import { Crc32 } from '../io/crc32.js';
import { collectBytes, streamRange, type ByteSource } from '../io/byte-source.js';
import { bytesEqual, utf8DecodeLenient } from '../io/text.js';
import {
  CENTRAL_HEADER_SIZE,
  EOCD_MIN_SIZE,
  EXTRA_ZIP64,
  FLAG_DATA_DESCRIPTOR,
  FLAG_ENCRYPTED,
  FLAG_MASKED_HEADERS,
  FLAG_STRONG_ENCRYPTION,
  FLAG_UTF8,
  HOST_UNIX,
  LOCAL_HEADER_SIZE,
  MAX_COMMENT,
  METHOD_DEFLATE,
  METHOD_STORED,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  SIG_CENTRAL,
  SIG_DATA_DESCRIPTOR,
  SIG_EOCD,
  SIG_LOCAL,
  SIG_ZIP64_EOCD,
  SIG_ZIP64_LOCATOR,
  U16_MAX,
  U32_MAX,
  ZIP64_EOCD_MIN_SIZE,
  ZIP64_LOCATOR_SIZE,
} from './constants.js';
import { assertSafeEntryName, decodeEntryName, displayName, type NameEncoding } from './names.js';

/** A validated entry from the central directory. */
export interface ZipEntry {
  /** Position in the central directory. */
  readonly index: number;
  /** Decoded entry name (ZIP path, '/' separated). */
  readonly name: string;
  /** Raw name bytes exactly as stored, used when rewriting the archive. */
  readonly rawName: Uint8Array;
  readonly nameEncoding: NameEncoding;
  readonly isDirectory: boolean;
  readonly method: typeof METHOD_STORED | typeof METHOD_DEFLATE;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  /** Offset of the first byte of compressed data (after the local header). */
  readonly dataOffset: number;
  /** Offset just past the compressed data and optional data descriptor. */
  readonly endOffset: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly internalAttributes: number;
  readonly externalAttributes: number;
  readonly zip64: boolean;
}

/** Non-fatal observations made while opening an archive. */
export interface ZipWarning {
  code: 'zip-name-encoding' | 'zip-case-collision' | 'zip-unaccounted-bytes' | 'zip-archive-comment';
  message: string;
  entry?: string;
}

/** An opened, validated archive. Entry data is read lazily. */
export interface ZipArchive {
  readonly source: ByteSource;
  readonly entries: readonly ZipEntry[];
  readonly byName: ReadonlyMap<string, ZipEntry>;
  readonly zip64: boolean;
  readonly comment: string;
  readonly warnings: readonly ZipWarning[];
  /** Offset where the central directory starts (end of entry data). */
  readonly centralDirectoryOffset: number;
}

/** Returns true when the first bytes look like a ZIP local header or empty archive. */
export function hasZipSignature(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const sig = readU32(head, 0);
  return sig === SIG_LOCAL || sig === SIG_EOCD;
}

/**
 * Opens and validates a ZIP archive without decompressing entries. Parses the
 * end of central directory (with ZIP64 support), every central header and
 * every local header, cross-checking both, and rejects unsafe names,
 * encryption, unsupported methods, symlinks, overlapping entries and sizes
 * beyond the configured limits.
 */
export async function openZip(source: ByteSource, limits: Limits, signal?: CancelSignal): Promise<ZipArchive> {
  if (source.size > limits.maxArchiveBytes) {
    throw new ElpxError('zip-limit', `Archive is larger than the limit (${source.size} > ${limits.maxArchiveBytes} bytes)`);
  }
  if (source.size < EOCD_MIN_SIZE) throw new ElpxError('not-a-zip', 'File is too small to be a ZIP archive');
  const head = await source.read(0, 4);
  if (!hasZipSignature(head)) throw new ElpxError('not-a-zip', 'File does not start with a ZIP signature');

  const eocd = await findEndOfCentralDirectory(source);
  const warnings: ZipWarning[] = [];
  if (eocd.comment.length > 0) {
    warnings.push({ code: 'zip-archive-comment', message: 'Archive has a comment; it is not preserved' });
  }
  const dir = await resolveDirectory(source, eocd);
  if (dir.totalEntries > limits.maxEntries) {
    throw new ElpxError('zip-limit', `Too many entries (${dir.totalEntries} > ${limits.maxEntries})`);
  }
  if (dir.cdSize > source.size || dir.cdSize < dir.totalEntries * CENTRAL_HEADER_SIZE) {
    throw new ElpxError('zip-structure', 'Central directory size is inconsistent with the entry count');
  }
  const cd = await source.read(dir.cdOffset, dir.cdSize);
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  const nfcNames = new Map<string, string>();
  const lowerNames = new Map<string, string>();
  let pos = 0;
  let totalDeclared = 0;
  for (let index = 0; index < dir.totalEntries; index++) {
    throwIfCancelled(signal);
    const header = parseCentralHeader(cd, pos, index, limits);
    pos = header.next;
    if (byName.has(header.name)) {
      throw new ElpxError('zip-security', `Duplicate entry "${displayName(header.name)}"`, { entry: header.name });
    }
    const nfc = header.name.normalize('NFC');
    const previousNfc = nfcNames.get(nfc);
    if (previousNfc !== undefined) {
      throw new ElpxError('zip-security', `Entries "${displayName(previousNfc)}" and "${displayName(header.name)}" collide after Unicode normalization`, {
        entry: header.name,
      });
    }
    nfcNames.set(nfc, header.name);
    const lower = nfc.toLowerCase();
    const previousLower = lowerNames.get(lower);
    if (previousLower !== undefined) {
      warnings.push({
        code: 'zip-case-collision',
        message: `Entries "${displayName(previousLower)}" and "${displayName(header.name)}" differ only in letter case`,
        entry: header.name,
      });
    } else {
      lowerNames.set(lower, header.name);
    }
    if (header.nameEncoding === 'utf8-guess' || header.nameEncoding === 'cp437') {
      warnings.push({
        code: 'zip-name-encoding',
        message: `Entry name without UTF-8 flag decoded as ${header.nameEncoding === 'cp437' ? 'CP437' : 'UTF-8'}`,
        entry: header.name,
      });
    }
    totalDeclared += header.uncompressedSize;
    if (totalDeclared > limits.maxTotalUncompressedBytes) {
      throw new ElpxError('zip-limit', `Declared uncompressed size exceeds the limit (${limits.maxTotalUncompressedBytes} bytes)`);
    }
    const entry = await validateLocalHeader(source, header, dir.cdOffset);
    entries.push(entry);
    byName.set(entry.name, entry);
  }
  if (pos !== dir.cdSize) {
    throw new ElpxError('zip-structure', 'Central directory contains trailing or missing bytes');
  }
  checkFileDirectoryConflicts(entries);
  checkOverlaps(entries, dir.cdOffset, warnings);
  return {
    source,
    entries,
    byName,
    zip64: dir.zip64,
    comment: eocd.comment,
    warnings,
    centralDirectoryOffset: dir.cdOffset,
  };
}

interface EocdInfo {
  offset: number;
  diskNumber: number;
  cdDisk: number;
  entriesOnDisk: number;
  totalEntries: number;
  cdSize: number;
  cdOffset: number;
  comment: string;
}

/** Locates the EOCD record; it must end exactly at the end of the file. */
async function findEndOfCentralDirectory(source: ByteSource): Promise<EocdInfo> {
  const tailLength = Math.min(source.size, EOCD_MIN_SIZE + MAX_COMMENT);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  let sawSignature = false;
  for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (readU32(tail, i) !== SIG_EOCD) continue;
    sawSignature = true;
    const commentLength = readU16(tail, i + 20);
    if (i + EOCD_MIN_SIZE + commentLength !== tail.length) continue;
    return {
      offset: tailStart + i,
      diskNumber: readU16(tail, i + 4),
      cdDisk: readU16(tail, i + 6),
      entriesOnDisk: readU16(tail, i + 8),
      totalEntries: readU16(tail, i + 10),
      cdSize: readU32(tail, i + 12),
      cdOffset: readU32(tail, i + 16),
      comment: utf8DecodeLenient(tail.subarray(i + EOCD_MIN_SIZE, i + EOCD_MIN_SIZE + commentLength)),
    };
  }
  throw new ElpxError(
    'zip-structure',
    sawSignature
      ? 'End of central directory does not match the file end (trailing data or corruption)'
      : 'End of central directory not found (truncated or not a ZIP archive)',
  );
}

interface DirectoryInfo {
  totalEntries: number;
  cdSize: number;
  cdOffset: number;
  zip64: boolean;
}

/** Resolves central directory location, following ZIP64 records when present. */
async function resolveDirectory(source: ByteSource, eocd: EocdInfo): Promise<DirectoryInfo> {
  const needsZip64 = eocd.totalEntries === U16_MAX || eocd.entriesOnDisk === U16_MAX || eocd.cdSize === U32_MAX || eocd.cdOffset === U32_MAX;
  let locator: Uint8Array | undefined;
  if (eocd.offset >= ZIP64_LOCATOR_SIZE) {
    const candidate = await source.read(eocd.offset - ZIP64_LOCATOR_SIZE, ZIP64_LOCATOR_SIZE);
    if (readU32(candidate, 0) === SIG_ZIP64_LOCATOR) locator = candidate;
  }
  if (!locator) {
    if (needsZip64) throw new ElpxError('zip-structure', 'ZIP64 locator missing');
    if (eocd.diskNumber !== 0 || eocd.cdDisk !== 0 || eocd.entriesOnDisk !== eocd.totalEntries) {
      throw new ElpxError('zip-unsupported', 'Multi-volume (split) archives are not supported');
    }
    if (eocd.cdOffset + eocd.cdSize !== eocd.offset) {
      throw new ElpxError('zip-structure', 'Central directory position is inconsistent (prefixed or corrupt archive)');
    }
    return { totalEntries: eocd.totalEntries, cdSize: eocd.cdSize, cdOffset: eocd.cdOffset, zip64: false };
  }
  const zip64Disk = readU32(locator, 4);
  const zip64Offset = readU64(locator, 8);
  const totalDisks = readU32(locator, 16);
  if (zip64Disk !== 0 || totalDisks > 1) {
    throw new ElpxError('zip-unsupported', 'Multi-volume (split) archives are not supported');
  }
  if (zip64Offset + ZIP64_EOCD_MIN_SIZE > eocd.offset - ZIP64_LOCATOR_SIZE) {
    throw new ElpxError('zip-structure', 'ZIP64 end of central directory offset is invalid');
  }
  const rec = await source.read(zip64Offset, ZIP64_EOCD_MIN_SIZE);
  if (readU32(rec, 0) !== SIG_ZIP64_EOCD) throw new ElpxError('zip-structure', 'ZIP64 end of central directory not found');
  const recordSize = readU64(rec, 4);
  if (zip64Offset + 12 + recordSize !== eocd.offset - ZIP64_LOCATOR_SIZE) {
    throw new ElpxError('zip-structure', 'ZIP64 end of central directory has an unexpected size');
  }
  const diskNumber = readU32(rec, 16);
  const cdDisk = readU32(rec, 20);
  const entriesOnDisk = readU64(rec, 24);
  const totalEntries = readU64(rec, 32);
  const cdSize = readU64(rec, 40);
  const cdOffset = readU64(rec, 48);
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ElpxError('zip-unsupported', 'Multi-volume (split) archives are not supported');
  }
  if (cdOffset + cdSize !== zip64Offset) {
    throw new ElpxError('zip-structure', 'Central directory position is inconsistent (prefixed or corrupt archive)');
  }
  const consistent = (value16or32: number, sentinel: number, value64: number): boolean => value16or32 === sentinel || value16or32 === value64;
  if (!consistent(eocd.totalEntries, U16_MAX, totalEntries) || !consistent(eocd.cdSize, U32_MAX, cdSize) || !consistent(eocd.cdOffset, U32_MAX, cdOffset)) {
    throw new ElpxError('zip-structure', 'ZIP64 and classic end of central directory records disagree');
  }
  return { totalEntries, cdSize, cdOffset, zip64: true };
}

interface CentralHeader {
  index: number;
  next: number;
  name: string;
  rawName: Uint8Array;
  nameEncoding: NameEncoding;
  isDirectory: boolean;
  method: typeof METHOD_STORED | typeof METHOD_DEFLATE;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
  versionMadeBy: number;
  versionNeeded: number;
  internalAttributes: number;
  externalAttributes: number;
  zip64: boolean;
}

/** Parses and validates one central directory header. */
function parseCentralHeader(cd: Uint8Array, pos: number, index: number, limits: Limits): CentralHeader {
  if (pos + CENTRAL_HEADER_SIZE > cd.length || readU32(cd, pos) !== SIG_CENTRAL) {
    throw new ElpxError('zip-structure', `Central directory header ${index} is missing or truncated`);
  }
  const versionMadeBy = readU16(cd, pos + 4);
  const versionNeeded = readU16(cd, pos + 6);
  const flags = readU16(cd, pos + 8);
  const method = readU16(cd, pos + 10);
  const dosTime = readU16(cd, pos + 12);
  const dosDate = readU16(cd, pos + 14);
  const crc = readU32(cd, pos + 16);
  let compressedSize = readU32(cd, pos + 20);
  let uncompressedSize = readU32(cd, pos + 24);
  const nameLength = readU16(cd, pos + 28);
  const extraLength = readU16(cd, pos + 30);
  const commentLength = readU16(cd, pos + 32);
  const diskStart = readU16(cd, pos + 34);
  const internalAttributes = readU16(cd, pos + 36);
  const externalAttributes = readU32(cd, pos + 38);
  let localHeaderOffset = readU32(cd, pos + 42);
  const next = pos + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  if (next > cd.length) throw new ElpxError('zip-structure', `Central directory header ${index} is truncated`);
  if (nameLength > limits.maxNameBytes) {
    throw new ElpxError('zip-limit', `Entry name ${index} is longer than ${limits.maxNameBytes} bytes`);
  }
  const rawName = cd.slice(pos + CENTRAL_HEADER_SIZE, pos + CENTRAL_HEADER_SIZE + nameLength);
  const { name, encoding } = decodeEntryName(rawName, (flags & FLAG_UTF8) !== 0);
  assertSafeEntryName(name, limits.maxPathDepth);
  const shown = displayName(name);
  if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) {
    throw new ElpxError('zip-unsupported', `Entry "${shown}" is encrypted`, { entry: name });
  }
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    throw new ElpxError('zip-unsupported', `Entry "${shown}" uses unsupported compression method ${method}`, {
      entry: name,
      method,
    });
  }
  const host = versionMadeBy >> 8;
  const unixMode = externalAttributes >>> 16;
  if (host === HOST_UNIX && (unixMode & S_IFMT) === S_IFLNK) {
    throw new ElpxError('zip-security', `Entry "${shown}" is a symbolic link`, { entry: name });
  }
  const isDirectory = name.endsWith('/') || (host === HOST_UNIX && (unixMode & S_IFMT) === S_IFDIR);
  if (isDirectory && !name.endsWith('/')) {
    throw new ElpxError('zip-structure', `Directory entry "${shown}" does not end with "/"`, { entry: name });
  }
  let zip64 = false;
  let diskStart64 = diskStart;
  const extra = cd.subarray(pos + CENTRAL_HEADER_SIZE + nameLength, pos + CENTRAL_HEADER_SIZE + nameLength + extraLength);
  const z64 = findExtraField(extra, EXTRA_ZIP64);
  if (z64) {
    zip64 = true;
    let p = 0;
    const take = (): number => {
      if (p + 8 > z64.length) throw new ElpxError('zip-structure', `Entry "${shown}" has a truncated ZIP64 field`);
      const v = readU64(z64, p);
      p += 8;
      return v;
    };
    if (uncompressedSize === U32_MAX) uncompressedSize = take();
    if (compressedSize === U32_MAX) compressedSize = take();
    if (localHeaderOffset === U32_MAX) localHeaderOffset = take();
    if (diskStart === U16_MAX) {
      if (p + 4 > z64.length) throw new ElpxError('zip-structure', `Entry "${shown}" has a truncated ZIP64 field`);
      diskStart64 = readU32(z64, p);
    }
  } else if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
    throw new ElpxError('zip-structure', `Entry "${shown}" needs ZIP64 information that is missing`);
  }
  if (diskStart64 !== 0) throw new ElpxError('zip-unsupported', 'Multi-volume (split) archives are not supported');
  const directoryHasData = uncompressedSize !== 0 || (method === METHOD_STORED && compressedSize !== 0);
  if (isDirectory && directoryHasData) {
    throw new ElpxError('zip-structure', `Directory entry "${shown}" has data`, { entry: name });
  }
  if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
    throw new ElpxError('zip-structure', `Stored entry "${shown}" has different compressed and uncompressed sizes`, {
      entry: name,
    });
  }
  if (uncompressedSize > limits.maxEntryUncompressedBytes) {
    throw new ElpxError('zip-limit', `Entry "${shown}" is larger than the limit (${limits.maxEntryUncompressedBytes} bytes)`, {
      entry: name,
    });
  }
  if (uncompressedSize > limits.ratioThresholdBytes && uncompressedSize / Math.max(1, compressedSize) > limits.maxCompressionRatio) {
    throw new ElpxError('zip-limit', `Entry "${shown}" has a suspicious compression ratio (possible ZIP bomb)`, {
      entry: name,
    });
  }
  return {
    index,
    next,
    name,
    rawName,
    nameEncoding: encoding,
    isDirectory,
    method,
    flags,
    crc32: crc,
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
    dosTime,
    dosDate,
    versionMadeBy,
    versionNeeded,
    internalAttributes,
    externalAttributes,
    zip64,
  };
}

/** Reads the local header of an entry and checks it agrees with the central header. */
async function validateLocalHeader(source: ByteSource, h: CentralHeader, cdOffset: number): Promise<ZipEntry> {
  const shown = displayName(h.name);
  if (h.localHeaderOffset + LOCAL_HEADER_SIZE > cdOffset) {
    throw new ElpxError('zip-structure', `Local header of "${shown}" points outside the data area`, { entry: h.name });
  }
  const fixed = await source.read(h.localHeaderOffset, LOCAL_HEADER_SIZE);
  if (readU32(fixed, 0) !== SIG_LOCAL) {
    throw new ElpxError('zip-structure', `Local header of "${shown}" is missing`, { entry: h.name });
  }
  const flags = readU16(fixed, 6);
  const method = readU16(fixed, 8);
  const crc = readU32(fixed, 14);
  const compressedSize = readU32(fixed, 18);
  const uncompressedSize = readU32(fixed, 22);
  const nameLength = readU16(fixed, 26);
  const extraLength = readU16(fixed, 28);
  const dataOffset = h.localHeaderOffset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  if (dataOffset > cdOffset) {
    throw new ElpxError('zip-structure', `Local header of "${shown}" is truncated`, { entry: h.name });
  }
  const variable = await source.read(h.localHeaderOffset + LOCAL_HEADER_SIZE, nameLength + extraLength);
  if (!bytesEqual(variable.subarray(0, nameLength), h.rawName)) {
    throw new ElpxError('zip-security', `Local and central names differ for "${shown}"`, { entry: h.name });
  }
  if (method !== h.method) {
    throw new ElpxError('zip-security', `Local and central compression methods differ for "${shown}"`, { entry: h.name });
  }
  if ((flags & FLAG_ENCRYPTED) !== 0) {
    throw new ElpxError('zip-unsupported', `Entry "${shown}" is encrypted`, { entry: h.name });
  }
  const hasDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
  if (hasDescriptor !== ((h.flags & FLAG_DATA_DESCRIPTOR) !== 0)) {
    throw new ElpxError('zip-security', `Local and central flags differ for "${shown}"`, { entry: h.name });
  }
  if (!hasDescriptor) {
    let localCompressed = compressedSize;
    let localUncompressed = uncompressedSize;
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX) {
      const z64 = findExtraField(variable.subarray(nameLength), EXTRA_ZIP64);
      if (!z64 || z64.length < 16) {
        throw new ElpxError('zip-structure', `Local ZIP64 sizes missing for "${shown}"`, { entry: h.name });
      }
      localUncompressed = readU64(z64, 0);
      localCompressed = readU64(z64, 8);
    }
    if (crc !== h.crc32 || localCompressed !== h.compressedSize || localUncompressed !== h.uncompressedSize) {
      throw new ElpxError('zip-security', `Local and central sizes or CRC differ for "${shown}"`, { entry: h.name });
    }
  }
  let endOffset = dataOffset + h.compressedSize;
  if (endOffset > cdOffset) {
    throw new ElpxError('zip-structure', `Data of "${shown}" extends past the central directory`, { entry: h.name });
  }
  const localZip64 = findExtraField(variable.subarray(nameLength), EXTRA_ZIP64) !== undefined;
  if (hasDescriptor) endOffset = await validateDataDescriptor(source, h, endOffset, cdOffset, h.zip64 || localZip64);
  return {
    index: h.index,
    name: h.name,
    rawName: h.rawName,
    nameEncoding: h.nameEncoding,
    isDirectory: h.isDirectory,
    method: h.method,
    flags: h.flags,
    crc32: h.crc32,
    compressedSize: h.compressedSize,
    uncompressedSize: h.uncompressedSize,
    localHeaderOffset: h.localHeaderOffset,
    dataOffset,
    endOffset,
    dosTime: h.dosTime,
    dosDate: h.dosDate,
    versionMadeBy: h.versionMadeBy,
    versionNeeded: h.versionNeeded,
    internalAttributes: h.internalAttributes,
    externalAttributes: h.externalAttributes,
    zip64: h.zip64,
  };
}

/** Checks the optional data descriptor after an entry and returns the new end offset. */
async function validateDataDescriptor(source: ByteSource, h: CentralHeader, start: number, cdOffset: number, zip64: boolean): Promise<number> {
  const shown = displayName(h.name);
  const available = Math.min(24, cdOffset - start);
  if (available < 12) throw new ElpxError('zip-structure', `Data descriptor of "${shown}" is truncated`, { entry: h.name });
  const d = await source.read(start, available);
  let p = readU32(d, 0) === SIG_DATA_DESCRIPTOR ? 4 : 0;
  const crc = readU32(d, p);
  p += 4;
  const wide = zip64 && p + 16 <= d.length;
  const compressed = wide ? readU64(d, p) : readU32(d, p);
  const uncompressed = wide ? readU64(d, p + 8) : readU32(d, p + 4);
  p += wide ? 16 : 8;
  if (crc !== h.crc32 || compressed !== h.compressedSize || uncompressed !== h.uncompressedSize) {
    throw new ElpxError('zip-security', `Data descriptor disagrees with central directory for "${shown}"`, {
      entry: h.name,
    });
  }
  return start + p;
}

/** Rejects archives where a path is both a file and a directory prefix of another entry. */
function checkFileDirectoryConflicts(entries: readonly ZipEntry[]): void {
  const files = new Set<string>();
  for (const e of entries) if (!e.isDirectory) files.add(e.name);
  for (const e of entries) {
    const parts = e.name.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      if (files.has(prefix)) {
        throw new ElpxError('zip-security', `"${displayName(prefix)}" is both a file and a directory`, {
          entry: prefix,
        });
      }
    }
  }
}

/** Rejects overlapping entry data (a ZIP bomb technique) and notes unaccounted gaps. */
function checkOverlaps(entries: readonly ZipEntry[], cdOffset: number, warnings: ZipWarning[]): void {
  const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  let cursor = 0;
  let gap = 0;
  for (const e of sorted) {
    if (e.localHeaderOffset < cursor) {
      throw new ElpxError('zip-security', `Entry "${displayName(e.name)}" overlaps another entry`, { entry: e.name });
    }
    gap += e.localHeaderOffset - cursor;
    cursor = e.endOffset;
  }
  gap += cdOffset - cursor;
  if (gap > 0) {
    warnings.push({
      code: 'zip-unaccounted-bytes',
      message: `${gap} bytes between entries are not referenced by the central directory; they are not preserved`,
    });
  }
}

/** Returns the payload of an extra field with the given header id. */
export function findExtraField(extra: Uint8Array, id: number): Uint8Array | undefined {
  let p = 0;
  while (p + 4 <= extra.length) {
    const headerId = readU16(extra, p);
    const size = readU16(extra, p + 2);
    const end = p + 4 + size;
    if (end > extra.length) return undefined;
    if (headerId === id) return extra.subarray(p + 4, end);
    p = end;
  }
  return undefined;
}

/** Options for reading entry data. */
export interface ReadEntryOptions {
  signal?: CancelSignal;
  /** Chunk size used when reading compressed bytes from the source. */
  chunkSize?: number;
}

/** Largest compressed slice fed to the inflater at once, bounding output bursts. */
const INFLATE_SLICE = 16 * 1024;

/**
 * Streams the uncompressed bytes of an entry. The number of produced bytes is
 * bounded by the declared uncompressed size (an overrun aborts immediately)
 * and the CRC-32 is verified at the end.
 */
export async function* readEntry(archive: ZipArchive, entry: ZipEntry, options: ReadEntryOptions = {}): AsyncGenerator<Uint8Array> {
  const shown = displayName(entry.name);
  const crc = new Crc32();
  let produced = 0;
  const account = (chunk: Uint8Array): void => {
    produced += chunk.length;
    if (produced > entry.uncompressedSize) {
      throw new ElpxError('zip-integrity', `Entry "${shown}" inflates beyond its declared size (possible ZIP bomb)`, {
        entry: entry.name,
      });
    }
    crc.update(chunk);
  };
  const range = streamRange(archive.source, entry.dataOffset, entry.dataOffset + entry.compressedSize, options);
  if (entry.method === METHOD_STORED) {
    for await (const chunk of range) {
      account(chunk);
      yield chunk;
    }
  } else {
    const pending: Uint8Array[] = [];
    let ended = false;
    const inflater = new Inflate((data: Uint8Array, final: boolean) => {
      if (data.length > 0) {
        account(data);
        pending.push(data);
      }
      if (final) ended = true;
    });
    let consumed = 0;
    for await (const chunk of range) {
      for (let i = 0; i < chunk.length; i += INFLATE_SLICE) {
        const slice = chunk.subarray(i, Math.min(chunk.length, i + INFLATE_SLICE));
        consumed += slice.length;
        try {
          inflater.push(slice, consumed === entry.compressedSize);
        } catch (error) {
          if (error instanceof ElpxError) throw error;
          throw new ElpxError('zip-integrity', `Entry "${shown}" has corrupt compressed data`, { entry: entry.name });
        }
        while (pending.length > 0) yield pending.shift()!;
      }
    }
    if (entry.compressedSize === 0) {
      throw new ElpxError('zip-integrity', `Entry "${shown}" has empty deflate data`, { entry: entry.name });
    }
    if (!ended) throw new ElpxError('zip-integrity', `Entry "${shown}" has truncated compressed data`, { entry: entry.name });
  }
  if (produced !== entry.uncompressedSize) {
    throw new ElpxError('zip-integrity', `Entry "${shown}" is shorter than its declared size`, { entry: entry.name });
  }
  if (crc.digest() !== entry.crc32) {
    throw new ElpxError('zip-integrity', `CRC mismatch in entry "${shown}"`, { entry: entry.name });
  }
}

/** Reads a complete entry into memory, refusing entries larger than maxBytes. */
export async function readEntryBytes(archive: ZipArchive, entry: ZipEntry, maxBytes: number, options: ReadEntryOptions = {}): Promise<Uint8Array> {
  if (entry.uncompressedSize > maxBytes) {
    throw new ElpxError('limit-exceeded', `Entry "${displayName(entry.name)}" is larger than ${maxBytes} bytes`, {
      entry: entry.name,
    });
  }
  return collectBytes(readEntry(archive, entry, options), maxBytes, `Entry "${displayName(entry.name)}"`);
}

/** Reads a little-endian unsigned 16-bit integer. */
export function readU16(b: Uint8Array, p: number): number {
  return b[p]! | (b[p + 1]! << 8);
}

/** Reads a little-endian unsigned 32-bit integer. */
export function readU32(b: Uint8Array, p: number): number {
  return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
}

/** Reads a little-endian unsigned 64-bit integer; rejects values above 2^53. */
export function readU64(b: Uint8Array, p: number): number {
  const low = readU32(b, p);
  const high = readU32(b, p + 4);
  if (high > 0x1fffff) throw new ElpxError('zip-unsupported', '64-bit value exceeds the supported range');
  return high * 0x100000000 + low;
}
