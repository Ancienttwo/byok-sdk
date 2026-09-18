/**
 * Single authority for reading a print-lane invocation out of the vendor's
 * pi-style argv. The custody dispatcher projects these fields into the minted
 * descendant record (task / model / session file, plus the verbatim argv in
 * the record metadata), and the in-bundle print payload re-derives its
 * runPrintMode options from the same argv via this same parser — the argv is
 * the single source, and the two consumers never drift.
 */
export interface PiPrintArgvProjection {
  /** The `--model` value, when the invocation pinned one. */
  readonly model: string | undefined;
  /** The `--session` value, when the invocation resumed a session file. */
  readonly sessionFile: string | null;
  /** The delegated task: the invocation's prompt positional. */
  readonly task: string;
}

/** Flags whose next argument is a value, not the prompt positional. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--mode', '-m', '--model', '--session', '-s', '--session-dir', '--provider',
  '--thinking', '--tools', '--exclude-tools', '--no-tools', '--config',
]);

/** recognized no-value flags of the print invocation shape. */
const FLAG_NAMES: ReadonlySet<string> = new Set([
  '--mode', '-m', '--model', '--session', '-s', '--session-dir', '--provider',
  '--thinking', '--tools', '--exclude-tools', '--no-tools', '--config',
  '-p', '--print', '--json', '--quiet', '-q', '--verbose', '--no-session',
  '--continue', '--fork-session', '--no-extensions', '--no-skills',
]);

export function parsePiPrintArgv(argv: readonly string[]): PiPrintArgvProjection {
  let model: string | undefined;
  let sessionFile: string | null = null;
  let task = '';
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--model') model = argv[++index];
    else if (argument === '--session') sessionFile = argv[++index] ?? null;
    else if (FLAG_NAMES.has(argument)) {
      if (VALUE_FLAGS.has(argument)) index++;
    } else if (!argument.startsWith('-') && argument !== '') task = argument;
  }
  return { model, sessionFile, task };
}
