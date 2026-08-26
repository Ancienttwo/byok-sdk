# Plan — Agent memory cross-platform secure filesystem

> Created: 2026-08-26 · Owner: Codex root · Status: Source complete / terminal unbound
> Scope repo: `byok-sdk` · Capability: `root` (`packages/client`)
> Parent: `plans/plan-20260826-1725-agent-memory-phase2.md`

## Goal

Remove the Linux-only limitation from Phase 2 on platforms where a real
descriptor/handle-relative proof exists, without weakening the existing
Agent-home boundary or the client's pure-JavaScript / single-file packaging
contract.

## Locked decisions

1. `@byok-sdk/client` remains pure JavaScript. Native `.node` dependencies and
   install scripts stay forbidden.
2. Native filesystem authority is an external, version-matched helper CLI,
   supplied by an explicit absolute path. There is no PATH discovery or
   unversioned fallback.
3. The helper protocol is private, bounded JSON over stdio. Identity and root
   are daemon-authored, never model arguments.
4. The helper must pin the Agent-home object and every directory/file object
   before use, reject path escape and symlink/reparse aliasing, and preserve the
   existing read/CAS/atomic replace/delete/append/list semantics.
5. macOS is enabled only after a real local parent/leaf swap falsifier passes.
   Windows remains fail-closed until the same source passes a real Windows
   junction/reparse/rename matrix; cross-compilation alone is not acceptance.
6. Linux keeps the existing `/proc/self/fd` backend. No compatibility dual-read
   or semantic fallback is added.

## P1 — Architecture map

- Authoring authority: `MEMORY.md` and `notes/**/*.md` in the canonical
  per-Agent home.
- Admission/lifecycle: `create-daemon.ts` → `task-runner.ts` → active memory
  context token → daemon control protocol → `AgentMemoryService`.
- Current secure filesystem: `agent-memory.ts`, Linux descriptor traversal.
- Packaging invariant: `scripts/release/check-package-graph.mjs` rejects direct
  native addons/install scripts; SEA/Bun recipes allow explicit external CLIs.
- New carrier: an external helper under `packages/client/native/agent-memory-fs`
  plus a TypeScript process adapter. It is reference source, not an npm direct
  dependency or bundled binary.

## P2 — Concrete trace

Strict Agent offer acquires the canonical Agent-home writer lease before the
runtime starts. If Linux descriptors are unavailable, the daemon may launch the
explicit helper, perform exact protocol/version/root-identity handshake, and
retain that task-scoped authority through MCP calls and the post-session hosted
snapshot. Helper exit, malformed output, timeout, identity mismatch, unsafe
path, or unsupported platform fails closed before memory/network exposure.

## P3 — Design rationale

A Node-API addon would make the public client a native install and break its
single-file deployment contract. A standalone helper matches the existing
external-runtime pattern and keeps signing/distribution with the product host.
The smallest coherent change is a private filesystem port plus one audited
helper protocol; hosted projection and MCP semantics do not change. At 10x,
the first pressure point is helper process lifetime/serialization, so the
helper is task-scoped rather than spawned once per file operation.

## Task breakdown

- [x] T1: freeze private helper protocol, exact handshake, tagged root identity,
  bounded framing, timeout/death semantics, and poisoned-PATH negative.
- [x] T2: implement helper filesystem operations and native tests under
  `packages/client/native/agent-memory-fs`; pin patched Go toolchain.
- [x] T3: add TypeScript helper lifecycle/port and route `AgentMemoryService`,
  snapshot, audit, and outbox through one selected secure backend.
- [x] T4: prove macOS parent/leaf symlink swap, CAS, atomic replace/delete,
  snapshot, audit/outbox, helper-death, identity mismatch, and outside sentinel.
- [x] T5: cross-build Windows source and add a Windows-native reparse/junction
  test entry; keep Windows admission disabled until that entry runs green on a
  real Windows host.
- [x] T6: update architecture/packaging docs and run root checks plus focused
  native/client tests and independent gate.

## Acceptance

- Existing Linux descriptor tests remain green.
- Real macOS helper tests prove no outside-sentinel read/write/delete under
  parent and leaf swap races before macOS admission becomes true.
- `@byok-sdk/client` release-graph purity remains green and no direct native
  dependency/install script appears.
- Windows remains disabled unless a real Windows-native test artifact exists.
- `bun run build`, `bun run typecheck`, `bun run test`,
  `repo-harness run check-task-workflow --strict`, and `git diff --check` pass.

## Out of scope

- Shipping, signing, notarizing, downloading, or auto-updating helper binaries.
- Hosted-to-local restore, RAG/search/history, product memory semantics, or
  changes to the hosted projection/database contract.
- Claiming linear CAS against arbitrary direct runtime filesystem writers.
