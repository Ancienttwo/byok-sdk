# Pi login-state probe and bundled-Pi user extensions (#340, #341)

## Scope and source

Two client defects reported against 0.26.0-rc.3 with bundled pi 1.1.0, both on the `sdkHelperHost` path used by single-file products:

- #340: `PiAdapter.detect()` set `authPresent` only from provider credential env-var names, so users logged in through pi's own `auth.json` were reported `authPresent: false`.
- #341: bundled pi still loaded the user's pi packages, and an extension that imported the pi package failed with `Cannot find module`, failing every pi task on that machine.

## Contract

- Pi `authPresent` is pi's own login state (`adapters/pi/auth-presence.ts`): a known provider credential env-var name, or a usable `api_key`/`oauth` record in pi's agent-dir `auth.json` for the global `settings.json` `defaultProvider` (any provider when none is set). The agent dir is resolved as pi resolves it (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Only shape is inspected; no value is compared, returned, logged or retained. Missing or malformed files observe `false`. `models.json` provider keys do not count.
- This narrows the earlier credential-isolation statement for pi only: the pi adapter now reads `auth.json` in-process. `~/.claude` and `~/.codex` are still never read. `docs/security.md`, `docs/spec.md`, `docs/compliance/tos-brief.md` and `docs/security-review-m4.md` record this.
- Bundled pi keeps the user's extensions (spec unchanged) and resolves their pi package and `typebox` imports to the running bundle, as pi's own bundled CLI does: `runSdkReservedHelperCommand()` sets pi's `PI_BUNDLED_NODE` global before importing the runtime host that evaluates pi. A product that evaluates pi earlier must define `PI_BUNDLED_NODE=true` at build time. There is no host option to skip user extensions; an extension that still fails to load still fails the task.

## Task Breakdown

- [x] #340 probe, docs and tests (`auth-presence.test.ts`, real `detect()` on installed and `sdkHelperHost` paths with a canary secret).
- [x] #341 fix, docs and tests (`pi-host-payload.test.ts` user extension in Bun-run bundle, Node-run bundle and Bun-compiled executable; `sdk-reserved-helper-host.test.ts` global ordering).
- [x] Integrate both, update dated compliance/review docs, merge to main.

## Verification

On the integrated branch: build, typecheck, api-surface (client golden refreshed for doc-comment changes only) and version-authority pass. `bun run test` exits 1 in the client package with 18 failures in 6 files (`diagnostics`, `input-preparation`, `input-preparation-store`, `task-runner-cancel-native`, `task-runner-cancel-fixture-exit`, `fix-pi-durable-shell-exit`); the same 18 fail on the unmodified base `56dabbb` in this root-run sandbox (permission-denied writes succeed as root; process-tree timing). Client: 3631 passed. Other packages were run per worker branch and passed, except two cloud-do timing failures seen once and not compared against base. No release, publication or real provider call is part of this task.
