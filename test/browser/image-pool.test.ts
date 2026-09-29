import { afterEach, describe, expect, it } from 'vitest';
import photoUrl from '../fixtures/media/photo-exif-icc.jpg?url';
import alphaPngUrl from '../fixtures/media/alpha-text.png?url';
import { createJsquashCodecs, type ImageCodecs } from '../../src/adapters/browser/image-codecs.js';
import {
  ImagePool,
  imageWorkerCount,
  runImageRequest,
  type ImageRequest,
  type ImageResponse,
  type ImageWorkerLike,
} from '../../src/adapters/browser/image-pool.js';
import { CancelledError } from '../../src/core/errors.js';
import type { ImageVerification } from '../../src/core/media/engine.js';
import type { ImageJob } from '../../src/core/media/image-policy.js';
import { delay, fixtureBytes, imageJobFor, waitFor } from './helpers.js';

const ctx = { resourcePath: 'content/resources/x.jpg', timeoutMs: 60_000 };

const JOB: ImageJob = {
  format: 'png',
  mode: 'lossless',
  quality: undefined,
  resize: undefined,
  metadata: { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true },
  expected: { width: 1, height: 1, hasAlpha: false },
  conversions: [],
};

const VERIFIED: ImageVerification = { ok: true, width: 1, height: 1, hasAlpha: false, problems: [] };

/** Scripted image worker: records requests and answers when the test says so. */
class FakeImageWorker implements ImageWorkerLike {
  readonly requests: { message: ImageRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  onmessage: ((e: { data: ImageResponse }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;

  postMessage(message: ImageRequest, transfer: Transferable[]): void {
    this.requests.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answers the last request. */
  answer(data: ImageResponse): void {
    this.onmessage!({ data });
  }
}

/** A pool over fake workers; returns every worker created. */
function fakePool(size: number): { pool: ImagePool; workers: FakeImageWorker[] } {
  const workers: FakeImageWorker[] = [];
  const pool = new ImagePool(() => {
    const w = new FakeImageWorker();
    workers.push(w);
    return w;
  }, size);
  return { pool, workers };
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  await delay(0);
}

describe('imageWorkerCount', () => {
  it('uses one worker per spare core, between 1 and 4', () => {
    expect(imageWorkerCount(undefined)).toBe(1);
    expect(imageWorkerCount(0)).toBe(1);
    expect(imageWorkerCount(Number.NaN)).toBe(1);
    expect(imageWorkerCount(Number.POSITIVE_INFINITY)).toBe(1);
    expect(imageWorkerCount(1)).toBe(1);
    expect(imageWorkerCount(2)).toBe(1);
    expect(imageWorkerCount(3.9)).toBe(2);
    expect(imageWorkerCount(4)).toBe(3);
    // Devices that report little memory get fewer workers.
    expect(imageWorkerCount(10, 1)).toBe(1);
    expect(imageWorkerCount(10, 2)).toBe(1);
    expect(imageWorkerCount(10, 4)).toBe(2);
    expect(imageWorkerCount(10, 8)).toBe(4);
    expect(imageWorkerCount(3, 8)).toBe(2);
    expect(imageWorkerCount(10, Number.NaN)).toBe(4);
    expect(imageWorkerCount(8)).toBe(4);
    expect(imageWorkerCount(64)).toBe(4);
  });
});

describe('ImagePool scheduling (fake workers)', () => {
  it('starts workers up to its size, queues the rest in order and reuses idle workers', async () => {
    const { pool, workers } = fakePool(2);
    expect(pool.size).toBe(2);
    expect(pool.workers).toBe(0);
    const inputs = [1, 2, 3].map((n) => new Uint8Array([n, n, n]));
    const results = inputs.map((input) => pool.encode(JOB, input, ctx));
    expect(workers).toHaveLength(2);
    expect(pool.workers).toBe(2);
    expect(workers.map((w) => w.requests.length)).toEqual([1, 1]);
    const first = workers[0]!.requests[0]!;
    expect(first.message).toEqual({ kind: 'encode', job: JOB, original: inputs[0] });
    // A copy is transferred: the caller keeps its bytes.
    expect(first.message.original).not.toBe(inputs[0]);
    expect(first.transfer).toEqual([first.message.original.buffer]);
    expect(inputs[0]!.byteLength).toBe(3);
    workers[1]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([20]) });
    expect(await results[1]).toEqual(new Uint8Array([20]));
    // The third job went to the worker that became idle.
    expect(workers[1]!.requests[1]!.message.original).toEqual(inputs[2]);
    expect(workers).toHaveLength(2);
    workers[0]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([10]) });
    workers[1]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([30]) });
    expect(await Promise.all(results)).toEqual([new Uint8Array([10]), new Uint8Array([20]), new Uint8Array([30])]);
    expect(workers.some((w) => w.terminated)).toBe(false);
  });

  it('verifies in a worker with copies of both images', async () => {
    const { pool, workers } = fakePool(1);
    const original = new Uint8Array([1, 2]);
    const candidate = new Uint8Array([3]);
    const result = pool.verify(original, candidate, JOB, ctx);
    const { message, transfer } = workers[0]!.requests[0]!;
    expect(message).toEqual({ kind: 'verify', job: JOB, original, candidate });
    expect(transfer).toHaveLength(2);
    workers[0]!.answer({ ok: true, kind: 'verify', verification: VERIFIED });
    expect(await result).toEqual(VERIFIED);
  });

  it('maps codec failures, recognizing memory exhaustion, and replaces the worker', async () => {
    const { pool, workers } = fakePool(1);
    const failed = pool.encode(JOB, new Uint8Array([1]), ctx);
    workers[0]!.answer({ ok: false, message: 'JPEG datastream contains no image' });
    await expect(failed).rejects.toMatchObject({ code: 'media-failed', message: 'JPEG datastream contains no image' });
    expect(workers[0]!.terminated).toBe(true);
    const oom = pool.encode(JOB, new Uint8Array([1]), ctx);
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ ok: false, message: 'RangeError: Array buffer allocation failed' });
    await expect(oom).rejects.toMatchObject({ code: 'media-failed', message: expect.stringMatching(/ran out of memory for this image/) });
  });

  it('terminates a worker that exceeds the time limit; waiting jobs do not use up their time', async () => {
    const { pool, workers } = fakePool(1);
    const slow = pool.encode(JOB, new Uint8Array([1]), { ...ctx, timeoutMs: 30 });
    const waiting = pool.encode(JOB, new Uint8Array([2]), { ...ctx, timeoutMs: 20 });
    await expect(slow).rejects.toMatchObject({ code: 'media-failed', message: 'image processing exceeded the time limit' });
    expect(workers[0]!.terminated).toBe(true);
    // The queued job starts on a new worker with its full time limit.
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([2]) });
    expect(await waiting).toEqual(new Uint8Array([2]));
  });

  it('cancels queued jobs without starting them and running jobs by terminating their worker', async () => {
    const { pool, workers } = fakePool(1);
    const running = new AbortController();
    const queued = new AbortController();
    const a = pool.encode(JOB, new Uint8Array([1]), { ...ctx, signal: running.signal });
    const b = pool.encode(JOB, new Uint8Array([2]), { ...ctx, signal: queued.signal });
    const c = pool.encode(JOB, new Uint8Array([3]), ctx);
    queued.abort();
    await expect(b).rejects.toBeInstanceOf(CancelledError);
    running.abort();
    await expect(a).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0]!.terminated).toBe(true);
    // Only the third job reaches the fresh worker.
    expect(workers).toHaveLength(2);
    expect(workers[1]!.requests.map((r) => [...r.message.original])).toEqual([[3]]);
    workers[1]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([3]) });
    await c;
  });

  it('rejects an already-cancelled job without using a worker, and ignores cancellation after completion', async () => {
    const { pool, workers } = fakePool(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(pool.encode(JOB, new Uint8Array([1]), { ...ctx, signal: aborted.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(workers).toHaveLength(0);
    const later = new AbortController();
    const done = pool.encode(JOB, new Uint8Array([1]), { ...ctx, signal: later.signal });
    workers[0]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([1]) });
    await done;
    later.abort();
    expect(workers[0]!.terminated).toBe(false);
  });

  it('fails the job of a crashed worker and discards workers that crash while idle', async () => {
    const { pool, workers } = fakePool(2);
    const job = pool.encode(JOB, new Uint8Array([1]), ctx);
    workers[0]!.onerror!({ message: 'Uncaught RuntimeError: unreachable' });
    await expect(job).rejects.toMatchObject({ code: 'media-failed', message: 'image worker failed: Uncaught RuntimeError: unreachable' });
    expect(workers[0]!.terminated).toBe(true);
    const next = pool.encode(JOB, new Uint8Array([1]), ctx);
    workers[1]!.onerror!({});
    await expect(next).rejects.toMatchObject({ message: 'image worker failed: unknown error' });
    const ok = pool.encode(JOB, new Uint8Array([1]), ctx);
    workers[2]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([1]) });
    await ok;
    workers[2]!.onerror!({ message: 'late failure' });
    expect(workers[2]!.terminated).toBe(true);
    expect(pool.workers).toBe(0);
  });

  it('reports workers that cannot be started, and recovers', async () => {
    let fail = true;
    const pool = new ImagePool(() => {
      if (fail) throw new DOMException('Worker scripts are blocked', 'SecurityError');
      return new FakeImageWorker();
    }, 1);
    await expect(pool.encode(JOB, new Uint8Array([1]), ctx)).rejects.toMatchObject({
      code: 'media-failed',
      message: 'The image worker could not be started: Worker scripts are blocked',
    });
    fail = false;
    const pending = pool.encode(JOB, new Uint8Array([1]), ctx);
    expect(pool.workers).toBe(1);
    pool.dispose();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('stops every worker on dispose, cancelling pending jobs, and starts again when needed', async () => {
    const { pool, workers } = fakePool(1);
    const running = pool.encode(JOB, new Uint8Array([1]), ctx);
    const queued = pool.verify(new Uint8Array([1]), new Uint8Array([2]), JOB, ctx);
    pool.dispose();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    await expect(queued).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0]!.terminated).toBe(true);
    expect(pool.workers).toBe(0);
    pool.dispose();
    const again = pool.encode(JOB, new Uint8Array([1]), ctx);
    workers[1]!.answer({ ok: true, kind: 'encode', encoded: new Uint8Array([7]) });
    expect(await again).toEqual(new Uint8Array([7]));
    await settle();
  });
});

describe('runImageRequest (worker side)', () => {
  /** Codecs double returning the given encoder output. */
  function codecs(encoded: Uint8Array, fail?: unknown): ImageCodecs {
    return {
      decode: () => Promise.resolve({ data: new Uint8ClampedArray([1, 2, 3, 255]), width: 1, height: 1 }),
      encode: () => (fail === undefined ? Promise.resolve(encoded) : Promise.reject(fail)),
    };
  }

  it('transfers an encoded buffer it owns, and copies views into larger buffers', async () => {
    const owned = new Uint8Array([1, 2, 3]);
    const a = await runImageRequest(codecs(owned), { kind: 'encode', job: JOB, original: new Uint8Array([9]) });
    expect(a.response).toEqual({ ok: true, kind: 'encode', encoded: owned });
    expect(a.transfer).toEqual([owned.buffer]);
    const memory = new Uint8Array(64);
    memory.set([7, 8], 10);
    const view = memory.subarray(10, 12);
    const b = await runImageRequest(codecs(view), { kind: 'encode', job: JOB, original: new Uint8Array([9]) });
    const encoded = (b.response as { encoded: Uint8Array }).encoded;
    expect([...encoded]).toEqual([7, 8]);
    expect(encoded.buffer).not.toBe(memory.buffer);
    expect(b.transfer).toEqual([encoded.buffer]);
    const whole = new Uint8Array(new ArrayBuffer(8), 0, 4);
    const c = await runImageRequest(codecs(whole), { kind: 'encode', job: JOB, original: new Uint8Array([9]) });
    expect((c.response as { encoded: Uint8Array }).encoded.byteLength).toBe(4);
    expect((c.transfer[0] as ArrayBuffer).byteLength).toBe(4);
  });

  it('verifies with the shared comparison and reports codec failures', async () => {
    const v = await runImageRequest(codecs(new Uint8Array()), { kind: 'verify', job: JOB, original: new Uint8Array([1]), candidate: new Uint8Array([2]) });
    expect(v).toEqual({ response: { ok: true, kind: 'verify', verification: { ...VERIFIED, identicalPixels: true } }, transfer: [] });
    const e = await runImageRequest(codecs(new Uint8Array(), new Error('bad huffman table')), { kind: 'encode', job: JOB, original: new Uint8Array([1]) });
    expect(e).toEqual({ response: { ok: false, message: 'bad huffman table' }, transfer: [] });
  });
});

describe('ImagePool with real image workers', () => {
  let pool: ImagePool | undefined;

  afterEach(() => {
    pool?.dispose();
    pool = undefined;
  });

  /** A pool of real module workers running image.worker.ts. */
  function realPool(size: number, counter?: { started: number }): ImagePool {
    return new ImagePool(() => {
      if (counter) counter.started++;
      return new Worker(new URL('../../src/adapters/browser/image.worker.ts', import.meta.url), { type: 'module' }) as unknown as ImageWorkerLike;
    }, size);
  }

  it('encodes in parallel workers exactly like the in-process codecs', async () => {
    const photo = await fixtureBytes(photoUrl);
    const png = await fixtureBytes(alphaPngUrl);
    const jpegJob = imageJobFor(photo, 'jpeg', { jpegQuality: 70 });
    const pngJob = imageJobFor(png, 'png');
    const counter = { started: 0 };
    pool = realPool(3, counter);
    const outputs = await Promise.all([
      pool.encode(jpegJob, photo, ctx),
      pool.encode(pngJob, png, ctx),
      pool.encode(jpegJob, photo, ctx),
      pool.encode(pngJob, png, ctx),
    ]);
    expect(counter.started).toBe(3);
    // The caller's buffers are intact.
    expect(photo).toEqual(await fixtureBytes(photoUrl));
    const local = createJsquashCodecs();
    expect(outputs[0]).toEqual(await local.encode(jpegJob, photo));
    expect(outputs[1]).toEqual(await local.encode(pngJob, png));
    expect(outputs[2]).toEqual(outputs[0]);
    const verification = await pool.verify(png, outputs[1]!, pngJob, ctx);
    expect(verification).toMatchObject({ ok: true, identicalPixels: true, hasAlpha: true });
    const broken = await pool.verify(photo, new Uint8Array([0xff, 0xd8, 0xff, 0]), jpegJob, ctx);
    expect(broken.problems[0]).toMatch(/^candidate cannot be decoded/);
  });

  it('really stops a running codec on cancel, and the next job works', async () => {
    const photo = await fixtureBytes(photoUrl);
    const job = imageJobFor(photo, 'jpeg', { jpegQuality: 70 });
    const counter = { started: 0 };
    pool = realPool(1, counter);
    const controller = new AbortController();
    const running = pool.encode(job, photo, { ...ctx, signal: controller.signal });
    await waitFor(() => counter.started === 1);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(pool.workers).toBe(0);
    expect((await pool.encode(job, photo, ctx)).length).toBeGreaterThan(0);
    expect(counter.started).toBe(2);
  });
});
