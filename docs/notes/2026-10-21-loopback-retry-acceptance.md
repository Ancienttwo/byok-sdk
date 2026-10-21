# Issue #613 acceptance follow-up

Baseline: main 80a340836fe38abec718e2980d39d91b33964ac4, including PR #638
(merge 95357bb07ba7b1b45a75ba463a170a75af435bd1).

P1: `listenLoopback` owns the native HTTP listener and immutable port-store
handoff. The package root exports it; server README and Topology L guide use it.
P2: a fresh identity draws a candidate, the OS bind can reject EADDRINUSE,
then the helper closes that server and tries another untried candidate before
claiming. Existing tests only proved exhaustion of a one-port occupied range;
they did not directly prove successful retry or failed callback cleanup.
P3: add one real-socket test without changing product behavior. Hold two adjacent
ports so either first random choice must collide. On the actual kernel error,
release only its neighbour. Observe the real listen calls via a pass-through
spy, retaining native RNG, actual sockets and HTTP dispatch. Assert a different
second port, exactly one claim of that port, HTTP success, closed failed server,
and removal of SDK bind callbacks. Native Node `setupConnectionsTracking`
listeners remain; the assertion compares to a newly created HTTP server's
native listener inventory rather than requiring an incorrectly empty list.

The previous implementation and all existing assertions remain unchanged.
The fixture bounds its search for an available adjacent pair to 16 attempts;
this is not a timeout increase or a substitute for real socket evidence.

Main merge CI already passed the original suite across all three platforms:
- https://github.com/Ancienttwo/byok-sdk/actions/runs/39542244558/job/119032782821 (Linux)
- https://github.com/Ancienttwo/byok-sdk/actions/runs/39542244558/job/119032782964 (macOS)
- https://github.com/Ancienttwo/byok-sdk/actions/runs/39542244558/job/119032782839 (Windows)

Local macOS arm64 / Node 24.18.0 / Bun 1.4.3: loopback 10/10 and native MCP
loopback 1/1 passed; workspace build, typecheck, API surface and version authority
passed. The new case is in the existing loopback file selected by the three-OS
CI matrix. Hosted evidence for this additional assertion remains pending.
No issue was closed. Browser-origin allowlists remain outside the issue's
native-client acceptance contract.
