# OpenCode platform qualification evidence (#1593)

Date: 2026-11-09 UTC. SDK subject: `871f0e999af209689dfa9705faf05b532bb5a102`. This is native runtime evidence, not a descriptor or release change. The earlier evidence and method are in [2026-11-08-opencode-native-qualification.md](2026-11-08-opencode-native-qualification.md).

At the evidence subject the default adapter had **no `versionPolicy`**, so no tested version is qualified or rejected by a default advisory policy. The executable compatibility parser accepts both `1.19.5` and `2.2.6`; acceptance by that parser is not qualification. Only the listed major lines were tested; other OS and major combinations remain untested.

| Native line | First task | Same-session resume | Cleanup | Free-model canary |
| --- | --- | --- | --- | --- |
| macOS 26.5 arm64, OpenCode `1.19.5` | BLOCKED: 180 s timeout | BLOCKED: first task did not finish | BLOCKED: SDK close not reached; watchdog terminated root | BLOCKED: selected free model stalled |
| macOS 26.5 arm64, isolated OpenCode `opencode v2.2.6` | BLOCKED: free quota refusal | BLOCKED: first task did not finish | BLOCKED for successful task; process and SDK scratch cleanup of refused task PASS | BLOCKED: free quota refusal |
| macOS 26.7.1 x64, OpenCode `opencode v2.2.6` | PASS | PASS | PASS for process and SDK scratch lifecycle; native session deletion not demonstrated | PASS |
| Windows 11 10.0.26100 x64, OpenCode `opencode v2.2.6` | BLOCKED: free quota refusal | BLOCKED: first task did not finish | BLOCKED for successful task; process cleanup of refused task PASS | BLOCKED: free quota refusal |

The owner clarified that qualification cleanup covers SDK-owned processes and SDK scratch. OpenCode's native session files are outside that scope. The remote 24-hour scratch sweep was not observed. No provider credential, paid model, login, or quota bypass was used.

## Method

The prior native Windows runbook's existing `run.ts` drives the SDK `OpenCodeAdapter` through `detect`, `prepare`, a sealed manifest, SDK execution scratch, `operation.start`, event collection and `close`. Its first task requests `OC_CANARY_OK`, and its second task resumes the identical session and requests `OC_RESUME_OK`. The Host's ordered candidates were `opencode/deepseek-v4.1-flash-free`, `opencode/crouton-alpha-free`, and `opencode/beam-free`; the first was explicitly selected and its native readback matched before prompt. A 180-second watchdog is not evidence of SDK disposal. The observer records ACP calls, model readback and process snapshots; it does not simulate responses.

The exact subject was checked out into `/tmp/oc1593-src`, independently of the issue worktree. `bun ci` and `bun run build` passed there. The earlier Windows script was copied from `C:\Users\win\byok-oc-canary\checkout\_ops\oc-canary\run.ts` into that temporary checkout at `_ops/oc-canary/run.ts`. For the remote hosts it was bundled from that subject:

```sh
bun build /tmp/oc1593-src/_ops/oc-canary/run.ts --target=bun --outfile /tmp/oc1593-canary.js
bun build /tmp/oc1593-src/_ops/oc-canary/run.ts --target=bun --external koffi --outfile /tmp/oc1593-win.js
```

The Windows bundle was placed in the previous checkout's `packages/client/canary-1593.js` solely to resolve its already installed native `koffi` dependency. No remote dependency installation occurred. Bundle logic and SDK implementation came from the subject above. Socket-related temporary paths used `/tmp/oc1593t` on both Macs and `C:/o1593/t` on Windows; the SDK sets per-execution `TMPDIR`, `TEMP` and `TMP` inside its short scratch roots.

## macOS arm64

The existing official-location executable `/Users/kito/.opencode/bin/opencode` reports `1.19.5`. Command:

```sh
cd /tmp/oc1593-src
TMPDIR=/tmp/oc1593t bun _ops/oc-canary/run.ts
```

Detection, native session open, model selection/readback and `session/prompt` occurred. No answer arrived before the watchdog. At timeout the receipt counted one owned ACP root and zero new services; an independent `ps -axo pid,ppid,command | rg '[o]pencode (acp|serve --service)'` afterward showed no matching process. `find /tmp/oc1593-src/_ops/s-EOHjPl /tmp/oc1593t -type s -print` showed no sockets. The watchdog killed the root rather than calling SDK close, so scratch had no `released` marker and cleanup cannot be qualified. Resume was not attempted. This does not prove a provider, network, or SDK root cause.

### Isolated v2 rerun

On owner authorization, OpenCode 2.2.6 was downloaded into a dedicated worktree-local directory without modifying the user's install, shell profile, or global PATH:

```sh
mkdir /tmp/byok-sdk-wt-1593/.oc1593
curl -fsSL https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.2.6.tgz -o /tmp/byok-sdk-wt-1593/.oc1593/opencode.tgz
openssl dgst -sha512 -binary /tmp/byok-sdk-wt-1593/.oc1593/opencode.tgz | openssl base64 -A
tar -xzf /tmp/byok-sdk-wt-1593/.oc1593/opencode.tgz -C /tmp/byok-sdk-wt-1593/.oc1593
/tmp/byok-sdk-wt-1593/.oc1593/package/bin/opencode --version
```

The `@opencode/cli-darwin-arm64@2.2.6` tarball came from the official npm registry URL used by the official v2 installer. Its SHA-512 base64 was `OZwkLtiDOvcsfWkRS4e0o/Vpgb7vw12xBLlIFyuDZfglsCmOSNzihS3Akg0Wh3kbob8JKDngIbktctgbfHmF8w==`, matching registry metadata. Version output was `opencode v2.2.6`. The existing SDK canary used the adapter's explicit executable resolver:

```sh
cd /tmp/oc1593-armv2
TMPDIR=/tmp/oc1593a OC_EXECUTABLE=/tmp/byok-sdk-wt-1593/.oc1593/package/bin/opencode bun /tmp/oc1593-src/_ops/oc-canary/run.ts
```

At `2026-11-09T03:55:57.165Z` detection, open and explicit free DeepSeek model readback passed; the first prompt returned `Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.` No fallback or second prompt occurred. The adapter sent `session/close`; the receipt counted zero new runtime processes, zero live owned roots and zero new services. `find /tmp/oc1593-armv2 /tmp/oc1593a -type s -print` returned no sockets. The SDK scratch execution has a `released` marker and retained runtime artifacts under `/tmp/oc1593-armv2/_ops/s-rIjkLo/exec/76a2f405561a/runtime/`, subject to the deferred retention described below. This is cleanup evidence for a refused turn, not a successful task. Resume was not attempted after the quota block.

The isolated directory was removed with `rm -rf /tmp/byok-sdk-wt-1593/.oc1593`; `test ! -e /tmp/byok-sdk-wt-1593/.oc1593` succeeded. The user's `/Users/kito/.opencode/bin/opencode --version` still reported `1.19.5`. No files from the isolated install were staged.

## macOS x64

On owner authorization, the official installers were run without sudo or system components:

```sh
curl -fsSL https://opencode.ai/v2/install | bash -s -- --version 2.2.6 --no-modify-path
curl -fsSL https://bun.sh/install | SHELL=/bin/sh bash -s -- bun-v1.4.4
~/.opencode/bin/opencode --version
~/.bun/bin/bun --version
```

Outputs were `opencode v2.2.6` and `1.4.4`. Paths are `/Users/graval/.opencode/bin/opencode`, the installer-created `/Users/graval/.opencode/bin/opencode2` shim, and `/Users/graval/.bun/bin/bun`. No shell profile lines were added: `--no-modify-path` disabled OpenCode profile edits, and Bun's `SHELL=/bin/sh` branch prints manual instructions rather than editing profiles. The `hc run` launcher reported `cannot save terminals: registry writer stopped` for both installations despite their completing; paths and versions were inspected before proceeding, and neither installer was retried.

The existing canary was copied to `/tmp/oc1593-run/canary.js` and run as:

```sh
hc exec --on mac-pro --cwd /tmp/oc1593-run 'env TMPDIR=/tmp/oc1593t OC_EXECUTABLE=/Users/graval/.opencode/bin/opencode /Users/graval/.bun/bin/bun canary.js'
```

The selected free model read back correctly; first output was `OC_CANARY_OK` with `turn_end`. The same native session resumed and completed, and different-cwd resume was refused. After first completion and final close the receipt reported zero new runtime processes, zero live owned roots and zero new `serve --service` processes. `find /tmp/oc1593-run /tmp/oc1593t -type s -print` found no sockets in those roots; sockets elsewhere were not exhaustively inventoried. The runbook then attempted its extra permission test, but no permission request was observed; the harness reported that unrelated gate as unproven and stopped its later cancellation checks.

Four released scratch executions remained after later tasks used the same scratch root, so starting another task did not immediately delete the earlier executions. Examples are `/tmp/oc1593-run/_ops/s-FyIspn/exec/2436b13b9485/runtime/.bun-501-2d5d43d7afddcf1b.dylib`, `.bun-501-ca278a0b7d7f3abd.node`, `.bun-501-8c82dfa65f7bbf09.dylib`, and its `runtime/opencode` directory. These are SDK scratch runtime artifacts, not the installed binaries under `~/.opencode/bin` or `~/.bun/bin`. Their released markers reflect the retention lifecycle below; this standalone canary did not run a daemon retention sweeper.

## Windows x64

The existing standalone PATH executable `C:\Users\win\AppData\Local\Programs\opencode\bin\opencode.exe` reports `opencode v2.2.6`; Bun reports `1.4.4`. The native Windows command was:

```cmd
cd /d C:\o1593
set TEMP=C:/o1593/t&& set TMP=C:/o1593/t&& set TMPDIR=C:/o1593/t&& bun C:/Users/win/byok-oc-canary/checkout/packages/client/canary-1593.js
```

At `2026-11-09T03:50:52.571Z`, the SDK detected and opened the runtime, passed the free DeepSeek model and observed matching readback, then the first prompt returned:

> Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.

This is a quota block; there was no second prompt or fallback. The adapter sent `session/close`, and the receipt counted zero new OpenCode processes, zero live owned roots and zero new services. The refused run left `C:\o1593\_ops\s-cgUA2P\exec\651a3b13295e\released` and SDK scratch runtime artifacts `runtime\.bun-270793455-3cba9b8dc4fa4e45.node`, `runtime\.bun-270793455-eb880eeb01e175aa.dll`, and `runtime\opencode`; these are not the installed OpenCode executable. Full successful-task cleanup was not established. No further Windows task was run because the free quota was exhausted. One retry after reset is deferred; it joins 0.41 only if it completes before 0.41 preparation begins, otherwise the next MINOR.

## Scratch retention cross-check

`packages/client/src/daemon/retention/scratch.ts:197-206` removes the SDK directory and writes the `released` marker at close. `packages/client/src/daemon/retention/producers.ts:138-159` reclaims the runtime tree once released, no longer live, and at least its TTL old. `packages/client/src/daemon/retention/config.ts:47-49` sets the default runtime TTL to 86,400,000 ms, and `sweeper.ts:129` schedules periodic work. A new task alone is not the reclamation trigger. The macOS x64 sequence tested multiple tasks on one root; Windows and arm64 v2 stopped after quota refusal, and arm64 v1 timed out before release. No separate non-OpenCode native runtime was run.

The existing controlled-clock test `packages/client/src/__tests__/retention.test.ts:66-72` checks that SDK scratch is removed on release, runtime residue remains until one millisecond before the TTL, and is reclaimed at the TTL. At the exact subject it passed:

```sh
cd /tmp/oc1593-src/packages/client
bun x vitest run src/__tests__/retention.test.ts -t 'disposal deletes SDK secrets before receipt and runtime residue expires exactly at its TTL'
```

Result: one passed, 63 skipped. This proves the tested SDK retention path under controlled time on the local host; it is not an observed 24-hour sweep on either remote host, and the standalone native canary itself does not provide a retention owner. OpenCode native session files are outside the qualification cleanup scope.

## Declaration decision (#1593, owner 2026-11-09)

The owner decided to declare macOS now. `RuntimeAdapterDescriptor.platforms` is OS-grained, so the descriptor declares `darwin` and covers both arches. macOS x64 passed first task, same-session resume, cleanup and the canary on `opencode v2.2.6`. macOS arm64 on `2.2.6` passed detection and the free-model readback, but its first task hit the free-usage limit (a quota refusal, not a program failure), so arm64 has no measured task evidence yet. Windows x64 stays undeclared until a retry after the quota resets. The default version policy qualifies `2.2.6` with `unqualified: 'warn'`. Cleanup scope is SDK-owned processes and scratch; native session files are outside it, and the remote 24-hour sweep was not observed.
