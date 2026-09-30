import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ElpxError } from '../../core/errors.js';
import { sha256Hex } from '../../core/io/hash.js';
import { SCREENSHOT_HEIGHT, SCREENSHOT_WIDTH, screenshotRatioOk } from '../../core/format/screenshot.js';
import { analyzeArchive } from '../../core/analyze/analyze.js';
import { buildOptimizationPlan } from '../../core/plan/plan.js';
import { normalizeOptions, type OptionsInput } from '../../core/plan/options.js';
import { optimizeArchive } from '../../core/optimize/optimize.js';
import { buildReport, formatBytes, listLines, renderReportText, totalOf, VERBOSE_HINT, type OptimizationReport } from '../../core/report/report.js';
import { createNodePlatform } from '../../adapters/node/platform.js';
import { EXIT, type ExitCode } from '../exit-codes.js';
import { logger, printJson, type CliIO } from '../io.js';
import { assertNotInput, defaultOutputPath, intFlag, limitsFromFlags, openInputArg, progressPrinter } from '../shared.js';

/** Builds OptionsInput from --config and flags (flags win). */
export async function optionsFromFlags(values: Record<string, unknown>, io: CliIO): Promise<OptionsInput> {
  let base: OptionsInput = {};
  if (typeof values['config'] === 'string') {
    try {
      base = JSON.parse(await readFile(resolve(io.cwd, values['config']), 'utf8')) as OptionsInput;
    } catch (error) {
      throw new ElpxError('invalid-options', `Cannot read --config: ${(error as Error).message}`);
    }
  }
  const video: NonNullable<OptionsInput['video']> = { ...(base.video ?? {}) };
  const images: NonNullable<OptionsInput['images']> = { ...(base.images ?? {}) };
  const audio: NonNullable<OptionsInput['audio']> = { ...(base.audio ?? {}) };
  const pdf: NonNullable<OptionsInput['pdf']> = { ...(base.pdf ?? {}) };
  const opts: OptionsInput = { ...base };
  // "maximum" is the name the web app shows for the aggressive preset.
  if (typeof values['preset'] === 'string') opts.preset = (values['preset'] === 'maximum' ? 'aggressive' : values['preset']) as OptionsInput['preset'];
  if (values['no-video']) video.enabled = false;
  if (values['no-images']) images.enabled = false;
  if (values['no-audio']) audio.enabled = false;
  if (values['no-pdf']) pdf.enabled = false;
  if (values['pdf-lossless']) pdf.images = false;
  const abr = intFlag(values, 'audio-bitrate', 0, 10000);
  if (abr !== undefined) audio.bitrate = abr;
  if (values['audio-force']) audio.force = true;
  if (typeof values['remove-unused'] === 'string') opts.removeUnused = values['remove-unused'] as 'off' | 'safe';
  if (typeof values['deduplicate'] === 'string') opts.deduplicate = values['deduplicate'] as 'off' | 'exact';
  if (typeof values['flatten'] === 'string') opts.flatten = values['flatten'] as 'off' | 'legacy';
  if (typeof values['missing-references'] === 'string') opts.missingReferences = values['missing-references'] as 'keep' | 'remove';
  if (typeof values['normalize-names'] === 'string') opts.normalizeNames = values['normalize-names'] as 'off' | 'slug';
  if (Array.isArray(values['exclude'])) opts.exclude = [...(base.exclude ?? []), ...(values['exclude'] as string[])];
  const crf = intFlag(values, 'video-crf', 0, 63);
  if (crf !== undefined) video.crf = crf;
  if (typeof values['video-max-resolution'] === 'string') video.maxResolution = values['video-max-resolution'];
  const ab = intFlag(values, 'video-audio-bitrate', 0, 10000);
  if (ab !== undefined) video.audioBitrate = ab;
  if (typeof values['video-x264-preset'] === 'string') video.x264Preset = values['video-x264-preset'];
  if (values['video-force']) video.force = true;
  if (values['video-drop-data-streams']) video.dropDataStreams = true;
  const q = intFlag(values, 'image-quality', 0, 100);
  if (q !== undefined) images.jpegQuality = q;
  const wq = intFlag(values, 'webp-quality', 0, 100);
  if (wq !== undefined) images.webpQuality = wq;
  if (values['image-max-dimension'] === 'none') images.maxDimension = null;
  else {
    const md = intFlag(values, 'image-max-dimension', 0, 100000);
    if (md !== undefined) images.maxDimension = md;
  }
  if (values['no-png']) images.png = false;
  if (values['strip-metadata']) images.stripMetadata = true;
  if (values['image-force']) images.force = true;
  if (values['include-screenshot']) images.includeScreenshot = true;
  const mp = intFlag(values, 'min-savings-percent', 0, 100);
  if (mp !== undefined) opts.minSavingsPercent = mp;
  const mb = intFlag(values, 'min-savings-bytes', 0, Number.MAX_SAFE_INTEGER);
  if (mb !== undefined) opts.minSavingsBytes = mb;
  if (Object.keys(video).length > 0) opts.video = video;
  if (Object.keys(images).length > 0) opts.images = images;
  if (Object.keys(audio).length > 0) opts.audio = audio;
  if (Object.keys(pdf).length > 0) opts.pdf = pdf;
  return opts;
}

/**
 * Reads --screenshot the way eXeLearning takes an uploaded thumbnail: any image sharp decodes,
 * 16:9 and at least 600 px wide, scaled down to fit 1280×720 and saved as PNG.
 */
export async function screenshotFromFile(path: string): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp');
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(path).metadata());
  } catch (error) {
    throw new ElpxError('invalid-options', `Cannot read --screenshot: ${(error as Error).message}`);
  }
  if (!width || !height || !screenshotRatioOk(width, height)) {
    throw new ElpxError('invalid-options', `--screenshot must be a 16:9 image at least 600 px wide (got ${width ?? '?'}×${height ?? '?'})`);
  }
  const png = await sharp(path).resize(SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return new Uint8Array(png);
}

/** Exit code for a run status. */
export function exitForStatus(status: OptimizationReport['status']): ExitCode {
  switch (status) {
    case 'optimized':
    case 'no-improvement':
    case 'dry-run':
      return EXIT.SUCCESS;
    case 'partial':
      return EXIT.PARTIAL;
    case 'invalid-input':
      return EXIT.INVALID_INPUT;
    case 'cancelled':
      return EXIT.CANCELLED;
    default:
      return EXIT.FAILURE;
  }
}

/** optimize: plan, execute, verify and write the result atomically. */
export async function runOptimize(positionals: string[], values: Record<string, unknown>, io: CliIO): Promise<ExitCode> {
  const input = await optionsFromFlags(values, io);
  const screenshot = typeof values['screenshot'] === 'string' ? await screenshotFromFile(resolve(io.cwd, values['screenshot'])) : undefined;
  if (screenshot) input.screenshot = { sha256: sha256Hex(screenshot), size: screenshot.length };
  const options = normalizeOptions(input);
  const limits = limitsFromFlags(values);
  const json = values['json'] === true;
  const verbose = values['verbose'] === true;
  const quiet = values['quiet'] === true || (json && !io.interactive);
  const log = logger(io, values['quiet'] === true);
  const { path: inputPath, source, name } = await openInputArg(positionals, io);
  const dryRun = values['dry-run'] === true;
  const outputPath = typeof values['output'] === 'string' ? resolve(io.cwd, values['output']) : defaultOutputPath(inputPath);
  try {
    if (!dryRun) {
      await assertNotInput(inputPath, outputPath);
      const exists = await stat(outputPath).then(
        () => true,
        () => false,
      );
      if (exists && !values['overwrite'])
        throw new ElpxError('output-exists', `Output ${basename(outputPath)} already exists; choose another --output or pass --overwrite`);
    }
    const threads = intFlag(values, 'threads', 1, 64);
    const imageConcurrency = intFlag(values, 'image-concurrency', 1, 32);
    const platform = await createNodePlatform({
      limits,
      outputPath,
      ...(typeof values['temp-dir'] === 'string' ? { tempRoot: resolve(io.cwd, values['temp-dir']) } : {}),
      ...(threads !== undefined ? { threads } : {}),
      ...(imageConcurrency !== undefined ? { imageConcurrency } : {}),
      tools: {
        ...(typeof values['ffmpeg'] === 'string' ? { ffmpeg: values['ffmpeg'] } : {}),
        ...(typeof values['ffprobe'] === 'string' ? { ffprobe: values['ffprobe'] } : {}),
      },
    });
    const onProgress = progressPrinter(io, quiet);
    try {
      const analysis = await analyzeArchive(source, {
        limits,
        inputName: name,
        onProgress,
        media: { engine: platform.engine, store: platform.store },
        ...(io.signal ? { signal: io.signal } : {}),
      });
      const engineInfo = await platform.engine.info();
      if (!analysis.result.ok) {
        const report = buildReport({
          status: 'invalid-input',
          plan: undefined,
          engineInfo,
          analysis,
          results: [],
          validations: [],
          error: analysis.result.diagnostics.find((d) => d.severity === 'fatal')?.message ?? 'Invalid input',
        });
        await writeReport(values, io, report);
        if (json) printJson(io, report);
        else io.stdout(renderReportText(report, verbose));
        return EXIT.INVALID_INPUT;
      }
      const plan = buildOptimizationPlan(analysis, options, engineInfo, limits);
      if (dryRun) {
        const payload = {
          schema: 'elpx-optimizer/dry-run',
          schemaVersion: 1,
          status: 'dry-run',
          plan,
          analysis: {
            input: analysis.result.input,
            package: analysis.result.package,
            totals: analysis.result.totals,
            diagnostics: analysis.result.diagnostics.length,
          },
        };
        if (typeof values['report'] === 'string') await writeFile(resolve(io.cwd, values['report']), `${JSON.stringify(payload, null, 2)}\n`);
        if (json) printJson(io, payload);
        else io.stdout(renderPlan(plan, verbose));
        return EXIT.SUCCESS;
      }
      log(`Plan: ${plan.operations.length} operations, ${plan.skipped.length} resources left unchanged`);
      const outcome = await optimizeArchive(source, analysis, plan, platform, {
        outputName: basename(outputPath),
        onProgress,
        ...(screenshot ? { screenshot } : {}),
        ...(io.signal ? { signal: io.signal } : {}),
      });
      const report = outcome.report;
      const target = platform.lastOutput();
      if (outcome.output && target && (report.status === 'optimized' || report.status === 'partial' || report.status === 'no-improvement')) {
        await target.commit(values['overwrite'] === true);
      }
      await writeReport(values, io, report);
      if (json) printJson(io, report);
      else io.stdout(renderReportText(report, verbose));
      return exitForStatus(report.status);
    } finally {
      await platform.store.disposeAll();
    }
  } finally {
    await source.close();
  }
}

async function writeReport(values: Record<string, unknown>, io: CliIO, report: OptimizationReport): Promise<void> {
  if (typeof values['report'] === 'string') await writeFile(resolve(io.cwd, values['report']), `${JSON.stringify(report, null, 2)}\n`);
}

/** Human-readable plan (dry run). */
export function renderPlan(plan: ReturnType<typeof buildOptimizationPlan>, verbose = false): string {
  const lines = [`Plan for ${plan.input.name} (${formatBytes(plan.input.size)}), preset ${plan.options.preset}, engine ${plan.engine.engine}`];
  const opLine = (op: (typeof plan.operations)[number]): string => {
    switch (op.op) {
      case 'transcode-video':
      case 'recompress-image':
        return `  • ${op.op} ${op.path} (${formatBytes(op.size)})${op.lossy ? ' [lossy]' : ''}: ${op.conversions.join('; ')}`;
      case 'optimize-pdf':
        return `  • optimize-pdf ${op.path} (${formatBytes(op.size)})${op.lossy ? ' [lossy]' : ''}: ${op.conversions.join('; ')}`;
      case 'transcode-audio':
        return `  • transcode-audio ${op.path}${op.to ? ` → ${op.to}` : ''} (${formatBytes(op.size)}) [lossy]: ${op.conversions.join('; ')}`;
      case 'remove-unused':
        return `  • remove ${op.path} (${formatBytes(op.size)}): ${op.reason}`;
      case 'deduplicate':
        return `  • deduplicate: keep ${op.keep}, remove ${op.remove.join(', ')} (${op.references} references rewritten)`;
      case 'move-resource':
        return `  • move ${op.path} → ${op.to} (${op.references} references rewritten)`;
      case 'rename-resource':
        return `  • rename ${op.path} → ${op.to} (${op.references} references rewritten)`;
      case 'remove-missing-reference':
        return `  • take out ${op.references} ${op.references === 1 ? 'reference' : 'references'} to missing ${op.path} (in ${op.entries.join(', ')})`;
      case 'replace-screenshot':
        return `  • ${op.added ? 'add' : 'replace'} ${op.path} (${formatBytes(op.after)})`;
      default:
        return `  • ${op.op} ${op.path}: ${op.reason ?? ''}`;
    }
  };
  const ops = listLines(
    plan.operations,
    (op) => op.op,
    opLine,
    (kind, group) => {
      const size = totalOf(group, (o) => ('size' in o && typeof o.size === 'number' ? o.size : undefined));
      return `  • ${group.length} × ${kind}${size !== undefined ? ` (${formatBytes(size)})` : ''}`;
    },
    verbose,
    Infinity,
  );
  lines.push(...ops.lines);
  if (plan.skipped.length > 0) {
    lines.push(`Left unchanged (${plan.skipped.length}):`);
    const skipped = listLines(
      plan.skipped,
      (s) => s.reason,
      (s) => `  - ${s.path}: ${s.reason} (${s.detail})`,
      (reason, group) => `  - ${group.length} × ${reason}`,
      verbose,
      40,
    );
    lines.push(...skipped.lines);
    if (skipped.collapsed) ops.collapsed = true;
  }
  lines.push(`Estimated saving (estimate, not measured): ${formatBytes(plan.estimate.savedBytes)}`);
  for (const r of plan.risks) lines.push(`Note: ${r}`);
  if (ops.collapsed) lines.push(VERBOSE_HINT);
  return `${lines.join('\n')}\n`;
}
