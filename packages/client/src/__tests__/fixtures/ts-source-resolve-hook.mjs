// Lets a plain `node` subprocess import this package's TypeScript SOURCE.
//
// Two Node features do the work and neither is a new dependency: type
// stripping (on by default since 22.18; `.node-version` pins 24.21.0) erases the
// annotations, and `module.registerHooks` (22.15+) supplies the one thing
// stripping does not — Node's ESM resolver never guesses extensions, and this
// package's own imports are extensionless (`'../runtime-failure'`).
//
// It exists because the host-exit backstop can only be proven by a REAL
// `process.exit()` in a real process, which the vitest worker cannot perform on
// itself, and the module under test is `.ts`. Import specifiers are recorded to
// `BYOK_RESOLVE_LOG` when set, which is how the koffi-isolation test proves a
// non-win32 adoption never resolves the native module at all.

import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const resolveLog = process.env.BYOK_RESOLVE_LOG;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (resolveLog) appendFileSync(resolveLog, `${specifier}\n`);
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a TypeScript sibling; fall through to Node's own answer below.
      }
    }
    // The vendored OAR source imports its TypeScript siblings as `.js`, the
    // TypeScript convention; resolve a missing `.js` to its `.ts` sibling.
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
