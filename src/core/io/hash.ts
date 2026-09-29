import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Incremental SHA-256 hasher that yields lowercase hex digests. */
export class Sha256 {
  private readonly inner = sha256.create();

  /** Feeds more bytes into the hash. */
  update(data: Uint8Array): this {
    this.inner.update(data);
    return this;
  }

  /** Returns the lowercase hex digest; the hasher cannot be reused afterwards. */
  digestHex(): string {
    return bytesToHex(this.inner.digest());
  }
}

/** Hashes a complete buffer or string (UTF-8) and returns the hex digest. */
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoderShim().encode(data) : data;
  return new Sha256().update(bytes).digestHex();
}

/** Minimal UTF-8 encoder that works without DOM or Node typings. */
class TextEncoderShim {
  encode(text: string): Uint8Array {
    return utf8Encode(text);
  }
}

/** Encodes a string as UTF-8 using the runtime TextEncoder. */
export function utf8Encode(text: string): Uint8Array {
  const Encoder = (globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }).TextEncoder;
  return new Encoder().encode(text);
}
