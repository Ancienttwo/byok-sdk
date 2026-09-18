/**
 * Self-reentry detection for the custody payload entries (`custody/
 * custody-self-reentry.ts`).
 *
 * The dispatcher mints every child template over THIS bundle's helper
 * re-entry (`node <runtime> __byok_sdk_helper <kind>`). When a validated
 * child entry finds that the record's template describes exactly the process
 * it is running in — same interpreter, same entry script, same argv tail,
 * same cwd — execing the template again would be an infinite trampoline, so
 * the entry runs the payload in-process instead. Any other template (a
 * foreign target, a different bundle, a test stub) keeps the trampoline exec.
 *
 * The check is deliberately exact: every compared fact is one the spawn
 * validator already attested, re-measured against the running process.
 */
import { realpathSync } from 'node:fs';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';

export function isSelfReentrySpawn(template: ImplementationSpawnBindingV1): boolean {
  try {
    if (template.command !== realpathSync(process.execPath)) return false;
    const argv1 = process.argv[1] !== undefined ? realpathSync(process.argv[1]) : undefined;
    if (template.entry === undefined) {
      if (argv1 !== undefined && argv1 !== template.command) return false;
    } else if (argv1 !== template.entry) {
      return false;
    }
    if (template.cwd !== process.cwd()) return false;
    const tail = process.argv.slice(2);
    if (tail.length !== template.fixedArgv.length) return false;
    return template.fixedArgv.every((argument, index) => argument === tail[index]);
  } catch {
    return false;
  }
}
