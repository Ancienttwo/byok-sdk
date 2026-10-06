# Codex local reference Host

## Scope and entrypoint

Baseline: BYOK main `5482a0a8ffc92e2eea662c83a4c2bf5232d3d24d`.
Owned files: `examples/codex-interaction-host/**`, its private workspace entries
in `bun.lock`, and this plan. No SDK production API or Salesko changes.

Entrypoint: a local terminal CLI, `node examples/codex-interaction-host/dist/cli.js
--fixture <scenario>`. It renders native request identity and details, accepts
explicit JSON answers bound to the local Host run/task plus SDK generation and
request ID, and prints bounded receipt metadata. No browser/mobile/remote SaaS
transport, authenticated remote endpoint, persisted answers, or new framework.

The CLI can only launch the included synthetic protocol process. It never
resolves an installed Codex binary. Its public-API runner uses CodexAdapter's
prepare -> sealRuntimeOperationManifest -> operation.start -> Session.interactions
path, retaining the SDK's validation and process ownership. Existing Codex
on-request mode is still danger-full-access, not mandatory per-tool approval or
readonly/network-restricted enforcement. No live launcher is offered here;
production/live wiring stays blocked pending explicit runtime/account/testcase
and authority approval. Fixture operation exercises that exact existing adapter
mode without executing commands, loading credentials, or calling a provider.

## Task breakdown

The implementation below is complete. Final frozen-candidate command results
are retained with the source/evidence backup; live acceptance remains unrun.

1. [x] Implement a bounded terminal presenter with exact Host/task/request/generation
   binding, explicit offered choices, safe terminal rendering, no default answer,
   and local idempotent answer receipt handling.
2. [x] Compose only public SDK exports. Bind presentation callbacks to the returned
   Session.interactions channel, then consume native completion/disposal events.
3. [x] Add synthetic official-protocol stdio fixture and end-to-end tests through
   displayed request -> terminal input -> Host -> SDK -> actual child-process
   protocol response. Cover once/session, deny/cancel, questions, duplicate and
   conflicting replies, expiry, process exit, stale generations, EOF and close.
4. [x] Document offline evidence separately from later approved live acceptance.
5. [x] Run the Host and compiled-CLI tests plus full build/typecheck/API/version
   checks. Do not run held Pi/core coordination/egress audits.

## Publication and evidence limits

Only local commit and source/evidence backup in this task. Independent review precedes the requested Draft PR publication. No npm publication, deployment,
provider invocation, credentials/keychain, SSH, live database, new persistent
access, or irreversible D8 work. A fixture transport write receipt is not a
provider tool-execution acknowledgement. Live acceptance remains unrun.

## Validation scope and follow-through

The implementation uses only the frozen repository dependency graph; the new
workspace adds no third-party dependency. Local validation uses Bun 1.4.0 and
Node 24.19.0 (within the declared >=24.15.0 engine), not the CI 24.21.0 baseline.
Full build includes Wrangler's local `--dry-run`; its configuration/log directory
is redirected to an isolated writable directory and metrics are disabled.
No network deployment occurs. Full aggregate test suites and held security
probes are not run in this lane.

Review-driven regressions additionally cover startup and runtime output failure,
output closure, setup rejection, early abort and process/workspace cleanup. The
CLI retains disposal ownership while handling startup signals; cancellation intent
never suppresses an unrelated cleanup error. Tests await child exit in teardown,
use one file worker, and await child exit in bounded teardown. Cold public-SDK
loading/readiness exceeded 3- and 5-second fixture waits under shared load;
readiness now has a 15-second bound, with 30-second tests and 10-second teardown.
No adapter/runtime deadline or behavioral assertion was relaxed. The CLI uses
a preserved lazy local import so argument checks and signal intent are installed
before SDK loading; unsupported flags never load the runtime modules.

A new independent live-runtime authority decision and separately recorded real
Host acceptance remain required before any real Codex use or release-gate closure.
