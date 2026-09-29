import { Deflate } from 'fflate';
import { ElpxError } from '../errors.js';
import { throwIfCancelled, type CancelSignal } from '../cancel.js';
import { Crc32 } from '../io/crc32.js';
import { streamRange, type ByteSource } from '../io/byte-source.js';
import type { ByteSink } from '../io/byte-sink.js';
import {
  CENTRAL_HEADER_SIZE,
  EXTRA_ZIP64,
  FLAG_DATA_DESCRIPTOR,
  FLAG_UTF8,
  LOCAL_HEADER_SIZE,
  METHOD_DEFLATE,
  METHOD_STORED,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_LOCAL,
  SIG_ZIP64_EOCD,
  SIG_ZIP64_LOCATOR,
  U16_MAX,
  U32_MAX,
} from './constants.js';
import type { ZipArchive, ZipEntry } from './reader.js';

/** Metadata preserved from the original entry when writing a new one. */
export interface EntryMeta {
  rawName: Uint8Array;
  /** Only the UTF-8 bit is carried over; other flags are recomputed. */
  utf8: boolean;
  dosTime: number;
  dosDate: number;
  versionMadeBy: number;
  internalAttributes: number;
  externalAttributes: number;
}

/** Extracts writer metadata from an existing entry. */
export function metaFromEntry(entry: ZipEntry): EntryMeta {
  return {
    rawName: entry.rawName,
    utf8: (entry.flags & FLAG_UTF8) !== 0,
    dosTime: entry.dosTime,
    dosDate: entry.dosDate,
    versionMadeBy: entry.versionMadeBy,
    internalAttributes: entry.internalAttributes,
    externalAttributes: entry.externalAttributes,
  };
}

interface CentralRecord {
  meta: EntryMeta;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

/** Options for the ZIP writer. */
export interface ZipWriterOptions {
  /** Write ZIP64 structures even when not required (used by tests). */
  forceZip64?: boolean;
  signal?: CancelSignal;
}

/**
 * Streaming ZIP writer. Unchanged entries are copied with their compressed
 * bytes untouched (so their uncompressed content is preserved exactly); new
 * content is written with sizes and CRC known up front, so no data
 * descriptors are emitted. ZIP64 records are written only when needed.
 */
export class ZipWriter {
  private readonly records: CentralRecord[] = [];
  private finished = false;

  constructor(
    private readonly sink: ByteSink,
    private readonly options: ZipWriterOptions = {},
  ) {}

  /** Copies an entry from an opened archive without recompressing it. */
  async copyEntry(archive: ZipArchive, entry: ZipEntry): Promise<void> {
    this.assertOpen();
    const offset = this.sink.bytesWritten;
    const flags = entry.flags & ~FLAG_DATA_DESCRIPTOR;
    const meta = metaFromEntry(entry);
    await this.sink.write(this.localHeader(meta, entry.method, flags, entry.crc32, entry.compressedSize, entry.uncompressedSize));
    const end = entry.dataOffset + entry.compressedSize;
    if (this.sink.writeRange) {
      await this.sink.writeRange(archive.source, entry.dataOffset, end, this.options.signal);
    } else {
      for await (const chunk of streamRange(archive.source, entry.dataOffset, end, { signal: this.options.signal })) {
        await this.sink.write(chunk);
      }
    }
    this.records.push({
      meta,
      method: entry.method,
      flags,
      crc: entry.crc32,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      offset,
    });
  }

  /** Adds an in-memory entry, deflating it (method 8) or storing it (method 0). */
  async addBytes(meta: EntryMeta, data: Uint8Array, method: 0 | 8, level = 6): Promise<void> {
    this.assertOpen();
    throwIfCancelled(this.options.signal);
    const crc = new Crc32().update(data).digest();
    const payload = method === METHOD_DEFLATE ? deflateAll(data, level) : data;
    const flags = meta.utf8 ? FLAG_UTF8 : 0;
    const offset = this.sink.bytesWritten;
    await this.sink.write(this.localHeader(meta, method, flags, crc, payload.length, data.length));
    await this.sink.write(payload);
    this.records.push({
      meta,
      method,
      flags,
      crc,
      compressedSize: payload.length,
      uncompressedSize: data.length,
      offset,
    });
  }

  /**
   * Adds a stored entry whose content comes from a ByteSource (e.g. an
   * encoded video on disk or in a Blob). The source is read twice: once for
   * the CRC and once for the data, so it is never held in memory.
   */
  async addStoredSource(meta: EntryMeta, source: ByteSource): Promise<void> {
    this.assertOpen();
    const crc = new Crc32();
    for await (const chunk of streamRange(source, 0, source.size, { signal: this.options.signal })) crc.update(chunk);
    const digest = crc.digest();
    const flags = meta.utf8 ? FLAG_UTF8 : 0;
    const offset = this.sink.bytesWritten;
    await this.sink.write(this.localHeader(meta, METHOD_STORED, flags, digest, source.size, source.size));
    if (this.sink.writeRange) {
      await this.sink.writeRange(source, 0, source.size, this.options.signal);
    } else {
      for await (const chunk of streamRange(source, 0, source.size, { signal: this.options.signal })) {
        await this.sink.write(chunk);
      }
    }
    this.records.push({
      meta,
      method: METHOD_STORED,
      flags,
      crc: digest,
      compressedSize: source.size,
      uncompressedSize: source.size,
      offset,
    });
  }

  /** Writes the central directory and end records. Returns the archive size. */
  async finish(): Promise<number> {
    this.assertOpen();
    this.finished = true;
    const force = this.options.forceZip64 === true;
    const cdOffset = this.sink.bytesWritten;
    let cdSize = 0;
    for (const r of this.records) {
      throwIfCancelled(this.options.signal);
      const header = this.centralHeader(r, force);
      cdSize += header.length;
      await this.sink.write(header);
    }
    const count = this.records.length;
    const needZip64 = force || count >= U16_MAX || cdOffset >= U32_MAX || cdSize >= U32_MAX;
    if (needZip64) {
      const zip64EocdOffset = this.sink.bytesWritten;
      const rec = new Uint8Array(56);
      const v = new DataView(rec.buffer);
      v.setUint32(0, SIG_ZIP64_EOCD, true);
      setU64(v, 4, 44);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      setU64(v, 24, count);
      setU64(v, 32, count);
      setU64(v, 40, cdSize);
      setU64(v, 48, cdOffset);
      await this.sink.write(rec);
      const loc = new Uint8Array(20);
      const lv = new DataView(loc.buffer);
      lv.setUint32(0, SIG_ZIP64_LOCATOR, true);
      lv.setUint32(4, 0, true);
      setU64(lv, 8, zip64EocdOffset);
      lv.setUint32(16, 1, true);
      await this.sink.write(loc);
    }
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(8, needZip64 ? U16_MAX : count, true);
    ev.setUint16(10, needZip64 ? U16_MAX : count, true);
    ev.setUint32(12, needZip64 ? U32_MAX : cdSize, true);
    ev.setUint32(16, needZip64 ? U32_MAX : cdOffset, true);
    await this.sink.write(eocd);
    return this.sink.bytesWritten;
  }

  /** Number of entries written so far. */
  get entryCount(): number {
    return this.records.length;
  }

  private assertOpen(): void {
    if (this.finished) throw new ElpxError('internal', 'ZIP writer already finished');
  }

  /** Builds a local file header, with a ZIP64 extra field when sizes require it. */
  private localHeader(meta: EntryMeta, method: number, flags: number, crc: number, compressedSize: number, uncompressedSize: number): Uint8Array {
    const zip64 = this.options.forceZip64 === true || compressedSize >= U32_MAX || uncompressedSize >= U32_MAX;
    const extraLength = zip64 ? 20 : 0;
    const out = new Uint8Array(LOCAL_HEADER_SIZE + meta.rawName.length + extraLength);
    const v = new DataView(out.buffer);
    v.setUint32(0, SIG_LOCAL, true);
    v.setUint16(4, versionNeeded(method, zip64), true);
    v.setUint16(6, flags, true);
    v.setUint16(8, method, true);
    v.setUint16(10, meta.dosTime, true);
    v.setUint16(12, meta.dosDate, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, zip64 ? U32_MAX : compressedSize, true);
    v.setUint32(22, zip64 ? U32_MAX : uncompressedSize, true);
    v.setUint16(26, meta.rawName.length, true);
    v.setUint16(28, extraLength, true);
    out.set(meta.rawName, LOCAL_HEADER_SIZE);
    if (zip64) {
      const p = LOCAL_HEADER_SIZE + meta.rawName.length;
      v.setUint16(p, EXTRA_ZIP64, true);
      v.setUint16(p + 2, 16, true);
      setU64(v, p + 4, uncompressedSize);
      setU64(v, p + 12, compressedSize);
    }
    return out;
  }

  /** Builds a central directory header for a written entry. */
  private centralHeader(r: CentralRecord, force: boolean): Uint8Array {
    const bigU = force || r.uncompressedSize >= U32_MAX;
    const bigC = force || r.compressedSize >= U32_MAX;
    const bigO = force || r.offset >= U32_MAX;
    const zip64Fields = (bigU ? 1 : 0) + (bigC ? 1 : 0) + (bigO ? 1 : 0);
    const extraLength = zip64Fields > 0 ? 4 + 8 * zip64Fields : 0;
    const zip64 = zip64Fields > 0;
    const name = r.meta.rawName;
    const out = new Uint8Array(CENTRAL_HEADER_SIZE + name.length + extraLength);
    const v = new DataView(out.buffer);
    v.setUint32(0, SIG_CENTRAL, true);
    const madeBy = zip64 ? (r.meta.versionMadeBy & 0xff00) | Math.max(45, r.meta.versionMadeBy & 0xff) : r.meta.versionMadeBy;
    v.setUint16(4, madeBy, true);
    v.setUint16(6, versionNeeded(r.method, zip64), true);
    v.setUint16(8, r.flags, true);
    v.setUint16(10, r.method, true);
    v.setUint16(12, r.meta.dosTime, true);
    v.setUint16(14, r.meta.dosDate, true);
    v.setUint32(16, r.crc, true);
    v.setUint32(20, bigC ? U32_MAX : r.compressedSize, true);
    v.setUint32(24, bigU ? U32_MAX : r.uncompressedSize, true);
    v.setUint16(28, name.length, true);
    v.setUint16(30, extraLength, true);
    v.setUint16(32, 0, true);
    v.setUint16(34, 0, true);
    v.setUint16(36, r.meta.internalAttributes, true);
    v.setUint32(38, r.meta.externalAttributes, true);
    v.setUint32(42, bigO ? U32_MAX : r.offset, true);
    out.set(name, CENTRAL_HEADER_SIZE);
    if (zip64) {
      let p = CENTRAL_HEADER_SIZE + name.length;
      v.setUint16(p, EXTRA_ZIP64, true);
      v.setUint16(p + 2, 8 * zip64Fields, true);
      p += 4;
      if (bigU) {
        setU64(v, p, r.uncompressedSize);
        p += 8;
      }
      if (bigC) {
        setU64(v, p, r.compressedSize);
        p += 8;
      }
      if (bigO) setU64(v, p, r.offset);
    }
    return out;
  }
}

/** Minimum "version needed to extract" for the given features. */
function versionNeeded(method: number, zip64: boolean): number {
  if (zip64) return 45;
  return method === METHOD_DEFLATE ? 20 : 10;
}

/** Writes a little-endian 64-bit value (safe integers only). */
function setU64(v: DataView, p: number, value: number): void {
  v.setUint32(p, value % 0x100000000, true);
  v.setUint32(p + 4, Math.floor(value / 0x100000000), true);
}

/** Deflates a buffer completely using raw DEFLATE (as ZIP requires). */
export function deflateAll(data: Uint8Array, level: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const deflater = new Deflate({ level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }, (chunk: Uint8Array) => {
    parts.push(chunk);
  });
  deflater.push(data, true);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
