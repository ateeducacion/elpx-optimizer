import { CancelledError, ElpxError, errorMessage } from '../../core/errors.js';
import { onCancel, throwIfCancelled } from '../../core/cancel.js';
import type { ImageVerification, JobContext } from '../../core/media/engine.js';
import type { ImageJob } from '../../core/media/image-policy.js';
import { verifyWithCodecs, type ImageCodecs } from './image-codecs.js';

/**
 * Pool of dedicated image workers, each with its own WASM codecs, so several
 * photos are decoded, resized and encoded in parallel instead of one after
 * another in the pipeline worker. Codec calls cannot be interrupted, so
 * cancelling or exceeding the time limit terminates the busy worker; workers
 * are (re)created when a job needs one.
 */

/** A job for an image worker. Its buffers are transferred (the pool sends copies). */
export type ImageRequest =
  | { readonly kind: 'encode'; readonly job: ImageJob; readonly original: Uint8Array }
  | { readonly kind: 'verify'; readonly job: ImageJob; readonly original: Uint8Array; readonly candidate: Uint8Array };

type EncodeResponse = { readonly ok: true; readonly kind: 'encode'; readonly encoded: Uint8Array };
type VerifyResponse = { readonly ok: true; readonly kind: 'verify'; readonly verification: ImageVerification };

/** The answer of an image worker. */
export type ImageResponse = EncodeResponse | VerifyResponse | { readonly ok: false; readonly message: string };

/** Minimal Worker interface (a real Worker, or a fake in tests). */
export interface ImageWorkerLike {
  postMessage(message: ImageRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: ImageResponse }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

/**
 * Workers for a device: one per spare core, at most 4, and 1 when the core
 * count is unknown. Each worker may hold a large decoded photo, so devices
 * that report little memory (navigator.deviceMemory) get fewer: 1 up to
 * 2 GiB, 2 up to 4 GiB.
 */
export function imageWorkerCount(hardwareConcurrency: number | undefined, deviceMemoryGiB?: number): number {
  if (!hardwareConcurrency || !Number.isFinite(hardwareConcurrency)) return 1;
  const byCores = Math.min(4, Math.max(1, Math.floor(hardwareConcurrency) - 1));
  if (deviceMemoryGiB === undefined || !Number.isFinite(deviceMemoryGiB)) return byCores;
  return Math.min(byCores, deviceMemoryGiB <= 2 ? 1 : deviceMemoryGiB <= 4 ? 2 : 4);
}

/** Maps a codec or worker failure, recognizing memory exhaustion. */
function imageError(message: string): ElpxError {
  if (/memory|allocation failed|OOM/i.test(message)) {
    return new ElpxError('media-failed', 'The browser ran out of memory for this image; the original is kept (the CLI can process larger files)');
  }
  return new ElpxError('media-failed', message);
}

interface Task {
  readonly message: ImageRequest;
  readonly transfer: Transferable[];
  readonly ctx: JobContext;
  readonly resolve: (response: EncodeResponse | VerifyResponse) => void;
  readonly reject: (error: Error) => void;
  /** Stops listening for cancellation. */
  readonly release: () => void;
}

interface Slot {
  readonly worker: ImageWorkerLike;
  task: Task | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class ImagePool {
  private readonly slots = new Set<Slot>();
  private readonly queue: Task[] = [];

  constructor(
    private readonly createWorker: () => ImageWorkerLike,
    readonly size: number,
  ) {}

  /** Encodes an image in a worker; the input is copied, the output transferred back. */
  async encode(job: ImageJob, original: Uint8Array, ctx: JobContext): Promise<Uint8Array> {
    const copy = original.slice();
    const response = (await this.run({ kind: 'encode', job, original: copy }, [copy.buffer], ctx)) as EncodeResponse;
    return response.encoded;
  }

  /** Decodes and compares original and candidate in a worker. */
  async verify(original: Uint8Array, candidate: Uint8Array, job: ImageJob, ctx: JobContext): Promise<ImageVerification> {
    const o = original.slice();
    const c = candidate.slice();
    const response = (await this.run({ kind: 'verify', job, original: o, candidate: c }, [o.buffer, c.buffer], ctx)) as VerifyResponse;
    return response.verification;
  }

  /** Number of started workers (for tests and diagnostics). */
  get workers(): number {
    return this.slots.size;
  }

  private run(message: ImageRequest, transfer: Transferable[], ctx: JobContext): Promise<EncodeResponse | VerifyResponse> {
    return new Promise((resolve, reject) => {
      throwIfCancelled(ctx.signal);
      // The signal is not aborted here, so the callback only runs later, once `task` exists.
      const task: Task = { message, transfer, ctx, resolve, reject, release: onCancel(ctx.signal, () => this.cancel(task)) };
      this.queue.push(task);
      this.pump();
    });
  }

  /** Starts queued tasks on idle workers, creating workers up to the pool size. */
  private pump(): void {
    while (this.queue.length > 0) {
      let slot = [...this.slots].find((s) => !s.task);
      if (!slot) {
        if (this.slots.size >= this.size) return;
        try {
          slot = this.spawn();
        } catch (error) {
          const task = this.queue.shift()!;
          task.release();
          task.reject(new ElpxError('media-failed', `The image worker could not be started: ${errorMessage(error)}`));
          continue;
        }
      }
      this.start(slot, this.queue.shift()!);
    }
  }

  private spawn(): Slot {
    const slot: Slot = { worker: this.createWorker(), task: undefined, timer: undefined };
    slot.worker.onmessage = (e) => this.onResponse(slot, e.data);
    slot.worker.onerror = (e) => this.fail(slot, imageError(`image worker failed: ${e.message ?? 'unknown error'}`));
    this.slots.add(slot);
    return slot;
  }

  private start(slot: Slot, task: Task): void {
    slot.task = task;
    // The time limit counts from the moment a worker takes the job, not while it waits.
    slot.timer = setTimeout(() => this.fail(slot, new ElpxError('media-failed', 'image processing exceeded the time limit')), task.ctx.timeoutMs);
    slot.worker.postMessage(task.message, task.transfer);
  }

  private onResponse(slot: Slot, response: ImageResponse): void {
    const task = slot.task!;
    clearTimeout(slot.timer);
    slot.task = undefined;
    task.release();
    if (response.ok) {
      task.resolve(response);
    } else {
      // A failed codec call may leave its WASM module unusable: use a fresh worker next time.
      this.discard(slot);
      task.reject(imageError(response.message));
    }
    this.pump();
  }

  /** Terminates a worker after a timeout or crash, failing its task. */
  private fail(slot: Slot, error: Error): void {
    const task = slot.task;
    this.discard(slot);
    if (task) {
      task.release();
      task.reject(error);
    }
    this.pump();
  }

  private cancel(task: Task): void {
    const queued = this.queue.indexOf(task);
    if (queued >= 0) this.queue.splice(queued, 1);
    for (const slot of this.slots) if (slot.task === task) this.discard(slot);
    task.release();
    task.reject(new CancelledError());
    this.pump();
  }

  private discard(slot: Slot): void {
    clearTimeout(slot.timer);
    slot.worker.terminate();
    this.slots.delete(slot);
  }

  /** Terminates every worker (releasing their memory); pending jobs are cancelled. */
  dispose(): void {
    const tasks = [...this.queue, ...[...this.slots].flatMap((s) => (s.task ? [s.task] : []))];
    this.queue.length = 0;
    for (const slot of [...this.slots]) this.discard(slot);
    for (const task of tasks) {
      task.release();
      task.reject(new CancelledError());
    }
  }
}

/** Runs one request with a worker's codecs (the worker side of the pool). */
export async function runImageRequest(codecs: ImageCodecs, request: ImageRequest): Promise<{ response: ImageResponse; transfer: Transferable[] }> {
  try {
    if (request.kind === 'encode') {
      const encoded = await codecs.encode(request.job, request.original);
      // Only a buffer the result owns entirely is transferred (never a view into codec memory).
      const own = encoded.byteOffset === 0 && encoded.byteLength === encoded.buffer.byteLength ? encoded : encoded.slice();
      return { response: { ok: true, kind: 'encode', encoded: own }, transfer: [own.buffer as ArrayBuffer] };
    }
    const verification = await verifyWithCodecs(codecs, request.original, request.candidate, request.job);
    return { response: { ok: true, kind: 'verify', verification }, transfer: [] };
  } catch (error) {
    return { response: { ok: false, message: errorMessage(error) }, transfer: [] };
  }
}
