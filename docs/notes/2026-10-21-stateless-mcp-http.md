# Stateless tools-only HTTP (#607)

Baseline `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779`: initialize on A,
then a session-bearing tools/list on independent B returns 404. Regression
also fails because the baseline emits a session ID despite requested stateless
mode. Default stateful behavior remains tested unchanged.

The additive explicit mode uses an ephemeral core for each POST and disposes it
when the response settles. Supported HTTP protocol revisions are validated and
applied to that core; its private initialization id cannot collide with the
external request id. Tool semantics remain in the common MCP core. Per-instance
body/pending/running bounds remain in force; no idle sweep persists in this mode.

Host authentication and authorization remain mandatory on every request. There
is no portable credential/session store. Independent-instance tests are not
Cloudflare deployment qualification. Session DELETE/expiry and cross-request
cancellation are deliberately not represented as supported. This addresses the
stateless alternative without claiming all issue acceptance criteria or closure.

Official contract: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
permits omitting session IDs; a missing version's 2025-03-26 fallback is not a
supported revision of this SDK, so stateless requests after initialize require
a supported version header.

Validation: initial affected HTTP/core/interop run had 96 passes, one unchanged
cancellation test failure (`calls[0].aborted`) and a secondary connection-closed
rejection. The exact baseline focused test reproduces both; patched focused
comparison passes. This establishes a pre-existing failure, not its full root
cause. Concurrent calls are indexed by arrival order in that test; this remains
an investigation lead, not a proved diagnosis. No assertion/timeout was changed.
Logs: `/tmp/byok-607-focused.log`, `byok-607-baseline-cancellation.log`,
`byok-607-head-cancellation.log`. The baseline stateless regression red is in
`/tmp/byok-607-baseline-red.log`. An accidental sandbox-only rerun failed local
socket permission; its log is retained as `byok-607-initial-green.log`.
