/**
 * Node rejects a NUL-bearing spawn input with an error that quotes it escaped, which
 * literal credential redaction misses, so only the slot is named (#2008, #2043).
 * Env is walked with `for...in` because Node reads inherited enumerable keys too.
 * `@byok-sdk/keys` keeps the same rule privately for its custody spawn. It lives outside
 * `process-tree` so runtime tests that mock the tree authority keep the check, as does
 * `spawnStartError` below.
 */
export function assertNoNulSpawnInput(command: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): void {
  if (command.includes('\0')) throw new Error('spawn command contains a NUL byte');
  args.forEach((arg, index) => { if (arg.includes('\0')) throw new Error(`spawn argument ${index} contains a NUL byte`); });
  for (const name in env) {
    if (name.includes('\0')) throw new Error('spawn env variable name contains a NUL byte');
    if (env[name]?.includes('\0')) throw new Error(`spawn env variable ${name} contains a NUL byte`);
  }
}

/**
 * Node's spawn `error` carries `spawnargs` and `path`, so an argument credential would ride
 * any log or serialization of it; only the code crosses (#2065).
 */
export function spawnStartError(error: NodeJS.ErrnoException): Error & { code?: string } {
  return Object.assign(new Error(`spawn failed: ${error.code ?? 'unknown'}`), { code: error.code });
}
