# MCP metadata and progress (#631)

Baseline: `742295a4a97a8c1de5b2ab55c827ac2f73cb07cc`.

Both transports preserve caller-owned tool title, annotations and output schema.
Progress is scoped to the live request token. HTTP uses a bounded POST SSE stream;
GET/list-change behavior and the separately reviewed stateless work remain unchanged.
No live providers, credentials or task-control changes are involved.

## Evidence

- Exact baseline source fails all four new official-client metadata regressions
  (stdio and HTTP, protocol 2025-11-25 and 2025-06-18).
- Final affected suites: 118 passed, five existing memory-platform tests skipped
  by their existing Linux/secure-filesystem predicates on this Mac. No skip
  conditions were added or changed. Full workspace suite is left to CI.
- Workspace build and typecheck passed; final client rebuild, API surface and
  version-authority checks passed. HTTP entry closure is 34179 bytes; only its
  prior 32768-byte budget changed to the exact measured new feature size.
- Original unchanged HTTP suite on exact baseline: 21 passed, one failed plus
  cleanup rejection. Its concurrent-client cancellation test assumed request
  arrival order. The patch identifies calls by explicit client labels and retains
  both aborted/non-aborted assertions; final affected suites pass.
- Official client 2.0.0 notification callbacks can race immediate result token
  retirement. Deterministic fixture acknowledgements test active work stages;
  separate raw-core tests assert unpaced progress frames and final ordering.
  This client limitation is documented publicly rather than claimed repaired.
- Independent review found silent SSE EOF on abnormal shutdown/overflow. Fixed
  to error unfinished streams. The unread-response test drains core writes and
  proves only the affected call aborts while same-session ping remains usable.
  Independent final review approved with no remaining findings.

Local evidence is retained outside Git under the task workspace as
`evidence-631-*.log`, including baseline failures and initial unsuccessful runs.
An initial sandbox test run was interrupted while stalled; its cause was not
established. Final socket tests ran with local socket permissions. No full-suite
pass or other-platform qualification is claimed here.
