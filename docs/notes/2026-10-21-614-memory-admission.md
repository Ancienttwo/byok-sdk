# #614 daemon task memory opt-out

Baseline: `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779`.

The baseline derives ordinary task MCP requirements from helper availability;
there is no explicit task-memory opt-out. The new regression on the unchanged
baseline observes `task.decline` rather than `task.started` for a non-MCP adapter
when an off setting is requested. Prepared memory read selection is accepted
instead of unavailable. The auto/default controls pass. Four invalid config
cases also fail as expected before implementation (6 failures, 2 passes total).

The fix adds only a daemon configuration switch, with default auto unchanged.
Off removes both memory tool bindings and rejects prepared memory selections,
rather than shrinking a counted tool manifest. The explicit hosted projection
and intent transport paths keep their platform/helper validation. Agent-home
filesystem access and instruction guidance remain outside this switch.

The ordinary-off regression uses the real daemon admission and authenticated
loopback TestServer with a non-MCP stub runtime. On macOS the verified-helper
resolver is modeled at its boundary; no native helper binary is executed. On
Linux the same admission test uses the native backend condition. Windows has
no task-memory backend and is explicitly outside those three platform-specific
cases; config validation and prepared refusal still run there. This local run
was macOS only and does not claim Linux execution or native helper qualification.

Local focused validation after the fix: memory MCP admission, helper admission,
guidance, and prepared-offer lane: 4 files / 84 tests passed. Earlier fixture
failures (wrong wire task-id predicate) are retained outside the repository and
are not product evidence. No assertion deadlines were increased. After adding two explicit-transport
helper-validation regressions, the admission file passed all 10 tests. The
package Vitest setup injects `InMemoryDeviceCredentialStore`; no native login
keychain is accessed. An intermediate sandboxed rerun failed on loopback listen
with `EPERM` (3 admission cases); its log is preserved separately from the
successful run with loopback permission.

Workspace build and typecheck passed, followed by client typecheck after the
final tests. The API gate first reported the intentional new configuration
field; after reviewing and updating `api-surface/client.d.ts`, the API gate and
version-authority gate passed. `git diff --check` passed. The full suite is left
to CI; it has not been claimed as locally executed. Evidence logs are retained
under the parent task workspace as `evidence-614-*.log`.

This is a partial response to #614, not closure. Non-prepared per-task none/read/
read-write requires a distinct capability-gated offer/selection design: current
strict payloads reject unknown fields, and unsupported long-poll envelopes block
the cursor. This patch introduces no protocol field or permissive fallback.
