/**
 * Error types shared by every interface (CLI, web, skill).
 * Each error carries a stable machine-readable code so callers can map it to
 * exit codes, UI messages and report entries without parsing text.
 */

export type ElpxErrorCode =
  | 'not-a-zip'
  | 'legacy-elp'
  | 'not-an-elpx'
  | 'zip-structure'
  | 'zip-security'
  | 'zip-unsupported'
  | 'zip-limit'
  | 'zip-integrity'
  | 'content-xml-invalid'
  | 'xml-security'
  | 'limit-exceeded'
  | 'plan-mismatch'
  | 'invalid-options'
  | 'media-engine-unavailable'
  | 'media-failed'
  | 'output-invalid'
  | 'output-exists'
  | 'io'
  | 'cancelled'
  | 'internal';

/** Base error with a stable code and optional structured details. */
export class ElpxError extends Error {
  readonly code: ElpxErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ElpxErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ElpxError';
    this.code = code;
    this.details = details;
  }
}

/** Raised when an operation is cancelled through a CancelSignal. */
export class CancelledError extends ElpxError {
  constructor(message = 'Operation cancelled') {
    super('cancelled', message);
    this.name = 'CancelledError';
  }
}

/** Returns true when the value is an ElpxError with the given code. */
export function isElpxError(value: unknown, code?: ElpxErrorCode): value is ElpxError {
  return value instanceof ElpxError && (code === undefined || value.code === code);
}

/** Normalizes any thrown value into a short, safe message (no stack traces). */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return 'Unknown error';
}
