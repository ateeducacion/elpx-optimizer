import { main } from './main.js';

/** Process entry point: wires real I/O, signals and the exit code. */
async function run(): Promise<void> {
  const controller = new AbortController();
  let interrupted = 0;
  const onSignal = (): void => {
    interrupted++;
    if (interrupted > 1) process.exit(130);
    process.stderr.write('\nCancelling (press Ctrl+C again to force)...\n');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const code = await main(process.argv.slice(2), {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
    interactive: process.stderr.isTTY === true,
    signal: controller.signal,
  });
  process.exitCode = controller.signal.aborted && code !== 0 ? 130 : code;
}

void run();
