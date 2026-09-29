import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_NAME, TOOL_VERSION, UPSTREAM_SHA } from '../../core/version.js';
import { NativeMediaEngine } from '../../adapters/node/native-media-engine.js';
import { NodeResourceStore } from '../../adapters/node/resource-store.js';
import { runProcess } from '../../adapters/node/process.js';
import { EXIT, type ExitCode } from '../exit-codes.js';
import { printJson, type CliIO } from '../io.js';
import { webRoot } from './serve.js';
import { inspectPdf } from '../../core/media/pdf-policy.js';

/** A valid one-page PDF (with a correct cross-reference table) for the qpdf smoke test. */
export function minimalPdf(): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** Checks tools and real capabilities (a tiny encode with each engine). */
export async function runDoctor(values: Record<string, unknown>, io: CliIO): Promise<ExitCode> {
  const store = await NodeResourceStore.create();
  const tools = {
    ...(typeof values['ffmpeg'] === 'string' ? { ffmpeg: values['ffmpeg'] } : {}),
    ...(typeof values['ffprobe'] === 'string' ? { ffprobe: values['ffprobe'] } : {}),
  };
  const engine = new NativeMediaEngine(store, { tools });
  try {
    const info = await engine.info();
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    // Real video smoke test: encode 0.5 s with libx264 and probe it.
    if (info.video.available) {
      const dir = await mkdtemp(join(tmpdir(), 'elpx-doctor-'));
      try {
        const out = join(dir, 'smoke.mp4');
        const ffmpegPath = engine.ffmpegPath!;
        const r = await runProcess(
          ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=64x64:rate=10',
            '-t',
            '0.5',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-y',
            out,
          ],
          { timeoutMs: 30_000, cwd: dir },
        );
        // An ffmpeg that exits 0 without writing the file fails the check (it must not crash doctor).
        const size =
          r.code === 0
            ? await stat(out).then(
                (s) => s.size,
                () => 0,
              )
            : 0;
        const probed =
          size > 0
            ? await engine.probe(store.adopt(out, 'smoke.mp4', size), { resourcePath: 'smoke', timeoutMs: 30_000 }).then(
                () => true,
                () => false,
              )
            : false;
        checks.push({
          name: 'video-encode',
          ok: probed,
          detail: probed ? 'libx264 encode and ffprobe succeeded' : `ffmpeg smoke test failed: ${r.stderr.split('\n')[0] ?? ''}`,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      checks.push({ name: 'video-encode', ok: false, detail: info.video.reason ?? 'unavailable' });
    }
    // Real audio smoke test (independent of libx264): encode 0.3 s of tone with the first audio encoder.
    const audioEncoder = info.audio?.encoders.find((e) => e === 'libmp3lame' || e === 'aac');
    if (info.audio?.available && audioEncoder) {
      const dir = await mkdtemp(join(tmpdir(), 'elpx-doctor-'));
      try {
        const name = audioEncoder === 'libmp3lame' ? 'smoke.mp3' : 'smoke.m4a';
        const out = join(dir, name);
        const r = await runProcess(
          engine.ffmpegPath!,
          ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:a', audioEncoder, '-y', out],
          { timeoutMs: 30_000, cwd: dir },
        );
        const size =
          r.code === 0
            ? await stat(out).then(
                (s) => s.size,
                () => 0,
              )
            : 0;
        const probed =
          size > 0
            ? await engine.probe(store.adopt(out, name, size), { resourcePath: 'smoke', timeoutMs: 30_000 }).then(
                () => true,
                () => false,
              )
            : false;
        checks.push({
          name: 'audio-encode',
          ok: probed,
          detail: probed ? `${audioEncoder} encode and ffprobe succeeded` : `ffmpeg audio smoke test failed: ${r.stderr.split('\n')[0] ?? ''}`,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      checks.push({ name: 'audio-encode', ok: false, detail: info.audio?.reason ?? 'unavailable' });
    }
    // PDF smoke test: qpdf (WebAssembly) inspects a generated one-page PDF.
    if (info.pdf?.available) {
      const ok = await inspectPdf({ runQpdf: engine.runQpdf.bind(engine) }, minimalPdf(), { resourcePath: 'smoke.pdf', timeoutMs: 30_000 }).then(
        (p) => p.pages === 1,
        () => false,
      );
      checks.push({ name: 'pdf-rewrite', ok, detail: ok ? `${info.pdf.engine ?? 'qpdf'} read a test PDF` : 'qpdf smoke test failed' });
    } else {
      checks.push({ name: 'pdf-rewrite', ok: false, detail: info.pdf?.reason ?? 'unavailable' });
    }
    if (info.image.available) {
      try {
        const png = new Uint8Array(
          Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwgbGGAMAEBXBvusDhdaAAAAAElFTkSuQmCC', 'base64'),
        );
        await engine.encodeImage(
          png,
          {
            format: 'png',
            mode: 'lossless',
            quality: undefined,
            resize: undefined,
            metadata: { keepIcc: true, keepExif: true, keepXmp: true, keepIptc: true, keepText: true },
            expected: { width: 2, height: 2, hasAlpha: true },
            conversions: [],
          },
          { resourcePath: 'smoke', timeoutMs: 30_000 },
        );
        checks.push({ name: 'image-encode', ok: true, detail: 'sharp encode succeeded' });
      } catch (error) {
        checks.push({ name: 'image-encode', ok: false, detail: (error as Error).message });
      }
    } else {
      checks.push({ name: 'image-encode', ok: false, detail: info.image.reason ?? 'unavailable' });
    }
    const web = await webRoot(undefined, io).then(
      (r) => ({ available: true, root: r.relative }),
      () => ({ available: false, root: '' }),
    );
    const runtime = {
      bun: (process.versions as Record<string, string | undefined>)['bun'],
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    };
    const allOk = checks.every((c) => c.ok);
    const result = {
      schema: 'elpx-optimizer/doctor',
      schemaVersion: 1,
      ok: allOk,
      tool: { name: TOOL_NAME, version: TOOL_VERSION, upstreamSha: UPSTREAM_SHA },
      runtime,
      versions: info.versions,
      capabilities: {
        inspect: { available: true },
        validate: { available: true },
        video: {
          available: info.video.available && checks.find((c) => c.name === 'video-encode')!.ok,
          encoders: info.video.encoders,
          ...(info.video.reason ? { reason: info.video.reason } : {}),
        },
        audio: {
          available: (info.audio?.available ?? false) && checks.find((c) => c.name === 'audio-encode')!.ok,
          encoders: info.audio?.encoders ?? [],
          ...(info.audio?.reason ? { reason: info.audio.reason } : {}),
        },
        pdf: {
          available: (info.pdf?.available ?? false) && checks.find((c) => c.name === 'pdf-rewrite')!.ok,
          ...(info.pdf?.engine ? { engine: info.pdf.engine } : {}),
          ...(info.pdf?.reason ? { reason: info.pdf.reason } : {}),
        },
        image: {
          available: info.image.available && checks.find((c) => c.name === 'image-encode')!.ok,
          encoders: info.image.encoders,
          ...(info.image.reason ? { reason: info.image.reason } : {}),
        },
        web: web,
      },
      checks,
      notes: info.notes,
    };
    if (values['json']) printJson(io, result);
    else {
      const line = (ok: boolean, text: string): string => `${ok ? '✓' : '✗'} ${text}\n`;
      io.stdout(`${TOOL_NAME} ${TOOL_VERSION} on ${runtime.bun ? `Bun ${runtime.bun}` : `Node ${runtime.node}`} (${runtime.platform}/${runtime.arch})\n`);
      io.stdout(line(true, 'inspect / validate: available (no external tools needed)'));
      io.stdout(
        line(
          result.capabilities.video.available,
          `video: ${result.capabilities.video.available ? `ffmpeg ${info.versions['ffmpeg']}, ffprobe ${info.versions['ffprobe']}, encoders ${info.video.encoders.join(', ')}` : (info.video.reason ?? 'unavailable')}`,
        ),
      );
      io.stdout(
        line(
          result.capabilities.audio.available,
          `audio: ${result.capabilities.audio.available ? `encoders ${result.capabilities.audio.encoders.join(', ')}` : (info.audio?.reason ?? 'unavailable')}`,
        ),
      );
      io.stdout(
        line(
          result.capabilities.image.available,
          `images: ${result.capabilities.image.available ? `sharp ${info.versions['sharp']} (libvips ${info.versions['libvips']})` : (info.image.reason ?? 'unavailable')}`,
        ),
      );
      io.stdout(
        line(
          result.capabilities.pdf.available,
          `pdf: ${result.capabilities.pdf.available ? (info.pdf?.engine ?? 'qpdf') : (info.pdf?.reason ?? 'unavailable')}`,
        ),
      );
      io.stdout(line(web.available, `web app: ${web.available ? `static files in ${web.root}` : 'dist/web not built (run: make build-web)'}`));
      for (const n of info.notes) io.stdout(`  note: ${n}\n`);
    }
    return allOk ? EXIT.SUCCESS : EXIT.DEPENDENCY;
  } finally {
    await store.disposeAll();
  }
}
