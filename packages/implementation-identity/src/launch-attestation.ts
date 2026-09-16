export type ResolvedMcpLaunchCwdLauncher =
  /** POSIX: `interpreter` is the realpath of the system shell, `script` is the client-owned shell bootstrap. */
  | { readonly kind: 'shell'; readonly interpreter: string; readonly script: string }
  /** win32: `interpreter` is a plain-Node executable, `script` is this package's `bin/byok-launch-cwd.mjs`. */
  | { readonly kind: 'node'; readonly interpreter: string; readonly script: string };

export interface McpLaunchAttestation {
  readonly launchCwd: string;
  readonly launcher: ResolvedMcpLaunchCwdLauncher | null;
}
