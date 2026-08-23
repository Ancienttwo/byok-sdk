# Host local storage: Agent-first contract

## Canonical layout

An embedding product supplies one absolute `hostStorageRoot`. BYOK SDK owns
the only Agent-home composition rule:

```text
<hostStorageRoot>/
  agents/
    <validated-agentId>/              runtime cwd
      MEMORY.md                       create-if-missing, preserve existing
      notes/                          create-if-missing, preserve existing
      .byok/                           SDK-reserved internal namespace
        agent-home.lease
        runtime-sessions/
          <runtime>-<session-hash>.jsonl
          <runtime>-task-<task-hash>.jsonl
      ...                             opaque Agent files
```

For Salesko, `hostStorageRoot` may be `~/.salesko` after the host expands it to
an absolute path. Salesko must not join `agents/<agentId>` itself. The SDK
validates the typed `AgentRef`, composes that suffix, creates missing
directories and seed assets, resolves existing ancestors and real paths,
rejects symlink/traversal/cross-Agent escape, and seals the canonical Agent
home as runtime cwd. Daemon startup materializes and write-probes the canonical
root/`agents` namespace before advertising `agent-home-contract`; a configured
but unusable root therefore never admits a cloud Agent offer.

`agentHome` and legacy `gitWorkspace` are mutually exclusive daemon
authorities. Agent execution never silently inherits task-scoped Git workspace
semantics or creates a second durable workspace owner.

`artifacts` is an ownership category, not a required literal directory and not
an SDK configuration schema. Projects, PDFs, images, temporary work, and other
Agent files remain opaque. BYOK does not parse, index, classify, rename, scan,
or infer business meaning from them. The `.byok` namespace is the sole
SDK-reserved namespace in the Agent home.

## Responsibility matrix

| Concern | BYOK SDK | Salesko / embedding host |
|---|---|---|
| Branded root | Require one absolute `hostStorageRoot` | Select and provision it, for example `~/.salesko` |
| Canonical path | Compose and own `<root>/agents/<agentId>` | Never compose or override the suffix |
| Identity | Validate and transport exact `AgentRef` | Author stable `agentId` and `profileRevision` |
| Profile | Keep content opaque; provide the canonical-home projection hook | Author versioned, redacted projection content; never include credential bytes |
| Memory and notes | Create if missing and preserve existing bytes | Define and evolve their content |
| Agent files | Enforce home containment and cross-Agent isolation only | Own names, formats, directories, and business semantics |
| Runtime | Seal AgentRef, canonical cwd, runtime/session and lease in the manifest | Select allowed runtimes and product policy |
| Sessions | Persist append-only exact-match handoff and terminal evidence under `.byok/runtime-sessions`; report bounded write exhaustion without stranding the cloud task or lease | Treat mismatch as a product-visible failed admission and surface the host audit signal; do not invent migration semantics |
| Concurrency | Enforce one mutable writer per canonical Agent home | Do not schedule around or bypass a busy decline |
| Credentials | Never persist credential bytes in Agent home | Store secrets in Keychain or Windows Credential Manager; project references/configured state only |

## Admission and migration

Agent execution uses the distinct `task.offer_for_agent` message and the
additive `agent-home-contract` capability. The daemon sends the same
authenticated `conn.hello` snapshot on WS and long-poll, before queued task
messages. The server and hosted cloud reject an Agent dispatch before task
creation or mailbox enqueue when the selected device has no admitted
declaration of that capability; the hosted composition persists the
declaration in the device row. `workspaceHint` remains reserved and ignored;
it is not an Agent-home input.

Cutover is explicit and one-shot. Existing task workspaces and legacy
`SessionWorkspaceStore` records are not adopted, copied, or searched. A
Salesko migration may enable Agent dispatch only after the target daemon has
the capability and the branded root has been selected. An old daemon, missing
AgentRef, profile revision mismatch, session/cwd/runtime mismatch, or busy
Agent home fails closed; none silently falls back to
`workspaceRoot/<taskId>`.

RAFT recovered behavior is precedent, not BYOK acceptance and not a directory
template. Its product-private secrets, tokens, app storage, and direct
`join(agentId)` behavior are not copied. A PDF observed in a recovered Agent
home is merely an opaque Agent artifact and provides no Profile or workspace
schema evidence. BYOK acceptance comes from its own protocol, persistence,
containment, concurrency, restart, cwd, and terminal-cause tests.

## Local execution and cloud projection boundary

The Agent-home contract is cloud-orchestrated and locally executed. Cloud
dispatch does not move provider tokens, the tool loop, runtime-native
transcript, credential custody, or arbitrary Agent-home files into cloud
authority. `MEMORY.md`, `notes/`, and opaque Agent files are not recursively
mirrored.

This work-package does not claim a generic egress sanitizer or durable
activity spool. Current `task.progress` is a separate contentful runtime
projection and the transport outbox is in memory. Salesko must not treat it as
the complete local transcript or shared-history authority. The typed
metadata-default/content-opt-in policy, reliable-vs-latest delivery lanes,
quotas, envelope-boundary sanitizer, and explicit workspace/transcript/artifact
read receipts are frozen as the next generic design contract in
[Agent local/cloud projection contract](researches/agent-local-cloud-projection-contract.md).
