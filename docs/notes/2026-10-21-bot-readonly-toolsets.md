# K8 read-only toolset admission (#606 partial)

Baseline `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779` throws in
BotCollaboration constructor for every required toolset, including a Host-owned
read-only market source. Regression preserved in
`/tmp/byok-606-baseline-red-authorized.log`.

A shared default-deny policy now checks initial/model/persisted templates,
create/update and enqueue. The Host owns copies of templates and a frozen
allowlist; configuration mutation does not widen it. Validation uses existing
logical ToolsetId syntax. Daemon capability/toolset admission is unchanged.

The test proves Host chat admission retains the declared logical toolset,
not that the test daemon executes a market server or that arbitrary tools
are read-only. Actual behavior remains enforced by the Host's local service.
No effects, credentials, Windows durability or relay permissions are granted.
The umbrella issue is referenced, not closed. No AiphaBee private data accessed.

Review corrections: non-array JavaScript policy input now fails clearly rather
than treating a string as individual IDs. Recovery admission also checks every
unsettled intent and its current frozen execution generation before constructing
K4, so changing the current Bot model cannot hide older pending toolsets.
Settled historical records do not block reopening. Regression tests cover both
old intent and independently frozen execution input, with no submit calls.

An intermediate affected run overlapped edits to the regression file: 46 passed
and the newly added malformed-input assertion used the already-loaded older
module and failed. That run is retained at `/tmp/byok-606-affected.log`; final
validation reruns the affected scope from stable files. Baseline rejection and
sandbox-only attempts remain recorded separately; no assertions were weakened.
