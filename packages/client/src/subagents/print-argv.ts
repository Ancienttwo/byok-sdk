/**
 * Single authority for reading a print-lane invocation out of the vendor's
 * pi-style argv. The vendored subagents extension passes that argv to the
 * print child as the tail of its helper argv, and the in-bundle print payload
 * reads its runPrintMode options from it with this parser.
 *
 * The value rules follow the official Pi CLI grammar
 * (`@earendil-works/pi-coding-agent` `dist/cli/args.js`), so a flag reads a
 * value exactly when Pi itself would read one.
 */
export interface PiPrintArgvProjection {
  /** The `--model` value, when the invocation pinned one. */
  readonly model: string | undefined;
  /** The `--session` value, when the invocation resumed a session file. */
  readonly sessionFile: string | null;
  /** The delegated task: the invocation's prompt positional. */
  readonly task: string;
  /**
   * The `@file` argument, when the vendor delivered the task through a file
   * instead of a positional (`pi-args.ts` `shouldDeliverTaskViaFile`).
   */
  readonly taskFile: string | null;
}

/** Pi flags that always read the next argument as their value. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt',
  '--name', '-n', '--session', '--session-id', '--fork', '--session-dir', '--models',
  '--tools', '-t', '--exclude-tools', '-xt', '--thinking', '--export',
  '--extension', '-e', '--skill', '--prompt-template', '--theme',
]);

/** Pi flags that read the next argument only when it is not another flag. */
const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(['--mode', '--use-theme', '--tui-mode']);

/** Pi flags that take no value. */
const NO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--help', '-h', '--version', '-v', '--continue', '-c', '--resume', '-r', '--no-session',
  '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--no-extensions', '-ne', '--no-mcp',
  '--no-skills', '-ns', '--no-prompt-templates', '-np', '--no-themes', '--no-context-files', '-nc',
  '--verbose', '--approve', '-a', '--no-approve', '-na', '--offline',
]);

export function parsePiPrintArgv(argv: readonly string[]): PiPrintArgvProjection {
  let model: string | undefined;
  let sessionFile: string | null = null;
  let task = '';
  let taskFile: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const next = argv[index + 1];
    if (argument === '--model' && next !== undefined) { model = next; index++; }
    else if (argument === '--session' && next !== undefined) { sessionFile = next; index++; }
    else if (VALUE_FLAGS.has(argument)) { if (next !== undefined) index++; }
    else if (OPTIONAL_VALUE_FLAGS.has(argument)) { if (next !== undefined && !next.startsWith('-')) index++; }
    else if (argument === '--list-models') { if (next !== undefined && !next.startsWith('-') && !next.startsWith('@')) index++; }
    else if (argument === '-p' || argument === '--print') {
      // Pi reads the next argument as the message unless it is a flag or a file.
      if (next !== undefined && !next.startsWith('@') && (!next.startsWith('-') || next.startsWith('---'))) { task = next; index++; }
    } else if (NO_VALUE_FLAGS.has(argument)) continue;
    else if (argument.startsWith('@')) taskFile = argument.slice(1);
    else if (argument.startsWith('--')) {
      // An unknown long flag (for example an extension's `--mcp-config`) reads
      // the next argument as its value unless that is a flag or a file.
      if (!argument.includes('=') && next !== undefined && !next.startsWith('-') && !next.startsWith('@')) index++;
    } else if (!argument.startsWith('-') && argument !== '') task = argument;
  }
  return { model, sessionFile, task, taskFile };
}
