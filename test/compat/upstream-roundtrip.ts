/**
 * Independent compatibility check against eXeLearning itself.
 *
 * Runs inside the pinned upstream checkout (copied there by
 * scripts/fetch-upstream.sh so that `yjs`, `fflate` and the upstream sources
 * resolve from its node_modules). For an original and an optimized package it
 * uses upstream's own ElpxImporter (the code path of `bun cli elp:export`),
 * builds the semantic model (pages → blocks → components with ids, types,
 * order, content and properties) and compares both. Every `asset://`
 * reference is normalized to the ORIGINAL content hash of the file it
 * resolves to: recompressed files keep their path (same original hash) and
 * merged duplicates had identical content, so any wrong rewrite shows up as a
 * difference. It then re-exports the optimized project with upstream's ELPX
 * and HTML5 exporters and re-imports the ELPX.
 *
 * `--renames=FILE` (JSON: new path → original path) maps moved files back to
 * their original content hash. `--content-changes` is for runs that take
 * out references to missing files: component content may then differ, but
 * pages, blocks and components (ids, types, order) must not, and no asset
 * may become missing or unresolved.
 *
 * Usage: bun roundtrip.ts <original.elpx> <optimized.elpx> --report=FILE [--renames=FILE] [--content-changes]
 * Exit code 0 when compatible, 1 otherwise.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';

const UPSTREAM = path.resolve(import.meta.dir, '..');
const SRC = path.join(UPSTREAM, 'src');
const { ElpxImporter, FileSystemAssetHandler } = await import(`${SRC}/shared/import/index.ts`);
const exp = await import(`${SRC}/shared/export/index.ts`);
const { validateXml } = await import(`${SRC}/services/xml/xml-parser.ts`);
const fflate = await import('fflate');
(await import(`${SRC}/services/idevice-config.ts`)).setIdevicesBasePath(path.join(UPSTREAM, 'public/files/perm/idevices/base'));

const args = process.argv.slice(2);
const reportArg = args.find((a) => a.startsWith('--report='));
const renamesArg = args.find((a) => a.startsWith('--renames='));
const contentChanges = args.includes('--content-changes');
const renames: Record<string, string> = renamesArg ? JSON.parse(await fs.readFile(renamesArg.slice('--renames='.length), 'utf8')) : {};
const [originalPath, optimizedPath] = args.filter((a) => !a.startsWith('--'));
if (!originalPath || !optimizedPath || !reportArg) {
  console.error('usage: bun roundtrip.ts <original.elpx> <optimized.elpx> --report=FILE');
  process.exit(2);
}
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const ASSET_REF = /asset:\/\/[^"'\s<>\\]+/g;
const trimRef = (r: string): string => (r.endsWith(')') && !r.includes('(') ? r.slice(0, -1) : r);
const warnings: string[] = [];
const logger = {
  log() {},
  warn: (...a: unknown[]) => warnings.push(a.map(String).join(' ')),
  error: (...a: unknown[]) => warnings.push(`ERROR ${a.map(String).join(' ')}`),
};
const normBool = (o: unknown): unknown =>
  o === 'true'
    ? true
    : o === 'false'
      ? false
      : Array.isArray(o)
        ? o.map(normBool)
        : o && typeof o === 'object'
          ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, normBool(v)]))
          : o;

/** Lists extracted files (relative path -> sha256). */
async function walk(dir: string, base = dir, out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else out[path.relative(base, p)] = sha(await fs.readFile(p));
  }
  return out;
}

/** Imports a package with upstream's importer. */
async function load(file: string) {
  const buf = new Uint8Array(await fs.readFile(file));
  const entries = fflate.unzipSync(buf);
  const xml = entries['content.xml'] ? new TextDecoder().decode(entries['content.xml']) : '';
  const validation = validateXml(xml);
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpx-compat-'));
  const ydoc = new Y.Doc();
  const result = await new ElpxImporter(ydoc, new FileSystemAssetHandler(extractDir), logger).importFromBuffer(buf);
  const wrapper = new exp.ServerYjsDocumentWrapper(ydoc, 'compat');
  const doc = new exp.YjsDocumentAdapter(wrapper);
  return {
    file,
    buf,
    validation,
    result,
    doc,
    wrapper,
    extractDir,
    pages: doc.getNavigation(),
    meta: { ...doc.getMetadata() } as Record<string, unknown>,
    extracted: await walk(extractDir),
  };
}
type Loaded = Awaited<ReturnType<typeof load>>;

/** Resolves an asset:// id to an extracted path (same rule as FileSystemAssetProvider). */
function resolveRef(ref: string, files: Record<string, string>): string | undefined {
  const id = decodeURIComponent(trimRef(ref).slice('asset://'.length));
  return Object.keys(files).find((k) => k === id || k === `content/${id}` || k.endsWith(`/${id}`));
}

/** Replaces asset references with the original content hash of their target. */
function normalize(text: string, l: Loaded, originalFiles: Record<string, string>, unresolved: Set<string>): string {
  return text.replace(ASSET_REF, (m) => {
    const target = resolveRef(m, l.extracted);
    if (!target) {
      unresolved.add(trimRef(m));
      return 'asset:unresolved';
    }
    const suffix = m.endsWith(')') && !m.includes('(') ? ')' : '';
    const original = originalFiles[target] ?? (renames[target] !== undefined ? originalFiles[renames[target]] : undefined);
    return `asset:${original ?? `new:${target}`}${suffix}`;
  });
}

/** Semantic model with normalized asset references. */
function model(l: Loaded, originalFiles: Record<string, string>, unresolved: Set<string>) {
  const norm = (v: unknown): unknown =>
    typeof v === 'string'
      ? normalize(v, l, originalFiles, unresolved)
      : Array.isArray(v)
        ? v.map(norm)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
          : v;
  return l.pages.map((p: any) => ({
    id: p.id,
    title: p.title,
    parentId: p.parentId,
    order: p.order,
    properties: normBool(p.properties),
    blocks: p.blocks.map((b: any) => ({
      id: b.id,
      name: b.name,
      order: b.order,
      properties: normBool(b.properties),
      components: b.components.map((c: any) => ({
        id: c.id,
        type: c.type,
        order: c.order,
        structureProperties: normBool(c.structureProperties),
        content: norm(c.content),
        properties: norm(c.properties),
      })),
    })),
  }));
}

/** Structural diff (first differences only). */
function diff(a: unknown, b: unknown, p = '$', out: string[] = []): string[] {
  if (out.length >= 40 || a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    const s = (v: unknown): string => {
      const t = JSON.stringify(v) ?? 'undefined';
      return t.length > 200 ? `${t.slice(0, 200)}…` : t;
    };
    out.push(`${p}: ${s(a)} -> ${s(b)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) diff((a as any)[k], (b as any)[k], `${p}.${k}`, out);
  return out;
}

const VOLATILE = new Set(['createdAt', 'modified', 'screenshot']);
const stableMeta = (m: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(m).filter(([k]) => !VOLATILE.has(k)));
const missingKey = (list: { componentId: string; paths: string[] }[]): string[] => list.flatMap((m) => m.paths.map((p) => `${m.componentId}:${p}`)).sort();

const original = await load(path.resolve(originalPath));
const optimized = await load(path.resolve(optimizedPath));
const unresolvedBefore = new Set<string>();
const unresolvedAfter = new Set<string>();
const modelBefore = model(original, original.extracted, unresolvedBefore);
const modelAfter = model(optimized, original.extracted, unresolvedAfter);
// Structure and ids only (upstream's own export rewrites asset paths and has known escaping bugs).
const shape = (m: ReturnType<typeof model>) =>
  m.map((p) => ({
    id: p.id,
    title: p.title,
    blocks: p.blocks.map((b: any) => ({ id: b.id, components: b.components.map((c: any) => ({ id: c.id, type: c.type })) })),
  }));
const structureDiffs = contentChanges ? diff(shape(modelBefore), shape(modelAfter)) : diff(modelBefore, modelAfter);
const contentDiffs = contentChanges ? diff(modelBefore, modelAfter).length : 0;
const metaDiffs = diff(stableMeta(original.meta), stableMeta(optimized.meta), '$meta');
const missingBefore = missingKey(original.result.missingAssets ?? []);
const missingAfter = missingKey(optimized.result.missingAssets ?? []);
const newMissing = missingAfter.filter((m) => !missingBefore.includes(m));
const newUnresolved = [...unresolvedAfter].filter((r) => !unresolvedBefore.has(r));
const malformedBefore = (original.result.malformedProperties ?? []).length;
const malformedAfter = (optimized.result.malformedProperties ?? []).length;

// Re-export the optimized project with upstream exporters, then re-import the ELPX.
const exports: Record<string, unknown>[] = [];
let reimportDiffs: string[] = [];
for (const format of ['elpx', 'html5']) {
  try {
    const Ctor = format === 'elpx' ? exp.ElpxExporter : exp.Html5Exporter;
    const exporter = new Ctor(
      optimized.doc,
      new exp.FileSystemResourceProvider(path.join(UPSTREAM, 'public'), optimized.extractDir),
      new exp.FileSystemAssetProvider(optimized.extractDir),
      new exp.FflateZipProvider(),
    );
    const res = await exporter.export({ filename: path.basename(optimizedPath), runtimeVersion: 'compat' });
    if (!res.success) throw new Error(String(res.error));
    exports.push({ format, ok: true, bytes: res.data.length });
    if (format === 'elpx') {
      const tmp = path.join(optimized.extractDir, '..', `reexport-${path.basename(optimizedPath)}`);
      await fs.writeFile(tmp, res.data);
      const again = await load(tmp);
      const u1 = new Set<string>();
      const u2 = new Set<string>();
      reimportDiffs = diff(shape(model(optimized, optimized.extracted, u1)), shape(model(again, again.extracted, u2)));
      again.wrapper.destroy();
      await fs.rm(again.extractDir, { recursive: true, force: true });
      await fs.rm(tmp, { force: true });
    }
  } catch (error) {
    exports.push({ format, ok: false, error: String(error) });
  }
}

const report = {
  upstream: UPSTREAM,
  original: {
    file: path.basename(originalPath),
    validation: { valid: original.validation.valid, errors: original.validation.errors.length },
    pages: original.result.pages,
    components: original.result.components,
    missingAssets: missingBefore.length,
    malformed: malformedBefore,
  },
  optimized: {
    file: path.basename(optimizedPath),
    validation: { valid: optimized.validation.valid, errors: optimized.validation.errors.length },
    pages: optimized.result.pages,
    components: optimized.result.components,
    missingAssets: missingAfter.length,
    malformed: malformedAfter,
  },
  structureDiffs,
  contentDiffs,
  metaDiffs,
  newMissing,
  newUnresolved,
  exports,
  reimportDiffs,
  warnings: warnings.slice(0, 20),
};
const ok =
  (optimized.validation.valid || !original.validation.valid) &&
  structureDiffs.length === 0 &&
  metaDiffs.length === 0 &&
  newMissing.length === 0 &&
  newUnresolved.length === 0 &&
  malformedAfter <= malformedBefore &&
  exports.every((e) => e['ok']) &&
  reimportDiffs.length === 0;
await fs.writeFile(reportArg.slice('--report='.length), JSON.stringify({ ok, ...report }, null, 2));
original.wrapper.destroy();
optimized.wrapper.destroy();
await fs.rm(original.extractDir, { recursive: true, force: true });
await fs.rm(optimized.extractDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
