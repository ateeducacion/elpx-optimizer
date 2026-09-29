/** CRC-32 (IEEE 802.3, as used by ZIP) with incremental updates. */

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC-32 accumulator. */
export class Crc32 {
  private state = 0xffffffff;

  /** Feeds more bytes into the checksum. */
  update(data: Uint8Array): this {
    let c = this.state;
    for (let i = 0; i < data.length; i++) {
      c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
    }
    this.state = c;
    return this;
  }

  /** Returns the final unsigned 32-bit checksum. */
  digest(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

/** Computes the CRC-32 of a complete buffer. */
export function crc32(data: Uint8Array): number {
  return new Crc32().update(data).digest();
}
