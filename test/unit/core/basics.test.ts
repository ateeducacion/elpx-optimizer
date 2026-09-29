import { describe, expect, it, vi } from 'vitest';
import { CancelledError, ElpxError, errorMessage, isElpxError } from '../../../src/core/errors.js';
import { onCancel, throwIfCancelled, type CancelSignal } from '../../../src/core/cancel.js';
import { BROWSER_LIMITS, NATIVE_LIMITS, resolveLimits, type Limits } from '../../../src/core/limits.js';
import { DIAGNOSTIC_CODES, diagnostic, diagnosticKey, sortDiagnostics, type Diagnostic } from '../../../src/core/diagnostics.js';
import {
  ANALYSIS_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
  UPSTREAM_SHA,
  UPSTREAM_VERSION,
} from '../../../src/core/version.js';
import * as core from '../../../src/core/index.js';

describe('errors', () => {
  it('carries a stable code, message and details', () => {
    const e = new ElpxError('zip-limit', 'too big', { entry: 'a.bin' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ElpxError');
    expect(e.code).toBe('zip-limit');
    expect(e.message).toBe('too big');
    expect(e.details).toEqual({ entry: 'a.bin' });
    expect(new ElpxError('io', 'x').details).toBeUndefined();
  });

  it('CancelledError is an ElpxError with the cancelled code', () => {
    const e = new CancelledError();
    expect(e).toBeInstanceOf(ElpxError);
    expect(e.name).toBe('CancelledError');
    expect(e.code).toBe('cancelled');
    expect(e.message).toBe('Operation cancelled');
    expect(new CancelledError('stop').message).toBe('stop');
  });

  it('isElpxError checks the type and optionally the code', () => {
    const e = new ElpxError('io', 'x');
    expect(isElpxError(e)).toBe(true);
    expect(isElpxError(e, 'io')).toBe(true);
    expect(isElpxError(e, 'zip-limit')).toBe(false);
    expect(isElpxError(new CancelledError(), 'cancelled')).toBe(true);
    expect(isElpxError(new Error('x'))).toBe(false);
    expect(isElpxError('io')).toBe(false);
    expect(isElpxError(undefined)).toBe(false);
  });

  it('errorMessage never exposes stacks and handles non-errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new ElpxError('io', 'bad read'))).toBe('bad read');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('Unknown error');
    expect(errorMessage({ message: 'not an error' })).toBe('Unknown error');
    expect(errorMessage(null)).toBe('Unknown error');
  });
});

describe('cancel', () => {
  it('throwIfCancelled throws only for an aborted signal', () => {
    expect(() => throwIfCancelled(undefined)).not.toThrow();
    const controller = new AbortController();
    expect(() => throwIfCancelled(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfCancelled(controller.signal)).toThrow(CancelledError);
  });

  it('onCancel without a signal returns a no-op disposer', () => {
    const cb = vi.fn();
    const dispose = onCancel(undefined, cb);
    expect(dispose()).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it('onCancel runs the callback immediately when already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const cb = vi.fn();
    const dispose = onCancel(controller.signal, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    dispose();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('onCancel fires once on a later abort', () => {
    const controller = new AbortController();
    const cb = vi.fn();
    onCancel(controller.signal, cb);
    expect(cb).not.toHaveBeenCalled();
    controller.abort();
    controller.abort();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('the disposer removes the listener', () => {
    const controller = new AbortController();
    const cb = vi.fn();
    const dispose = onCancel(controller.signal, cb);
    dispose();
    controller.abort();
    expect(cb).not.toHaveBeenCalled();
  });

  it('works with any structural signal implementation', () => {
    const listeners = new Set<() => void>();
    const signal: CancelSignal = {
      aborted: false,
      addEventListener: (_type, l) => listeners.add(l),
      removeEventListener: (_type, l) => listeners.delete(l),
    };
    const cb = vi.fn();
    const dispose = onCancel(signal, cb);
    expect(listeners.size).toBe(1);
    for (const l of listeners) l();
    expect(cb).toHaveBeenCalledTimes(1);
    dispose();
    expect(listeners.size).toBe(0);
  });
});

describe('limits', () => {
  it('ships frozen native and browser defaults, the browser being tighter', () => {
    expect(Object.isFrozen(NATIVE_LIMITS)).toBe(true);
    expect(Object.isFrozen(BROWSER_LIMITS)).toBe(true);
    expect(BROWSER_LIMITS.maxVideoBytes).toBeLessThan(NATIVE_LIMITS.maxVideoBytes);
    expect(BROWSER_LIMITS.maxImagePixels).toBeLessThan(NATIVE_LIMITS.maxImagePixels);
    expect(BROWSER_LIMITS.maxEntries).toBe(NATIVE_LIMITS.maxEntries);
    for (const [key, value] of Object.entries(NATIVE_LIMITS)) {
      expect(Number.isFinite(value) && value > 0, key).toBe(true);
    }
  });

  it('merges overrides without mutating the base', () => {
    const merged = resolveLimits(NATIVE_LIMITS, { maxEntries: 10, maxXmlDepth: undefined });
    expect(merged.maxEntries).toBe(10);
    expect(merged.maxXmlDepth).toBe(NATIVE_LIMITS.maxXmlDepth);
    expect(NATIVE_LIMITS.maxEntries).toBe(50_000);
    expect(Object.isFrozen(merged)).toBe(false);
    expect(resolveLimits(BROWSER_LIMITS)).toEqual(BROWSER_LIMITS);
    expect(resolveLimits(NATIVE_LIMITS, { maxCompressionRatio: 0.5 }).maxCompressionRatio).toBe(0.5);
  });

  it('rejects unknown keys', () => {
    expect(() => resolveLimits(NATIVE_LIMITS, { maxBananas: 3 } as unknown as Partial<Limits>)).toThrow(/Unknown limit: maxBananas/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5'])('rejects the invalid value %j', (value) => {
    expect(() => resolveLimits(NATIVE_LIMITS, { maxEntries: value as number })).toThrow(/Invalid value for limit maxEntries/);
  });
});

describe('diagnostics', () => {
  it('describes every code with a severity, category and description', () => {
    const severities = new Set(['fatal', 'error', 'warning', 'info']);
    const entries = Object.entries(DIAGNOSTIC_CODES);
    expect(entries.length).toBeGreaterThan(40);
    for (const [code, info] of entries) {
      expect(severities.has(info.severity), code).toBe(true);
      expect(info.category, code).toMatch(/^[a-z-]+$/);
      expect(info.description.length, code).toBeGreaterThan(10);
    }
  });

  it('creates diagnostics with catalogue defaults', () => {
    const d = diagnostic('missing-resource', 'Missing a.png');
    expect(d).toEqual({ code: 'missing-resource', severity: 'error', category: 'missing-resource', message: 'Missing a.png', repairable: false });
    expect('resource' in d).toBe(false);
    expect('location' in d).toBe(false);
    expect('details' in d).toBe(false);
  });

  it('applies overrides for severity, resource, location and details', () => {
    const d = diagnostic('missing-resource', 'm', {
      severity: 'warning',
      resource: 'content/resources/a.png',
      location: { entry: 'content.xml', ideviceId: 'x' },
      details: { form: 'relative' },
    });
    expect(d.severity).toBe('warning');
    expect(d.category).toBe('missing-resource');
    expect(d.resource).toBe('content/resources/a.png');
    expect(d.location).toEqual({ entry: 'content.xml', ideviceId: 'x' });
    expect(d.details).toEqual({ form: 'relative' });
  });

  it('builds a stable key from code, resource and location', () => {
    const a = diagnostic('missing-resource', 'one', { resource: 'r', location: { entry: 'e', ideviceId: 'i', field: 'f', jsonPath: '$.a', attribute: 'src' } });
    const b = diagnostic('missing-resource', 'another message', {
      resource: 'r',
      location: { entry: 'e', ideviceId: 'i', field: 'f', jsonPath: '$.a', attribute: 'src', line: 99 },
    });
    expect(diagnosticKey(a)).toBe('missing-resource|r|e|i|f|$.a|src');
    expect(diagnosticKey(a)).toBe(diagnosticKey(b));
    expect(diagnosticKey(diagnostic('zip-limit', 'x'))).toBe('zip-limit||||||');
  });

  it('sorts by severity, then code, then resource, without mutating the input', () => {
    const list: Diagnostic[] = [
      diagnostic('external-reference', 'i1', { resource: 'b' }),
      diagnostic('missing-resource', 'e2', { resource: 'z' }),
      diagnostic('zip-structure', 'f'),
      diagnostic('missing-resource', 'e1', { resource: 'a' }),
      diagnostic('lenient-resolution', 'w'),
      diagnostic('external-reference', 'i0'),
    ];
    const sorted = sortDiagnostics(list);
    expect(sorted.map((d) => d.message)).toEqual(['f', 'e1', 'e2', 'w', 'i0', 'i1']);
    expect(list[0]!.message).toBe('i1');
  });

  it('orders diagnostics without a resource before those with one', () => {
    const withResource = diagnostic('duplicate-content', 'with', { resource: 'a' });
    const without = diagnostic('duplicate-content', 'without');
    expect(sortDiagnostics([withResource, without]).map((d) => d.message)).toEqual(['without', 'with']);
    expect(sortDiagnostics([without, withResource]).map((d) => d.message)).toEqual(['without', 'with']);
  });
});

describe('version and public entry point', () => {
  it('exposes the tool identity and schema versions', () => {
    expect(TOOL_NAME).toBe('elpx-optimizer');
    expect(TOOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(UPSTREAM_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(UPSTREAM_VERSION).toContain(UPSTREAM_SHA.slice(0, 8));
    expect([ANALYSIS_SCHEMA_VERSION, PLAN_SCHEMA_VERSION, REPORT_SCHEMA_VERSION]).toEqual([1, 1, 1]);
  });

  it('re-exports the public API from the core index', () => {
    expect(core.TOOL_NAME).toBe(TOOL_NAME);
    expect(core.NATIVE_LIMITS).toBe(NATIVE_LIMITS);
    expect(typeof core.analyzeArchive).toBe('function');
    expect(typeof core.optimizeArchive).toBe('function');
    expect(typeof core.normalizeOptions).toBe('function');
    expect(typeof core.buildOptimizationPlan).toBe('function');
    expect(typeof core.validateArchive).toBe('function');
    expect(typeof core.buildReport).toBe('function');
    expect(core.isElpxError(new core.CancelledError(), 'cancelled')).toBe(true);
    expect(core.DIAGNOSTIC_CODES).toBe(DIAGNOSTIC_CODES);
  });
});
