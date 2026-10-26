# Host local storage: Agent-first contract

## Canonical layout

An embedding product supplies one absolute `hostStorageRoot`. BYOK SDK owns
the only Agent-home composition rule:

```text
<hostStorageRoot>/
  agents/
    <validated-agentId>/              writer runtime cwd
      MEMORY.md                       create-if-missing, preserve existing
      notes/                          create-if-missing, preserve existing
      .byok/                           SDK-reserved internal namespace
        agent-home.lease
        agent-home-projection.json     exact applied revision/hash ordering
        egress/
          reliable-v1.jsonl           append/fsync, exact-ack retirement
        content-read-audit-v1.jsonl   content-free per-Agent decisions
        runtime-sessions/
          <runtime>-<session-hash>.jsonl   writer and reader sessions
          <runtime>-task-<task-hash>.jsonl
        runs/
          <taskId>/                    memory-reader runtime cwd, kept after the terminal
      ...                             opaque Agent files
```

For Salesko, `hostStorageRoot` may be `~/.salesko` after the host expands it to
an absolute path. Salesko must not join `agents/<agentId>` itself. The SDK
validates the typed `AgentRef`, composes that suffix, creates missing
directories and seed assets, resolves existing ancestors and real paths,
rejects symlink/traversal/cross-Agent escape, and seals the canonical Agent
home as the writer's runtime cwd. A `homeAccess: 'memory-reader'` Attempt runs
in `.byok/runs/<taskId>/` instead, under the same home, so the host-owned
layout does not change. The SDK creates that directory, keeps it after the
terminal for a resume, and removes old ones by retention. Agent content reads
do not open `.byok`, so the host gets reader output from the terminal
`finalMessage` or `summary`, a result document, task artifacts, or the local
filesystem. The `projection.prepare` hook gets the run directory as `cwd` for
a reader, and the writer of the home can run at the same time.

Daemon startup materializes and write-probes the canonical
root/`agents` namespace before advertising `agent-home-contract`; a configured
but unusable root therefore never admits a cloud Agent offer.

On POSIX, every runtime process group the daemon owns is recorded in
`<storeDir>/owned-processes/` until its disposal proves it gone. Daemon start
and the `archive-terminal-messages` operator action first end the groups a
crashed daemon left there; only then can a crashed run's Agent home lease
marker be reclaimed. If a group survives SIGKILL, start is refused and the
error names the record file: verify the processes are gone, then delete that
file.

The Agent home is the only workspace authority. Wire v4 removed Git
workspace mode and `DaemonConfig.workspaceRoot` (#925); the daemon leaves an
older daemon's `<storeDir>/git-workspaces.json`,
`<storeDir>/session-workspaces.json` and task directories untouched.

`agentId` is also rejected when it is not a portable Windows pathname segment
(reserved device names or a trailing dot/space). A strict Agent `taskId` is a
single-use durable reservation: retrying enqueue with the same id fails closed
instead of creating a second mailbox offer against an existing attempt.

`artifacts` is an ownership category, not a required literal directory and not
an SDK configuration schema. Projects, PDFs, images, temporary work, and other
Agent files remain opaque. BYOK does not parse, index, classify, rename, scan,
or infer business meaning from them. The `.byok` namespace is the sole
SDK-reserved namespace in the Agent home.

## Store-owned intermediate artifacts (#399)

```text
<storeDir>/
  tmp/
    owner.json                       exclusive scratch ownership
    exec/<12-hex-token>/
      sdk/                           secrets/config/projection; disposal receipt removes it
      runtime/                       child TMPDIR/TEMP/TMP; default 24h after release
      released                       TTL origin (restart time for crashed executions)
    daemon/                          diagnostics and Windows bridges; 1h residual TTL
  durable-replicas/<agent-binding>/   terminal-only cleanup under exclusive replica lock
  owned-processes/                   protected process-reconciliation authority
```

Runtime Unix sockets bind under `exec/<token>/runtime`, so the scratch root
is at most 61 bytes on macOS and 65 bytes on Linux. When canonical `<storeDir>/tmp` is
longer, the default moves to `/private/tmp/byok-scratch-<storeDir hash>` on
macOS and `/tmp/byok-scratch-<storeDir hash>` on Linux. The hash is the first
16 hexadecimal characters of SHA-256 of the canonical store path. Otherwise,
the default keeps the lexical `<storeDir>/tmp` and checks its length. An explicit
`storage.scratchRoot` moves exec scratch to one short private root with no
symbolic-link ancestors; daemon temps remain in the store. A shared external
root is refused. A root owned by another user is refused before permission changes. Each
retention class records its root, SDK/Host owner, store/home/replica scope and
TTL/count limit. The registry serves GC, pressure, status and support readback.
The store lease covers scratch recovery; the shared home base lease plus the
agents-root mutation gate covers readers and exact memory/projection temp
names. Gate acquisition is per home with a bounded walk and round-robin
cursor, so maintenance does not reserve the entire root for a full pass.
Memory-delete tombstones, opaque Agent files and `.byok` records are protected.
Skill-pack roots outside the store must be listed in `storage.skillPackDataDirs`;
only non-current hash revisions past 24h are deleted under the install gate.

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
| Egress | Send Agent events as the runtime produced them (ADR-037 D4); own the per-Agent reliable spool, cursor/ack/retry, quota and typed drop facts | Select one exact policy revision; decide what to store and show |
| Explicit reads | Own per-surface capability, canonical path policy, per-Agent audit journal and BlobRef receipt fidelity | Author tenant/actor authz plus narrower root/MIME/text/size policy; never infer authorization from file presence |
| Concurrency | Enforce one writer Attempt per canonical Agent home, and at most `maxConcurrentReaderAttemptsPerAgentHome` (default 4) `memory-reader` Attempts, each in its own `.byok/runs/<taskId>/`; report reader memory changes in `agentHomeMemoryChange` without enforcing read-only memory; remove reader run directories by retention (32 per home, 7 days, never an active one or one a recent reader handoff points to) | Send concurrent memory-reading work as reader offers and keep memory writes in the writer; do not write memory files while readers run if the attribution matters; do not schedule around or bypass a busy decline |
| Credentials | Never persist credential bytes in Agent home | Store secrets in SDK-owned macOS Keychain, Windows Credential Manager, or Linux Secret Service entries; project references/configured state only |

## Host-root relocation authority

An embedding host may run an explicit one-shot migration, but it cannot infer
quiescence from its service manager or inspect `.byok` markers. The public
client exposes only a high-level relocation lease. Internally, daemon/store
owner publication and Agent-home directory/lease publication contend with the
same path-scoped gates held by relocation. A writer that wins first is observed
and rejected; a relocation that wins first prevents publication until release.

Relocation acquisition canonicalizes intended paths without creating them and
must leave an absent destination absent. Active, unknown or corrupt owner/lease
state fails closed. The SDK lease does not move bytes or choose product mapping,
retention, rollback or service-cutover policy; those remain host authority.

The daemon tenant binding is part of authenticated enrollment, not host product
configuration. A successful pair response projects the opaque non-secret
tenant identifier already bound to the redeemed pairing code and cloud device
row; the client stores it atomically in its device enrollment record. Agent
egress, content receipts, acknowledgements and hosted journal rows consume that
exact local projection after restart. Renewal changes only token/expiry, while
re-pair atomically replaces the complete binding. A legacy or malformed record
without the binding fails closed and requires re-pairing—Salesko must not fill
it from Profile, editable config, deviceId, JWT/access-token parsing or a shadow
store.

Profile creation may enqueue a separate task-free `agent.home.projection`
control to one exact enrolled device. BYOK durably retains desired/status,
delivers only after the device declares `agent-home-projection`, acquires the
same Agent-home lease used by execution, and passes the opaque JSON value plus
SDK-supplied canonical cwd to the host hook. The SDK-owned local ordering file
records only request identity, AgentRef and projection hash. The hook owns an
atomic/idempotent product write such as `profile.json`; BYOK does not know that
schema, create `.salesko`, accept credentials, or delete local product files.
For a new request carrying the exact current revision and hash, BYOK re-runs
that desired-state hook under the same writer lease before returning an
`idempotent` receipt. This repairs locally lost derived bytes without inventing
a revision, deleting SDK ordering state, or inspecting a product filename.
Stale and same-revision/different-hash requests return before the hook.
Enqueue remains pending until the daemon's dedicated authenticated completion
request receives an exact durable readback.

## Admission and migration

Agent execution uses the distinct `task.offer_for_agent` message and the
additive `agent-home-contract` capability. Through `dispatch({ agentRef })` and
`enqueueAgentOffer` that message is exact-resume-only and requires `sessionRef`;
a fresh execution uses `executions.submit` / `submitAgentExecution`. The daemon sends the authenticated
`conn.hello` snapshot as the first long-poll message, before queued task
messages. The server and hosted cloud reject an Agent dispatch before task
creation or mailbox enqueue when the selected device has no admitted
declaration of that capability; the hosted composition persists the
declaration in the device row. `workspaceHint` remains reserved and ignored;
it is not an Agent-home input.

Cutover is explicit and one-shot. Task directories and session workspace
records an older daemon left are not adopted, copied, or searched. A
Salesko migration may enable Agent dispatch only after the target daemon has
the capability and the branded root has been selected. An old daemon, missing
AgentRef, profile revision mismatch, session/cwd/runtime mismatch, or busy
Agent home fails closed; none falls back to another directory.

Egress enablement is a second explicit admission step. Salesko first authors
one exact policy revision, then waits for the daemon's durable
`agent-egress-policy`/`agent-egress-reliable-ack` declaration before enqueuing
the distinct egress-aware Agent offer. A workspace, transcript or artifact read
is admitted only after that surface's own capability is present. Existing
`task.progress`, local transcripts, blobs and audit rows are not relabelled,
backfilled or uploaded during cutover. A policy/profile/session mismatch fails
closed and requires a new authorized request; there is no dual-read or legacy
fallback period.

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

The typed Agent egress contract is additive to Agent-home admission. Salesko
configures an exact `AgentEgressPolicy`. Agent events go to the Host as the
runtime produced them; the SDK does not filter, redact or omit them. Reliable facts
use the Agent-local `.byok/egress` spool and exact acknowledgements; latest
activity remains replaceable and is never backfill or shared history.

Required Agent messages use `.byok/messages/outbox-v1.jsonl` inside the
canonical Agent home. The SDK owns append-before-send durability, stable
message/cursor identity, exact accepted retirement, held/refused retention,
authenticated-tenant restart isolation, reconnect retry, and the Agent-home
writer lease. The host owns the bounded, server-side opaque
`agentMessageContext`, authenticated destination lookup, freshness decision, accepted-message
persistence, and retention/UI semantics. Message bodies are not activity,
Profile, workspace-read, transcript-read, or artifact-upload records.

Workspace, transcript and artifact reads are disabled independently unless
the corresponding capability and local policy are configured. BYOK owns path
containment, MIME/text/size checks, per-Agent audit persistence and transport
fidelity. Salesko owns tenant/actor authorization and cloud retention. Neither
side treats a full runtime transcript, `MEMORY.md`, `notes/`, or opaque Agent
files as implicitly uploadable. The design rationale and acceptance boundary
remain in [Agent local/cloud projection contract](researches/agent-local-cloud-projection-contract.md)
(superseded in part by [ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md); [`docs/spec.md`](spec.md) governs).
