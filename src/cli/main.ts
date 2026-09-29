import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ElpxError, errorMessage } from '../core/errors.js';
import { TOOL_NAME, TOOL_VERSION, UPSTREAM_VERSION } from '../core/version.js';
import { EXIT, type ExitCode } from './exit-codes.js';
import type { CliIO } from './io.js';
import { runDoctor } from './commands/doctor.js';
import { runInspect } from './commands/inspect.js';
import { runValidate } from './commands/validate.js';
import { runOptimize } from './commands/optimize.js';
import { runServe } from './commands/serve.js';

export const HELP = `${TOOL_NAME} ${TOOL_VERSION} — analyze and shrink eXeLearning .elpx projects

Usage:
  ${TOOL_NAME} <command> [options]

Commands:
  doctor                      Check dependencies and real capabilities
  inspect <file.elpx>         Analyze a project without modifying it
  validate <file.elpx>        Check integrity, references and packaging
  optimize <file.elpx>        Recompress media and clean up (see --dry-run)
  serve                       Serve the static web app (no upload API)

Global options:
  --json                      Print one JSON document on stdout (logs go to stderr)
  --quiet                     No progress or messages on stderr
  --help, -h                  Show help (also: ${TOOL_NAME} <command> --help)
  --version, -v               Show version

Examples:
  ${TOOL_NAME} doctor
  ${TOOL_NAME} inspect "curso.elpx" --json
  ${TOOL_NAME} validate "curso.elpx" --json
  ${TOOL_NAME} optimize "curso.elpx" --preset balanced --dry-run --json
  ${TOOL_NAME} optimize "curso.elpx" --preset balanced \\
      --remove-unused safe --deduplicate exact \\
      --output "curso_optimized.elpx" --report "curso_optimization.json"
  ${TOOL_NAME} serve --host 127.0.0.1 --port 8080

Exit codes: 0 success, 1 failure, 2 usage error, 3 invalid input,
4 partial result / validation errors, 5 missing dependency, 130 cancelled.
`;

const COMMAND_HELP: Record<string, string> = {
  doctor: `Usage: ${TOOL_NAME} doctor [--json] [--ffmpeg PATH] [--ffprobe PATH]

Checks the runtime, FFmpeg/ffprobe (version and encoders), sharp/libvips and
the static web build. Inspecting projects never requires FFmpeg.
`,
  inspect: `Usage: ${TOOL_NAME} inspect <file.elpx> [options]

Options:
  --json                Print the analysis as JSON
  --no-probe            Do not inspect videos with ffprobe
  --no-references       Omit the reference list from the JSON output
  --ffprobe PATH        ffprobe binary (default: ELPX_OPTIMIZER_FFPROBE or PATH)
  --ffmpeg PATH         ffmpeg binary (default: ELPX_OPTIMIZER_FFMPEG or PATH)
  --max-archive-size N  Limit in bytes (default 16 GiB)
`,
  validate: `Usage: ${TOOL_NAME} validate <file.elpx> [--json] [--strict]

Exit code 0 when valid (warnings allowed unless --strict), 4 when the project
has errors (e.g. missing resources), 3 when it cannot be analyzed.
`,
  optimize: `Usage: ${TOOL_NAME} optimize <file.elpx> [options]

Output:
  --output PATH              Output file (default: <name>_optimized.elpx next to the input)
  --overwrite                Allow replacing an existing output file (never the input)
  --report PATH              Also write the JSON report to PATH
  --dry-run                  Only compute and print the plan
  --json                     Print the report (or plan) as JSON

Selection:
  --preset NAME              conservative | balanced (default) | maximum (alias: aggressive)
  --no-video                 Do not touch videos
  --no-images                Do not touch images
  --no-audio                 Do not touch audio files
  --remove-unused MODE       off (default) | safe
  --deduplicate MODE         off (default) | exact
  --flatten MODE             off (default) | legacy: move files out of eXeLearning 3
                             folders (content/resources/<ODE-ID>/) into content/resources/
  --missing-references MODE  keep (default) | remove: take out references to files
                             that do not exist (images deleted, links keep their text)
  --normalize-names MODE     off (default) | slug: clean file names (lower case, no
                             spaces, accents or copy markers); references are rewritten
  --exclude PATH             Keep this ZIP path untouched (repeatable)
  --config FILE              JSON file with options (same keys as the web app)

Video:
  --video-crf N              16-35 (profile default: 20/23/28)
  --video-max-resolution R   360 | 480 | 720 | 1080 | 1440 | 2160 | original
  --video-audio-bitrate N    kb/s for audio that must be converted (64-320)
  --video-x264-preset NAME   ultrafast ... veryslow
  --video-force              Re-encode even sources that already look efficient
  --video-drop-data-streams  Allow dropping timecode/telemetry streams

Images:
  --image-quality N          JPEG quality (30-100)
  --webp-quality N           WebP quality (30-100)
  --image-max-dimension N    Downscale larger images (N px; default 2560/1920/1600), or "none"
  --no-png                   Do not recompress PNG
  --strip-metadata           Remove EXIF/XMP/IPTC/text (ICC always kept)
  --image-force              Re-encode images that already look efficient
  --include-screenshot       Also optimize screenshot.png (lossless only)

Audio (WAV, AIFF and FLAC become MP3 with the .mp3 extension; references are rewritten):
  --audio-bitrate N          kb/s for stereo, mono uses half (64-320; default 192/128/96)
  --audio-force              Re-encode MP3/M4A even when their bitrate is close to the target
  --min-savings-percent N    Minimum saving to replace a resource (default 5)
  --min-savings-bytes N      Minimum saving in bytes (default 1024; videos 10240)

Resources:
  --threads N                FFmpeg encoder threads
  --image-concurrency N      Parallel image jobs
  --timeout-video SECONDS    Per-video time limit
  --max-archive-size N       Input size limit in bytes
  --max-video-size N         Largest video processed (bytes)
  --temp-dir DIR             Where temporary files are created
  --ffmpeg PATH / --ffprobe PATH
`,
  serve: `Usage: ${TOOL_NAME} serve [--host 127.0.0.1] [--port 8080] [--root DIR] [--base /path/] [--isolation]

Serves only the static web app (dist/web). There is no upload or processing
API: projects are processed in the visitor's browser. --isolation adds
COOP/COEP headers so the optional multi-threaded FFmpeg core can be used.
`,
};

type Handler = (positionals: string[], values: Record<string, unknown>, io: CliIO) => Promise<ExitCode>;

const COMMANDS: Record<string, { options: NonNullable<ParseArgsConfig['options']>; handler: Handler }> = {
  doctor: {
    options: { ffmpeg: { type: 'string' }, ffprobe: { type: 'string' } },
    handler: (_p, v, io) => runDoctor(v, io),
  },
  inspect: {
    options: {
      'no-probe': { type: 'boolean' },
      'no-references': { type: 'boolean' },
      ffmpeg: { type: 'string' },
      ffprobe: { type: 'string' },
      'max-archive-size': { type: 'string' },
    },
    handler: (p, v, io) => runInspect(p, v, io),
  },
  validate: {
    options: { strict: { type: 'boolean' }, 'max-archive-size': { type: 'string' } },
    handler: (p, v, io) => runValidate(p, v, io),
  },
  optimize: {
    options: {
      preset: { type: 'string' },
      'dry-run': { type: 'boolean' },
      output: { type: 'string', short: 'o' },
      overwrite: { type: 'boolean' },
      report: { type: 'string' },
      config: { type: 'string' },
      'no-video': { type: 'boolean' },
      'no-images': { type: 'boolean' },
      'remove-unused': { type: 'string' },
      deduplicate: { type: 'string' },
      flatten: { type: 'string' },
      'no-audio': { type: 'boolean' },
      'audio-bitrate': { type: 'string' },
      'audio-force': { type: 'boolean' },
      'missing-references': { type: 'string' },
      'normalize-names': { type: 'string' },
      exclude: { type: 'string', multiple: true },
      'video-crf': { type: 'string' },
      'video-max-resolution': { type: 'string' },
      'video-audio-bitrate': { type: 'string' },
      'video-x264-preset': { type: 'string' },
      'video-force': { type: 'boolean' },
      'video-drop-data-streams': { type: 'boolean' },
      'image-quality': { type: 'string' },
      'webp-quality': { type: 'string' },
      'image-max-dimension': { type: 'string' },
      'no-png': { type: 'boolean' },
      'strip-metadata': { type: 'boolean' },
      'image-force': { type: 'boolean' },
      'include-screenshot': { type: 'boolean' },
      'min-savings-percent': { type: 'string' },
      'min-savings-bytes': { type: 'string' },
      threads: { type: 'string' },
      'image-concurrency': { type: 'string' },
      'timeout-video': { type: 'string' },
      'max-archive-size': { type: 'string' },
      'max-video-size': { type: 'string' },
      'temp-dir': { type: 'string' },
      ffmpeg: { type: 'string' },
      ffprobe: { type: 'string' },
    },
    handler: (p, v, io) => runOptimize(p, v, io),
  },
  serve: {
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      root: { type: 'string' },
      base: { type: 'string' },
      isolation: { type: 'boolean' },
    },
    handler: (_p, v, io) => runServe(v, io),
  },
};

const GLOBAL_OPTIONS: NonNullable<ParseArgsConfig['options']> = {
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' },
};

/** Runs the CLI with the given arguments; returns the exit code. */
export async function main(argv: readonly string[], io: CliIO): Promise<ExitCode> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    (command === undefined ? io.stderr : io.stdout)(HELP);
    return command === undefined ? EXIT.USAGE : EXIT.SUCCESS;
  }
  if (command === '--version' || command === '-v') {
    io.stdout(`${TOOL_NAME} ${TOOL_VERSION} (eXeLearning format ${UPSTREAM_VERSION})\n`);
    return EXIT.SUCCESS;
  }
  const spec = COMMANDS[command];
  if (!spec) {
    io.stderr(`Unknown command "${command}". Run "${TOOL_NAME} --help".\n`);
    return EXIT.USAGE;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: [...rest], options: { ...GLOBAL_OPTIONS, ...spec.options }, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`${errorMessage(error)}\nRun "${TOOL_NAME} ${command} --help".\n`);
    return EXIT.USAGE;
  }
  if (parsed.values['help']) {
    io.stdout(COMMAND_HELP[command] ?? HELP);
    return EXIT.SUCCESS;
  }
  if (parsed.values['version']) {
    io.stdout(`${TOOL_NAME} ${TOOL_VERSION}\n`);
    return EXIT.SUCCESS;
  }
  try {
    return await spec.handler(parsed.positionals, parsed.values as Record<string, unknown>, io);
  } catch (error) {
    if (error instanceof ElpxError) {
      if (error.code === 'invalid-options') {
        io.stderr(`Invalid options: ${error.message}\n`);
        return EXIT.USAGE;
      }
      if (error.code === 'cancelled') {
        io.stderr('Cancelled.\n');
        return EXIT.CANCELLED;
      }
      if (error.code === 'output-exists') {
        io.stderr(`${error.message}\n`);
        return EXIT.USAGE;
      }
    }
    io.stderr(`Error: ${errorMessage(error)}\n`);
    return EXIT.FAILURE;
  }
}
