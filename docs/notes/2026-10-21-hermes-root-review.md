# Hermes root initialization review

Baseline: `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779` (fresh origin/main).
Issue: https://github.com/Ancienttwo/byok-sdk/issues/598

This bounded review inspected recent Hermes adapter lifecycle/configuration code
and the new MCP example task, routine, and memory handlers. No open issues or PRs
were present at review start; historical searches found no duplicate for this
Hermes initialization race. No other finding is claimed by this pass.

`ensureHermesRoot()` used a PID-and-millisecond temporary filename. Concurrent
admission/detection calls on a fresh root could therefore share the same file,
and one caller's rename caused other callers to reject with ENOENT. The new
regression pins Date.now() to model one clock tick and uses 16 real concurrent
filesystem calls. On the baseline, 15 calls rejected. With a UUID filename and
exclusive create per writer, all calls succeed, config.yaml remains complete,
and no temporary files remain. Atomic rename and restrictive file mode remain.

Evidence was collected on macOS with Node 24.18.0 and Bun 1.4.3. The regression
requires no Hermes install or provider credentials; it establishes the filesystem
race rather than its production frequency. Cross-platform CI remains necessary.
