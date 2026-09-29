/**
 * CLI exit codes (documented in docs/cli.md).
 *
 * - SUCCESS: the command did what was asked. For optimize this includes
 *   "no-improvement" (a byte copy of the input was delivered) and dry runs;
 *   for validate it includes projects with warnings only.
 * - FAILURE: an operational error (I/O, failed validation of our own output).
 * - USAGE: invalid flags, missing arguments, output already exists.
 * - INVALID_INPUT: the input is not a usable .elpx (not a ZIP, legacy .elp,
 *   corrupt, unsafe or beyond limits).
 * - PARTIAL: optimize delivered a valid, smaller file but some operations
 *   failed (their originals were kept); validate found errors such as
 *   missing resources (or warnings with --strict).
 * - DEPENDENCY: doctor found no usable media engine, or a required tool is
 *   missing for an explicitly requested operation.
 * - CANCELLED: interrupted (SIGINT/SIGTERM); nothing was delivered.
 */
export const EXIT = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  INVALID_INPUT: 3,
  PARTIAL: 4,
  DEPENDENCY: 5,
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
