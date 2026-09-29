/**
 * I/O abstraction for the CLI so commands can run in-process in tests.
 * stdout carries only the command result (a single JSON document with
 * --json); progress and human messages go to stderr.
 */
export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** True when stderr is a terminal (enables progress lines). */
  readonly interactive: boolean;
  /** Aborted on SIGINT/SIGTERM. */
  readonly signal?: AbortSignal;
}

/** Writes a single JSON document to stdout. */
export function printJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/** Creates a stderr logger honouring --quiet. */
export function logger(io: CliIO, quiet: boolean): (message: string) => void {
  return (message) => {
    if (!quiet) io.stderr(`${message}\n`);
  };
}
