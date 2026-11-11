# Packaged Pi subagents: Bun background and SEA foreground

Final scope for #1589 with pi-subagents **0.87.0** and official Pi **1.5.0**:
Bun-compiled products with install-root assets run foreground children,
detached background children and workflows. Node SEA and interpreter bundles
retain foreground non-workflow children and refuse background and every
workflow call. Bun without install-root assets keeps foreground non-workflow
children through configured Pi assets. No SDK release version is assigned.

## Runtime boundary

Foreground children are in-process Pi sessions. SEA launches the ordinary Pi
host through the original executable. It creates no `node`/`node.exe` hardlink
or alias at startup or on demand. Neither EXDEV nor EPERM can prevent a
foreground task from starting. PATH and general Node resolution are unchanged.

The SEA refusal explains the pinned upstream behavior: its background runner
uses `resolveNodeExecutable`, and its workflow supervisor uses `fork` on
`process.execPath`. A SEA product cannot stand in for Node. The error names
foreground subagents and a Bun-compiled product as working alternatives.
Explicit async calls and every workflow call, including `async:false`, are
blocked by the refusal hook before execution. Ordinary children with omitted
`async` preserve upstream mode resolution. SEA/interpreter background requests
fail upstream's missing-peer preflight and receive the SDK explanation.

When either install-root asset directory is absent, Bun uses configured Pi
assets for foreground non-workflow subagents; present invalid assets still
fail closed. Explicit async and all workflows are refused up front. For a
call left to async-by-default, Bun auto-detection still selects the product
even without `PI_SUBAGENT_PI_BINARY`. The upstream async receipt is retained.
The reserved runner rejects the absent install assets with the same reason
before loading code from the configured root. Upstream stale-run reconciliation
persists `state: failed` and the reason in `steps[].error`; `bg_wait` reports
one failed job with no runs in flight. No success-to-error projection or
alternate background code root is used.

Bun uses the unchanged upstream binary bootstrap and its fixed Pi CLI argv.
Its code authority is `dirname(realpath(process.execPath))`, with the shipped
`pi-subagents` and SDK child extension trees beneath it. Environment-selected
roots and writable runtime manifests cannot choose code. Symlinks and
noncanonical paths are rejected. The install root has the same filesystem
trust as the product binary. Each process captures and checks its own BigInt
device/inode, size and mtime pins to detect in-process swaps before loading.
The runner does not authenticate against the host's earlier pins, and these
checks cannot detect replacement before process startup. No identity is passed
across processes. An atomic same-content replacement within one process fails
its verification. Launch data and generated peer bridges remain private.

Pi's TypeScript extension loader captures the product's embedded namespaces.
Generated aliases avoid binding names such as TypeBox's `Symbol` in a module
initializer. The peer catalogue loads lazily from the installed upstream
runner's `HOST_PEER_ALIASES`; TypeBox and every subpath remain external to
client dist. The original quoted compiler specifier in the duplicate catalogue
caused the CI boundary assertion to fail even though TypeBox was external.
That exact assertion was observed red before the repair and green afterward;
it was not changed. No duplicate catalogue remains in client source.

Compiled runner-shaped argv must match the trusted Bun bootstrap exactly.
Foreign paths, symlinks, malformed fields and extra arguments fail before the
ordinary product CLI. SEA rejects even the formerly accepted runner shapes.
No public export, option, configuration key, dependency or upstream patch is
added. G1 `subagent_launch`, required child extensions and native-child tool
approval are unchanged.

## Removed SEA enablement

The final scope removes the whole-host hardlink and its cross-volume error,
SEA private asset copies and peer preparation, the Node runner preload and
bootstrap dispatcher, and the workflow supervisor/worker/Acorn dispatcher.
It also removes their `process.argv`/`execArgv` rewriting and their indefinite
bootstrap waits. The Part A config-derived SEA private-root guard and its test
are deleted because that preparation path no longer exists. Bun's trusted
install guard and all applicable hostile-root/symlink/identity checks remain.

Bun workflows keep upstream's VM restrictions without Node's permission
layer. G1 and child approval mediate tool events; they do not police arbitrary
JavaScript APIs after a VM escape. Installed-package Node workflows retain
upstream's permission model. SEA background workflows are refused.

## Final local verification

- `bun run build` and `bun run typecheck`: passed.
- `dist-subpath-closure.test.ts`, `pi-runtime-launch.test.ts`,
  `sdk-reserved-helper-host.test.ts`, `pi-tool-authorization.test.ts`:
  **71 passed**. Includes unchanged command/sdkDir startup, missing and invalid
  install-root combinations, rejected SEA argv, in-process Bun swaps and G1.
- Full `pi-host-payload.test.ts`, with official Node **24.22.1** selected by
  `SEA_NODE` and Bun **1.4.3**: **9 passed**. Uses production SDK dist and its
  real reserved helper dispatcher, no spike source transform.
- API surface, version authority and upgrade manifest: passed. All nine
  declaration goldens unchanged; closure budgets equal measured bytes.
- `git diff --check`: passed. No full repository test run was used.

The loopback payload provider observed the following. Every child made a
file-read request and a final reply; the auto gate authorized the child read.
No paid provider or real credential was used.

| macOS arm64 product | Child requests | G1 workflow launch | Child read approvals | PATH |
| --- | ---: | --- | ---: | --- |
| Bun compiled | 6 | allowed | 3 distinct children | unchanged |
| Bun compiled, configured assets only | 2 | workflows refused | 1 foreground child | unchanged |
| Node SEA | 2 | refused before workflow execution | 1 foreground child | unchanged |
| Node interpreter + bundle | 2 | background refused | 1 foreground child | unchanged |
| Bun interpreter + bundle | 2 | background refused | 1 foreground child | unchanged |

SEA completed its foreground task using the original product command, created
no private subagent runtime, and left its installation inventory unchanged.
Explicit background and workflows with default or false `async` are refused
for all unsupported product forms. Default-async ordinary children preserve
their upstream behavior. The configured-assets Bun case records the native
receipt, waits for failed completion, checks the durable step error for the
missing-assets reason, and verifies a sentinel in its configured bootstrap
was never executed. No additional child provider request occurs.
Bun with install-root assets completed foreground, background and workflow
children and rejected a hostile environment root and a symlinked bootstrap
without executing the foreign marker. Unit checks retain symlink and
in-process inode replacement coverage. The foreign-Pi and extension ABI checks
remain.

**Windows repair rerun is pending.** Owner-directed win-ci access remains
suspended, and no win-ci or win-ci/t2 connection was made. Earlier Windows and
Linux route-C measurements describe historical heads, not final acceptance.
Linux arm64 Part A probes also passed positive and hostile-root/bootstrap/
extension-symlink cases before the final scope change; the final local matrix
above is macOS only. Bun's nonfatal upstream `undici.install` diagnostic was
observed; loopback success does not qualify proxy transport.

Added source relative to the integrated train: **198 product / 276 test lines**,
across existing test files only. Architecture boundaries and tracked upgrade
declarations are unchanged. This work references #1589 and leaves it open;
independent acceptance review covers the complete repair delta from
`80ebbd561` through the final head.
