import { defineConfig } from 'vitest/config';

// @byok-sdk/client is the only package whose suite drives real operating-system
// resources: it spawns the real `byok-agent` CLI as a child process, binds real
// Unix domain sockets / named pipes, and probes a user-installed `pi` binary
// when present. Those tests are wall-clock sensitive in a way pure in-process tests
// are not -- when the machine is busy, a spawn that normally settles in well
// under a second can take several.
//
// vitest's 5000ms default was already known to be too tight here: five of the
// twelve tests in src/__tests__/daemon-control-socket.test.ts carry an inline
// `}, 10000)` for exactly this reason. The remaining seven in that file, and all
// fifteen in src/__tests__/pi-adapter.test.ts, were left on the default and are
// the ones observed failing with "Test timed out in 5000ms" under load.
//
// Setting the package-wide floor to the same 10000ms the suite's own author
// already chose makes that headroom uniform instead of per-test-remembered. This
// only changes how long a genuinely hung test waits before failing; no assertion
// or test logic is affected, and inline per-test timeouts still take precedence.
export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
});
