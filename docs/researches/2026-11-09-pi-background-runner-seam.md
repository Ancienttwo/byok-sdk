# Single-file Pi background subagents: upstream seam declined

Investigated on 2026-11-09 for #1589, item 2, against SDK base
`2895560b37a5741d777241dcefc5c7fb1663fcb6`. Items 1 (foreground children,
#1592) and 3 (sealed host retirement, #1601) already shipped on this base.

The upstream issue was closed **as not planned**, not implemented. Keep the
single-file background refusal. This investigation changes no product code,
`@byok-sdk/*` exports, wire shapes, dependency pins or helper kinds.

## Upstream decision and package identity

[nicobailon/pi-subagents#3105](https://github.com/nicobailon/pi-subagents/issues/3105)
closed at `2026-10-29T13:20:52Z`. The maintainer's
[closing comment](https://github.com/nicobailon/pi-subagents/issues/3105#issuecomment-6497819184)
says “Closing this as not planned for now” and explains that a runner-command
hook alone does not handle the file-based agents, prompts, workflow worker,
inspector runner, retention discovery worker and Acorn. The suggested deployment
ships or extracts the package directory and uses the normal Node runner. The
maintainer would reconsider if a second SDK embedder needs the feature or Pi
provides a supported embedded-extension asset mechanism.

`npm view pi-subagents dist-tags version time dist.integrity dist.shasum --json`
confirmed that `latest` is still **0.87.0**, published
`2026-11-07T07:33:10.514Z`. There is no newer release behind the latest tag.
The package was independently downloaded with `npm pack pi-subagents@0.87.0`:

- SHA-1: `c56722eb22d248a9eb1f934da3bb0bc0ec4f43d0`.
- Integrity: `sha512-+XjSB0xEUqrvodRh3bSQGj5/DqCfI/bLlYb0PYfBPFR757S/oOGTWA6uAAOsg3SqAu2ZYyH04Up2Zbi6q4OPMA==`.

## Source evidence from the published 0.87.0 tarball

The following paths and line numbers are relative to the tarball's `package/`
directory, not an upstream checkout or a different local installation.

| File:line | Observed behavior |
| --- | --- |
| `package.json:61` | The export map has no host runner registration or runner entry export. `./background-work` at line 66 is a separate API, not a command replacement seam. |
| `bundle/chunk-OZCPYJEY.js:1648` | The bundled extension resolves its runner relative to `../src/runs/background/async-execution.js`; line 1650 selects `subagent-runner-bootstrap`. The brief's `bundle/subagent-runner-bootstrap.js` path is not present in this release. |
| `src/runs/background/async-execution.js:443` | `spawnRunner` selects `resolveBunPiExecutable()`, otherwise Node. Lines 459 and 463 reject missing npm Pi roots or peer dependencies. |
| `src/runs/background/async-execution.js:477` | The executable is hardcoded as `binaryHost ?? nodeExecutable`. |
| `src/runs/background/async-execution.js:532` | The npm branch prepends `runner-peer-preload.mjs` when peer aliases exist. Line 535 selects either Pi CLI arguments for the binary branch or bootstrap/config arguments for Node. |
| `src/runs/background/async-execution.js:556` | A configured launcher only prepends `launcher.argv` to the already selected command and arguments. It cannot replace the runner with a host helper. |
| `bundle/chunk-OZCPYJEY.js:1902` | The published extension bundle contains the same selection, peer checks (line 1918), executable choice (line 1929), argument construction (line 1968) and launcher prefix (line 1981). |
| `src/runs/shared/pi-spawn.js:77` | `resolveBunPiExecutable` recognizes Bun's virtual entry path. Line 84 returns `PI_SUBAGENT_PI_BINARY` or `process.execPath`; this is an executable override with fixed Pi CLI arguments, not a host command plus arguments. |
| `src/runs/background/subagent-runner-bootstrap.js:104` | Internal `runConfiguredSubagent` owns startup authorization and leases; line 172 imports the adjacent `subagent-runner.js` unless an internal injection/test path is used. This function does not register a replacement launch command. |
| `src/runs/background/subagent-runner-bootstrap.js:247` | The standalone bootstrap recognizes its own file entry and reads the config from argv at line 250. |
| `src/runs/background/binary-bootstrap.js:24` | `PI_SUBAGENT_RUNNER_CONFIG` passes the config path to the Pi CLI extension. Lines 41–42 invoke the internal bootstrap with the SDK supplied by Pi's extension loader. The variable does not replace the command. |

Neither the internal bootstrap function nor its execution injection is a
supported host command seam. Calling private package paths or building a local
runner around them would violate this lane's upstream-only implementation
boundary and would leave launch and liveness assumptions unresolved.

## SDK path and existing refusal case

`packages/client/src/bin/pi-rpc-host.ts:280` selects the installed or bundled
subagent path. The bundled branch sets `PI_SUBAGENT_PI_BINARY` to the
launch-private directory at line 292, preventing the compiled product from
re-executing itself with Pi CLI arguments. Line 295 sets the authoritative
`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` to a generated package that exposes
the product's in-process Pi. `packages/client/src/adapters/pi/subagents.ts:105`
writes that package without the peer dependency tree, so the Node runner fails
its upstream peer preflight. Foreground children continue using the product's Pi.

`packages/client/src/__tests__/pi-host-payload.test.ts:231` already exercises
Bun plus bundle, Node plus bundle, and Bun compiled executable forms. The
loopback provider requests a foreground child followed by a background child
(lines 156–160 and 257). Assertions at lines 326–338 prove the foreground child
loads the gate, the background child returns the expected upstream error, no
background child reaches the provider, and the product is never re-executed.
A deliberately foreign Pi above the product also proves the authoritative root
prevents a foreign runtime from being selected.

## Verification

Run in this worktree on macOS with the existing code at the SDK base above:

- `bun ci` — passed with the existing lockfile.
- `bun run build` — passed.
- `bun run typecheck` — passed.
- `cd packages/client && bun run test src/__tests__/pi-host-payload.test.ts`
  — **5 passed, 1 skipped**. Bun plus bundle and the compiled executable ran
  their real foreground child and background refusal checks against a local
  HTTP stub, with no credentials or paid model calls. Node plus bundle was
  skipped by the existing interpreter-relocation guard; that form still needs
  the formal CI environment's relocatable Node interpreter.
- `bun run check:api-surface` — passed; every entry-closure budget equaled its
  measured size, and all nine package goldens matched.
- `bun run check:version-authority` — passed.

Added product lines: **0**. Added test lines: **0**. The existing behavioral
coverage was run unchanged. No declaration or upgrade-manifest change is needed.

## Recommendation

Keep refusing background runs in single-file products and keep #1589 item 2
open as blocked by an upstream capability. Foreground single-file children and
installed-package background children remain the available deployment choices.
Shipping the package assets already solves foreground loading; shipping a
separate Node/Pi installation would change the single-file product contract
and does not meet the required self-executable runner behavior.

Do not open a duplicate of #3105 or invent a local runner. Revisit upstream
when its stated reopening conditions change. A future proposal should cover
both a supported host command/runner entry and the package asset, peer loading,
worker, startup identity and liveness assumptions. Any eventual implementation
must retain required child extensions and judge background child launches
through the same `auto` gate as foreground launches.
