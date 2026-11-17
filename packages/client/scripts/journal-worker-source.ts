import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

/**
 * `src/daemon/journal/journal-worker.ts` as one CommonJS string, started with
 * `new Worker(source, { eval: true })` (#2332). The journal ships inside every
 * bundle of the client (this package's tsup output, a Host's single-file
 * bundle, a SEA), where no worker file would sit beside it, so the worker
 * inlines everything except Node builtins. tsup and vitest both define
 * `__BYOK_JOURNAL_WORKER_SOURCE__` from this one function.
 *
 * The bundle needs only Node builtins, and it gets them from
 * `process.getBuiltinModule`, not from the `require` an eval worker may or may
 * not have (a Node SEA restricts it). A failure while the bundle loads (before
 * its own open handshake can run) is reported through that handshake, so the
 * constructor fails at once instead of waiting out its timeout.
 */
export function journalWorkerSource(): string {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/daemon/journal/journal-worker.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
    minifyWhitespace: true,
    legalComments: 'inline',
    logLevel: 'warning',
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error('journal worker bundle produced no output');
  return [
    '(function (require) {',
    'try {',
    output.text,
    '} catch (error) {',
    "  const { workerData } = require('node:worker_threads');",
    '  workerData.port.postMessage({ ok: false, closed: true, error: { name: String(error && error.name), message: String(error && error.message), stack: String(error && error.stack) } });',
    '  Atomics.store(workerData.signal, 0, 1);',
    '  Atomics.notify(workerData.signal, 0);',
    '}',
    '})((id) => {',
    '  const builtin = process.getBuiltinModule(id);',
    "  if (builtin === undefined) throw new Error('the journal worker requires only Node builtins; ' + id + ' is not one');",
    '  return builtin;',
    '});',
    '',
  ].join('\n');
}

/** The same definition as a `bun build` argument, for test fixtures that bundle client source themselves. */
export function journalWorkerBunDefine(): string {
  return `--define=__BYOK_JOURNAL_WORKER_SOURCE__=${JSON.stringify(journalWorkerSource())}`;
}
