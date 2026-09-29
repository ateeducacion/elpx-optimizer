import { analyzeArchive } from '../../core/analyze/analyze.js';
import type { AnalysisResult } from '../../core/analyze/model.js';
import { formatBytes } from '../../core/report/report.js';
import { NativeMediaEngine } from '../../adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../adapters/node/resource-store.js';
import { EXIT, type ExitCode } from '../exit-codes.js';
import { printJson, type CliIO } from '../io.js';
import { limitsFromFlags, openInputArg, progressPrinter } from '../shared.js';

/** inspect: analysis without modification (ffprobe used only when available). */
export async function runInspect(positionals: string[], values: Record<string, unknown>, io: CliIO): Promise<ExitCode> {
  const limits = limitsFromFlags(values);
  const { source, name } = await openInputArg(positionals, io);
  const store = await NodeResourceStore.create();
  try {
    const tools = {
      ...(typeof values['ffmpeg'] === 'string' ? { ffmpeg: values['ffmpeg'] } : {}),
      ...(typeof values['ffprobe'] === 'string' ? { ffprobe: values['ffprobe'] } : {}),
    };
    const engine = new NativeMediaEngine(store, { tools });
    const analysis = await analyzeArchive(source, {
      limits,
      inputName: name,
      onProgress: progressPrinter(io, values['quiet'] === true || (values['json'] === true && !io.interactive)),
      ...(values['no-probe'] ? {} : { media: { engine, store } }),
      ...(io.signal ? { signal: io.signal } : {}),
    });
    const result = analysis.result;
    if (values['json']) printJson(io, values['no-references'] ? { ...result, references: [] } : result);
    else io.stdout(renderInspect(result));
    return result.ok ? EXIT.SUCCESS : EXIT.INVALID_INPUT;
  } finally {
    await source.close();
    await store.disposeAll();
  }
}

/** Human-readable analysis summary. */
export function renderInspect(r: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`${r.input.name} — ${formatBytes(r.input.size)} (sha256 ${r.input.sha256.slice(0, 12)}…)`);
  if (!r.ok) {
    for (const d of r.diagnostics.filter((x) => x.severity === 'fatal')) lines.push(`✗ ${d.message}`);
    return `${lines.join('\n')}\n`;
  }
  const p = r.package!;
  lines.push(`eXeLearning ${p.variant === 'v4' ? 'v4' : 'v3.0-era'} project${p.title ? `: "${p.title}"` : ''} — ${p.pages} pages, ${p.components} iDevices`);
  lines.push(
    `Entries: ${r.totals.files} files, ${formatBytes(r.totals.uncompressedBytes)} uncompressed; user resources ${formatBytes(r.totals.userAssetBytes)} (video ${formatBytes(r.totals.videoBytes)}, images ${formatBytes(r.totals.imageBytes)}, audio ${formatBytes(r.totals.audioBytes)})`,
  );
  const largest = r.entries
    .filter((e) => e.role === 'user-asset')
    .sort((a, b) => b.size - a.size)
    .slice(0, 15);
  if (largest.length > 0) {
    lines.push('Largest resources:');
    for (const e of largest) {
      let extra = '';
      if (e.video)
        extra = ` ${e.video.videoCodec ?? '?'} ${e.video.width ?? '?'}x${e.video.height ?? '?'} ${e.video.duration?.toFixed(1) ?? '?'} s, audio ${e.video.audio.map((a) => a.codec).join('+') || 'none'}`;
      else if (e.image)
        extra = ` ${e.image.width ?? '?'}x${e.image.height ?? '?'}${e.image.jpegQuality ? ` q≈${e.image.jpegQuality}` : ''}${e.image.animated ? ' animated' : ''}`;
      lines.push(`  ${formatBytes(e.size).padStart(10)}  ${e.format.padEnd(5)} ${e.usage.padEnd(12)} ${e.path}${extra}`);
    }
  }
  const usage: Record<string, number> = {};
  for (const e of r.entries) if (e.role === 'user-asset') usage[e.usage] = (usage[e.usage] ?? 0) + 1;
  lines.push(
    `Usage: ${
      Object.entries(usage)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ') || 'no user resources'
    }`,
  );
  if (r.duplicates.length > 0) lines.push(`Duplicates: ${r.duplicates.length} groups of identical files`);
  if (r.media.note) lines.push(`Media: ${r.media.note}`);
  const bySeverity = (s: string): number => r.diagnostics.filter((d) => d.severity === s).length;
  lines.push(`Diagnostics: ${bySeverity('error')} errors, ${bySeverity('warning')} warnings, ${bySeverity('info')} info`);
  for (const d of r.diagnostics.filter((x) => x.severity === 'error' || x.severity === 'warning').slice(0, 20)) {
    const l = d.location;
    const where = l
      ? [l.entry, l.pageName && `page "${l.pageName}"`, l.ideviceType && `${l.ideviceType} ${l.ideviceId ?? ''}`.trim(), l.field, l.jsonPath]
          .filter(Boolean)
          .join(' › ')
      : '';
    lines.push(`  ${d.severity === 'error' ? '✗' : '!'} [${d.code}] ${d.message}${where ? ` (${where})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
