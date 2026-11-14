// Temporary #2206 phase measurements; remove with the diagnostic commit.
export function memoryTestTiming(scope: string): (phase: string) => void {
  const started = performance.now();
  let previous = started;
  return phase => {
    const at = performance.now();
    process.stderr.write(`[memory-timing] ${JSON.stringify({ pid: process.pid, scope, phase, at, ms: at - started, deltaMs: at - previous })}\n`);
    previous = at;
  };
}
