/**
 * Node rejects a NUL-bearing spawn input with an error that quotes it escaped, which
 * literal credential redaction misses, so only the slot is named (#2008, #2043).
 * Env is walked with `for...in` because Node reads inherited enumerable keys too.
 * `@byok-sdk/keys` keeps the same rule privately for its custody spawn. It lives outside
 * `process-tree` so runtime tests that mock the tree authority keep the check.
 */
export function assertNoNulSpawnInput(command: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): void {
  if (command.includes('\0')) throw new Error('spawn command contains a NUL byte');
  args.forEach((arg, index) => { if (arg.includes('\0')) throw new Error(`spawn argument ${index} contains a NUL byte`); });
  for (const name in env) {
    if (name.includes('\0')) throw new Error('spawn env variable name contains a NUL byte');
    if (env[name]?.includes('\0')) throw new Error(`spawn env variable ${name} contains a NUL byte`);
  }
}
