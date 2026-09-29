import { validateArchive } from '../../core/validate/validate.js';
import { EXIT, type ExitCode } from '../exit-codes.js';
import { printJson, type CliIO } from '../io.js';
import { limitsFromFlags, openInputArg } from '../shared.js';

/** validate: integrity, references and packaging verdict. */
export async function runValidate(positionals: string[], values: Record<string, unknown>, io: CliIO): Promise<ExitCode> {
  const { source, name } = await openInputArg(positionals, io);
  try {
    const result = await validateArchive(source, { limits: limitsFromFlags(values), inputName: name, ...(io.signal ? { signal: io.signal } : {}) });
    if (values['json']) printJson(io, result);
    else {
      io.stdout(`${name}: ${result.verdict}\n`);
      for (const c of result.checks) io.stdout(`  ${c.status === 'passed' ? '✓' : c.status === 'not-run' ? '–' : '✗'} ${c.name}: ${c.detail}\n`);
      for (const d of result.diagnostics.filter((x) => x.severity !== 'info').slice(0, 30)) io.stdout(`  - [${d.severity}] ${d.code}: ${d.message}\n`);
    }
    if (result.verdict === 'unusable') return EXIT.INVALID_INPUT;
    if (result.verdict === 'invalid') return EXIT.PARTIAL;
    if (result.verdict === 'valid-with-warnings' && values['strict']) return EXIT.PARTIAL;
    return EXIT.SUCCESS;
  } finally {
    await source.close();
  }
}
