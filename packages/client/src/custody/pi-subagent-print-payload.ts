/**
 * WP4 print payload (`custody/pi-subagent-print-payload.ts`) — the re-entry
 * point the print entry invokes on a self-reentrant dispatch. Deliberately
 * THIN: the real leaf executor lives behind the `#byok-pi-runtime-host`
 * seam (`bin/custody-print-payload-host.ts`), which carries the pi session
 * machinery and the vendored subagents extension. This module is part of the
 * library root's bundle graph (index re-exports the helper host, which
 * re-exports the custody entries), and the bundler hoists external imports
 * of every module in a chunk — so any static pi import here would make every
 * `@byok-sdk/client` consumer eagerly load the whole native graph. The
 * external-dynamic import below stays a real lazy `import()` in every
 * bundle.
 */
import type { DescendantLaunchV1 } from '@byok-sdk/implementation-identity';

export async function runPiSubagentPrintPayload(launch: DescendantLaunchV1): Promise<number> {
  const host = await import('#byok-pi-runtime-host');
  return host.runCustodyPrintPayload(launch);
}
