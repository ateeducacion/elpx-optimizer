import { describe, expect, it, vi } from 'vitest';
import { PipelineClient, PipelineError, type WorkerLike } from '../../src/adapters/browser/pipeline-client.js';
import type { ClientMessage, EngineStatus, WorkerMessage } from '../../src/adapters/browser/protocol.js';
import type { AnalysisResult } from '../../src/core/analyze/model.js';
import type { ProgressEvent } from '../../src/core/media/engine.js';
import type { OptimizationPlan } from '../../src/core/plan/plan.js';
import type { OptimizationReport } from '../../src/core/report/report.js';
import { waitFor } from './helpers.js';

const analysis = { ok: true, input: { name: 'a.elpx' } } as unknown as AnalysisResult;
const plan = { planHash: 'h1', operations: [] } as unknown as OptimizationPlan;
const report = { status: 'optimized' } as unknown as OptimizationReport;

/** Fake worker: records messages and answers through a scripted responder. */
class FakeWorker implements WorkerLike {
  readonly posted: ClientMessage[] = [];
  terminated = false;
  onmessage: ((e: { data: WorkerMessage }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;

  constructor(private readonly respond?: (m: ClientMessage, w: FakeWorker) => void) {}

  postMessage(message: ClientMessage): void {
    this.posted.push(message);
    this.respond?.(message, this);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers a message to the page. */
  send(data: WorkerMessage): void {
    this.onmessage?.({ data });
  }
}

/** Client over fake workers built with the responder; returns every worker created. */
function setup(respond?: (m: ClientMessage, w: FakeWorker) => void, graceMs?: number): { client: PipelineClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = new PipelineClient(() => {
    const w = new FakeWorker(respond);
    workers.push(w);
    return w;
  }, graceMs);
  return { client, workers };
}

/** Answers analyze/plan/optimize immediately (a well-behaved worker). */
function cooperative(m: ClientMessage, w: FakeWorker): void {
  if (m.type === 'analyze') queueMicrotask(() => w.send({ type: 'analysis', id: m.id, result: analysis }));
  if (m.type === 'plan') queueMicrotask(() => w.send({ type: 'plan', id: m.id, plan }));
  if (m.type === 'optimize') queueMicrotask(() => w.send({ type: 'result', id: m.id, report, fileName: 'a_optimized.elpx', output: new Blob(['zip']) }));
  if (m.type === 'preview') queueMicrotask(() => w.send({ type: 'preview', id: m.id, blob: new Blob([m.path], { type: 'image/png' }) }));
  if (m.type === 'read') queueMicrotask(() => w.send({ type: 'read', id: m.id, ...(m.path === 'missing' ? {} : { blob: new Blob([m.path]) }) }));
}

const file = new File(['PK'], 'a.elpx');

describe('PipelineClient', () => {
  it('correlates requests and responses by id', async () => {
    const { client, workers } = setup(cooperative);
    expect(await client.analyze(file)).toBe(analysis);
    expect(await client.plan({ preset: 'aggressive' })).toBe(plan);
    const result = await client.optimize('h1');
    expect(result).toMatchObject({ report, fileName: 'a_optimized.elpx' });
    expect(result.output).toBeInstanceOf(Blob);
    expect(workers[0]!.posted).toEqual([
      { type: 'analyze', id: 1, file },
      { type: 'plan', id: 2, options: { preset: 'aggressive' } },
      { type: 'optimize', id: 3, planHash: 'h1' },
    ]);
  });

  it('forwards the threading preference and resolves out-of-order answers', async () => {
    const { client, workers } = setup();
    const a = client.analyze(file, undefined, 'single');
    const b = client.plan({});
    await waitFor(() => workers[0]!.posted.length === 2);
    expect(workers[0]!.posted[0]).toEqual({ type: 'analyze', id: 1, file, threading: 'single' });
    workers[0]!.send({ type: 'plan', id: 2, plan });
    workers[0]!.send({ type: 'analysis', id: 1, result: analysis });
    expect(await b).toBe(plan);
    expect(await a).toBe(analysis);
  });

  it('sends the page video limit with every analysis, including transparent re-analysis', async () => {
    const { client, workers } = setup(cooperative);
    client.maxVideoBytes = 5 * 1024 * 1024;
    await client.analyze(file, undefined, 'auto');
    expect(workers[0]!.posted[0]).toEqual({ type: 'analyze', id: 1, file, threading: 'auto', maxVideoBytes: 5 * 1024 * 1024 });
    workers[0]!.onerror!({ message: 'crash' });
    await client.plan({});
    expect(workers[1]!.posted[0]).toEqual({ type: 'analyze', id: 2, file, threading: 'auto', maxVideoBytes: 5 * 1024 * 1024 });
    client.maxVideoBytes = undefined;
    await client.analyze(file);
    expect(workers[1]!.posted.at(-1)).toEqual({ type: 'analyze', id: 4, file });
  });

  it('delivers results without an output file', async () => {
    const { client, workers } = setup((m, w) => {
      if (m.type === 'optimize') queueMicrotask(() => w.send({ type: 'result', id: m.id, report, fileName: 'x.elpx' }));
    });
    const result = await client.optimize('h');
    expect(result).toEqual({ report, fileName: 'x.elpx' });
    expect(workers).toHaveLength(1);
  });

  it('routes progress to the request that asked for it', async () => {
    const { client, workers } = setup();
    const events: ProgressEvent[] = [];
    const running = client.optimize('h', (e) => events.push(e));
    const quiet = client.plan({});
    await waitFor(() => workers[0]!.posted.length === 2);
    const w = workers[0]!;
    w.send({ type: 'progress', id: 1, event: { stage: 'transcode', fraction: 0.5 } });
    w.send({ type: 'progress', id: 2, event: { stage: 'package' } }); // no listener
    w.send({ type: 'progress', id: 77, event: { stage: 'verify' } }); // unknown request
    w.send({ type: 'result', id: 1, report, fileName: 'f' });
    w.send({ type: 'result', id: 1, report, fileName: 'duplicate' }); // late duplicate is ignored
    w.send({ type: 'plan', id: 2, plan });
    expect((await running).fileName).toBe('f');
    await quiet;
    expect(events).toEqual([{ stage: 'transcode', fraction: 0.5 }]);
  });

  it('maps worker errors and cancellations to PipelineError', async () => {
    const { client, workers } = setup((m, w) => {
      if (m.type === 'plan') queueMicrotask(() => w.send({ type: 'error', id: m.id, code: 'invalid-options', message: 'bad preset' }));
      if (m.type === 'optimize') queueMicrotask(() => w.send({ type: 'cancelled', id: m.id }));
    });
    const planError = await client.plan({}).catch((e: unknown) => e);
    expect(planError).toBeInstanceOf(PipelineError);
    expect(planError).toMatchObject({ name: 'PipelineError', code: 'invalid-options', message: 'bad preset' });
    await expect(client.optimize('h')).rejects.toMatchObject({ code: 'cancelled', message: 'Cancelled' });
    expect(workers).toHaveLength(1);
  });

  it('reports engine status to the page when someone listens', async () => {
    const { client, workers } = setup();
    workers[0]!.send({ type: 'engine', status: { state: 'loading' } });
    const seen: EngineStatus[] = [];
    client.onEngineStatus = (s) => seen.push(s);
    workers[0]!.send({ type: 'engine', status: { state: 'ready', mode: 'single', reason: 'r' } });
    expect(seen).toEqual([{ state: 'ready', mode: 'single', reason: 'r' }]);
  });

  it('answers playback checks with the page probe, or "unsupported" without one', async () => {
    const { client, workers } = setup();
    const w = workers[0]!;
    const blob = new Blob(['v']);
    w.send({ type: 'playback-check', requestId: 5, blob, mime: 'video/mp4' });
    await waitFor(() => w.posted.length === 1);
    expect(w.posted[0]).toEqual({ type: 'playback-result', requestId: 5, result: 'unsupported' });
    const probe = vi.fn(() => Promise.resolve('playable' as const));
    client.onPlaybackCheck = probe;
    w.send({ type: 'playback-check', requestId: 6, blob, mime: 'video/webm' });
    await waitFor(() => w.posted.length === 2);
    expect(probe).toHaveBeenCalledWith(blob, 'video/webm');
    expect(w.posted[1]).toEqual({ type: 'playback-result', requestId: 6, result: 'playable' });
  });

  it('resolves cancel at once when nothing is running', async () => {
    const { client, workers } = setup();
    await client.cancel();
    expect(workers[0]!.posted).toEqual([]);
  });

  it('cancels through the worker when it answers in time', async () => {
    const { client, workers } = setup((m, w) => {
      if (m.type === 'cancel') setTimeout(() => w.send({ type: 'cancelled', id: 1 }), 30);
    }, 5000);
    const statuses: EngineStatus[] = [];
    client.onEngineStatus = (s) => statuses.push(s);
    const outcome = client.optimize('h').catch((e: unknown) => e);
    await waitFor(() => workers[0]!.posted.length === 1);
    await client.cancel();
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    expect(workers[0]!.posted.map((m) => m.type)).toEqual(['optimize', 'cancel']);
    expect(statuses).toEqual([]);
  });

  it('terminates and recreates an unresponsive worker, then re-analyzes the last file transparently', async () => {
    let first = true;
    const { client, workers } = setup((m, w) => {
      if (m.type === 'analyze') queueMicrotask(() => w.send({ type: 'analysis', id: m.id, result: analysis }));
      if (m.type === 'optimize' && first) {
        first = false;
        return; // hangs; ignores the cancel request too
      }
      cooperative(m, w);
    }, 120);
    await client.analyze(file, undefined, 'single');
    const statuses: EngineStatus[] = [];
    client.onEngineStatus = (s) => statuses.push(s);
    const running = client.optimize('h').catch((e: unknown) => e);
    await waitFor(() => workers[0]!.posted.length === 2);
    const started = Date.now();
    await client.cancel();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(await running).toMatchObject({ code: 'cancelled' });
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(statuses).toEqual([{ state: 'idle' }]);
    // The new worker knows nothing: the file is analyzed again before planning.
    expect(await client.plan({})).toBe(plan);
    expect(workers[1]!.posted.map((m) => m.type)).toEqual(['analyze', 'plan']);
    expect(workers[1]!.posted[0]).toMatchObject({ type: 'analyze', file, threading: 'single' });
    // Only once.
    expect((await client.optimize('h1')).fileName).toBe('a_optimized.elpx');
    expect(workers[1]!.posted.map((m) => m.type)).toEqual(['analyze', 'plan', 'optimize']);
  });

  it('does not re-analyze after a restart when no file was analyzed', async () => {
    const { client, workers } = setup((m, w) => {
      if (m.type === 'plan') cooperative(m, w);
    }, 50);
    const hanging = client.optimize('h').catch((e: unknown) => e);
    await waitFor(() => workers[0]!.posted.length === 1);
    await client.cancel();
    await hanging;
    expect(await client.plan({})).toBe(plan);
    expect(workers[1]!.posted.map((m) => m.type)).toEqual(['plan']);
  });

  it('fails every pending request when the worker crashes, and starts a new one', async () => {
    const { client, workers } = setup();
    const statuses: EngineStatus[] = [];
    client.onEngineStatus = (s) => statuses.push(s);
    const a = client.analyze(file).catch((e: unknown) => e);
    const b = client.plan({}).catch((e: unknown) => e);
    await waitFor(() => workers[0]!.posted.length === 2);
    workers[0]!.onerror!({ message: 'Uncaught RangeError: Array buffer allocation failed' });
    expect(await a).toMatchObject({ code: 'worker-error', message: 'Uncaught RangeError: Array buffer allocation failed' });
    expect(await b).toMatchObject({ code: 'worker-error' });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(statuses).toEqual([{ state: 'idle' }]);
    const c = client.plan({}).catch((e: unknown) => e);
    await waitFor(() => workers[1]!.posted.length === 1);
    workers[1]!.onerror!({});
    expect(await c).toMatchObject({ code: 'worker-error', message: 'The processing worker failed' });
    expect(workers).toHaveLength(3);
  });

  it('surfaces a failed transparent re-analysis', async () => {
    let crash = true;
    const { client, workers } = setup((m, w) => {
      if (m.type === 'analyze' && !crash) queueMicrotask(() => w.send({ type: 'error', id: m.id, code: 'io', message: 'file moved' }));
      if (m.type === 'analyze' && crash) queueMicrotask(() => w.send({ type: 'analysis', id: m.id, result: analysis }));
    });
    await client.analyze(file);
    crash = false;
    workers[0]!.onerror!({ message: 'crash' });
    await expect(client.optimize('h')).rejects.toMatchObject({ code: 'io', message: 'file moved' });
    expect(workers[1]!.posted.map((m) => m.type)).toEqual(['analyze']);
  });

  it('reads files for a new thumbnail and sends it with the plan to run', async () => {
    const { client, workers } = setup(cooperative);
    await client.analyze(file);
    expect(await (await client.read('index.html'))!.text()).toBe('index.html');
    expect(await client.read('missing')).toBeUndefined();
    const screenshot = new Blob(['png']);
    await client.optimize('h1', undefined, screenshot);
    expect(workers[0]!.posted.slice(1)).toEqual([
      { type: 'read', id: 2, path: 'index.html' },
      { type: 'read', id: 3, path: 'missing' },
      { type: 'optimize', id: 4, planHash: 'h1', screenshot },
    ]);
  });

  it('asks the worker for a preview of a resource', async () => {
    const { client, workers } = setup(cooperative);
    await client.analyze(file);
    const blob = await client.preview('content/resources/a.png');
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('content/resources/a.png');
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'preview', id: 2, path: 'content/resources/a.png' });
  });

  it('maps a refused preview to PipelineError', async () => {
    const { client } = setup((m, w) => {
      if (m.type === 'preview') queueMicrotask(() => w.send({ type: 'error', id: m.id, code: 'limit-exceeded', message: 'Too large to preview' }));
    });
    await expect(client.preview('content/resources/big.mp4')).rejects.toMatchObject({
      name: 'PipelineError',
      code: 'limit-exceeded',
      message: 'Too large to preview',
    });
  });

  it('re-analyzes the file in a restarted worker before a preview', async () => {
    const { client, workers } = setup(cooperative);
    await client.analyze(file, undefined, 'single');
    workers[0]!.onerror!({ message: 'crash' });
    const blob = await client.preview('content/resources/b.png');
    expect(await blob.text()).toBe('content/resources/b.png');
    expect(workers[1]!.posted.map((m) => m.type)).toEqual(['analyze', 'preview']);
    expect(workers[1]!.posted[0]).toMatchObject({ type: 'analyze', file, threading: 'single' });
  });

  it('terminates the worker on dispose', () => {
    const { client, workers } = setup();
    client.dispose();
    expect(workers[0]!.terminated).toBe(true);
  });
});
