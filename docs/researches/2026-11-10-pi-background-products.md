# Compiled Pi background subagents: route C evidence

Investigated for #1589 against `train/next-minor`, with pi-subagents pinned at
**0.87.0** and official Pi at **1.5.0**. The
[owner decision](https://github.com/Ancienttwo/byok-sdk/issues/1589#issuecomment-6745369158)
authorizes Bun-compiled and Node SEA background execution, including workflows,
retains interpreter-plus-bundle refusal, and explicitly accepts the missing
Node permission layer for SEA workflows. This supersedes the earlier
upstream-seam refusal recorded in #1622.

The original implementation/evidence below describes reviewed head
`80ebbd561`; independent review requested changes. The round 1 repair and
its updated validation are recorded at the end. SEA executable scope remains pending an owner
decision, and the Windows repair rerun is pending owner-reopened access.

## Implementation and boundary

The SDK loads the unchanged upstream package from a launch-private copy of
its shipped assets. The private Pi SDK bridge and peers refer to the product's
embedded modules, captured through Pi's own extension loader. A TypeScript
capture extension forces Jiti's virtual peer modules; a native `.mjs` probe
could otherwise cache an import failure before the bridge is initialized.
Generated export aliases avoid binding names such as TypeBox's `Symbol` in
the module initializer's scope.

Bun-compiled products use upstream's binary bootstrap and its fixed Pi CLI
argv. Node SEA starts the ordinary Pi host through a private hardlink named
`node` (`node.exe` on Windows). Upstream then selects `process.execPath`
directly, without changing PATH or replacing a builtin spawn function.
The hardlink retains its private path on macOS, Linux and Windows. That path
also supplies the asset root when upstream forks its workflow supervisor with
an empty environment. Executable and scratch must share a volume; an `EXDEV`
link failure becomes an explicit same-volume refusal, with no copy fallback.

The dispatcher compares canonical paths for both the preload and Node
bootstrap, the Bun binary bootstrap, and the workflow supervisor, worker and
Acorn files. It checks the pinned argv shapes before executing any of them.
Foreign scripts, foreign preloads and malformed shapes remain ordinary product
argv. No public helper kind, export, option, configuration key or dependency
is added. The existing G1 and native-child authorization implementation is
unchanged.

## Runtime evidence

Each executable run requested one foreground child, one background child and
one asynchronous workflow containing a child. Every child made two requests
to a synthetic loopback provider: a file-read tool call followed by its final
reply. The SDK authorization callback recorded and allowed each call. The
workflow also reached the existing hidden `subagent_launch` admission hook;
a final wait observed no active work. No paid provider or real credential was
used. Foreign Pi packages above the product supplied no working SDK, so a
successful child could not have used that foreign runtime.

| Platform | Product form | Child requests | G1 workflow launch | Child read approvals | PATH |
| --- | --- | ---: | --- | ---: | --- |
| macOS arm64 | Bun compiled | 6 | allowed | 3 distinct native children | unchanged |
| macOS arm64 | Node SEA | 6 | allowed | 3 distinct native children | unchanged |
| Linux arm64 | Bun compiled | 6 | allowed | 3 distinct native children | unchanged |
| Linux arm64 | Node SEA | 6 | allowed | 3 distinct native children | unchanged |
| Windows x64 | Bun compiled | 6 | allowed | 3 distinct native children | unchanged |
| Windows x64 | Node SEA | 6 | allowed | 3 distinct native children | unchanged |

macOS used the affected payload suite with official Node **24.22.1** selected
by `SEA_NODE`, and Bun **1.4.3**. Linux ran on the local Colima Docker
substrate, with **node:24.22.1** and **oven/bun:1.4.3**; this is container
runtime evidence, not a Linux CI result. Windows ran through
`hc exec --on win-ci`, with Node **24.22.1**, Bun **1.4.3**, and the SDK's
integrity-pinned koffi **3.3.7** native deployment. The Linux and Windows
products were built from implementation commit `35caca7f0`, the SDK's production
`dist` and its real reserved helper dispatcher, with no spike source
transformations or upstream patches. The subsequent merge of train commit
`0c926da23` changed Codex retention and generated budgets, with no change to
these Pi source files; the merged tree reran all 68 affected tests and the
required build/type/API/version/upgrade checks successfully.

Bun's unchanged upstream runner emits a nonfatal diagnostic that its
proxy-aware dispatcher could not call `undici.install`. The loopback runs
completed. Proxy transport is not qualified by this evidence.

The Node and Bun interpreter-plus-bundle cases retain a foreground child
(two child requests), refuse the background request before another child
reaches the provider, and identify the supported executable forms. The payload
suite keeps the foreign-Pi guard. The prior spike also observed the detached
peer-initialization failure for both interpreter forms on all three platforms;
this implementation turns that refusal into an actionable message.

## Security effect

Node SEA receives `--permission`, `--allow-worker` and read-grant flags as
application arguments. They do not activate Node's permission model. The
workflow dispatcher deliberately does not rely on them or propagate apparent
permission flags to its worker. This matches upstream Bun's existing worker
path. Installed-package Node workflows keep upstream's real permission model.

If workflow code escapes its VM realm in the compiled product, the absent
Node layer no longer denies reads outside the worker/Acorn grants, writes,
subprocesses or extra workers. VM realm restrictions, G1 child-launch
admission, native-child per-tool approval, and required gate/file-scope child
extensions remain. Those hooks mediate Pi events; they are not an arbitrary
JavaScript API sandbox. The spec and Unreleased changelog state this residual
risk explicitly.

## Verification

- `bun run build` — passed.
- `bun run typecheck` — passed, including the vendor typecheck.
- `SEA_NODE=<official Node 24.22.1> bun run --cwd packages/client test src/__tests__/pi-host-payload.test.ts`
  — **8 passed**, including four product forms and the upstream pin/argv case.
- `bun run --cwd packages/client test src/__tests__/pi-runtime-launch.test.ts src/__tests__/sdk-reserved-helper-host.test.ts src/__tests__/pi-tool-authorization.test.ts`
  — **60 passed**. Includes unchanged G1 coverage, private hardlink/PATH
  behavior, cross-volume refusal, and foreign/malformed runner dispatch.
- `bun run check:api-surface` — passed; all nine declaration goldens are
  unchanged and every closure budget equals its measured size.
- `bun run check:version-authority` — passed.
- `bun run check:upgrade-manifest` — passed, with **3023 tracked items** and no
  declaration change from this lane. The train's Codex-retention entries are
  retained. The behavior is named in the changelog/spec; no synthetic manifest
  entry is added for an unchanged tracked declaration.
- Active LSP coverage of all eight changed TypeScript files reported no
  TypeScript diagnostics. Auxiliary pattern findings include the deliberate
  `Reflect.get(globalThis, 'Headers')` used by the existing undici-initialization
  seam and temporary, exclusive generated-package writes; those are not
  TypeScript errors or persistent store mutations.

Added product lines: **195**. Added test lines: **173** across existing test
files only. No full repository test run was used. Host-provided Node and
background execution for interpreter-plus-bundle products remain outside this
owner-selected route; #1589 remains open.

## Round 1 repair

Bun code loading is now anchored to the product's real executable install
location, not an environment-selected private tree. Upstream package and SDK
extension files reject symlinks; trusted-source device/inode identities are
captured and checked again before loading. Atomic same-content replacement
also fails the identity check. Launch data and generated peer bridges stay
private. SEA validates its config-derived private directory before preparing
assets. Malformed compiled runner shapes are rejected before ordinary product
dispatch, and only Bun sets the Pi binary override.

The repair passes build/typecheck, 69 launch/helper/G1/dist-boundary cases
and all 8 payload cases. macOS and a Linux arm64 production bundle both complete the
Bun foreground/background/workflow sequence with six child requests, G1 and
three child read approvals. Hostile environment roots and symlinked bootstrap
and extension files are rejected without executing the foreign marker.
API/version/upgrade gates pass with unchanged public declarations.

The unchanged dist-boundary test reproduced a CI failure before the repair.
The quoted TypeBox compiler specifier came from the original `80ebbd561`
peer catalogue, not Part A; TypeBox was already external. The catalogue is
now loaded lazily from the installed upstream runner's `HOST_PEER_ALIASES`
export, and all TypeBox subpaths are explicitly external. The same test then
passes without an assertion change. No duplicate peer catalogue remains in
client source; the sibling sweep found no other matching source sites.

Windows repair validation is pending: the owner has suspended win-ci access,
and no connection was made. The old Windows rows above are historical only.
Part B's whole-host alias scope and foreground availability remain unresolved
pending the owner's decision. This repair leaves Part B unchanged.
