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
        agent-home-projection.json     exact applied revision/hash ordering
        egress/
          reliable-v1.jsonl           append/fsync, exact-ack retirement
        content-read-audit-v1.jsonl   content-free per-Agent decisions
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

`agentId` is also rejected when it is not a portable Windows pathname segment
(reserved device names or a trailing dot/space). A strict Agent `taskId` is a
single-use durable reservation: retrying enqueue with the same id fails closed
instead of creating a second mailbox offer against an existing attempt.

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
| Egress | Own metadata-default projection, sanitizer boundary, per-Agent reliable spool, cursor/ack/retry, quota and typed drop facts | Select one exact policy revision; contentful trajectory is an explicit product decision |
| Explicit reads | Own per-surface capability, canonical path policy, per-Agent audit journal and BlobRef receipt fidelity | Author tenant/actor authz plus narrower root/MIME/text/size policy; never infer authorization from file presence |
| Concurrency | Enforce one mutable writer per canonical Agent home | Do not schedule around or bypass a busy decline |
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
configures an exact `AgentEgressPolicy`; metadata/status remains the safe
default, while contentful trajectory requires explicit opt-in. Reliable facts
use the Agent-local `.byok/egress` spool and exact acknowledgements; latest
activity remains replaceable and is never backfill or shared history.

Workspace, transcript and artifact reads are disabled independently unless
the corresponding capability and local policy are configured. BYOK owns path
containment, MIME/text/size checks, per-Agent audit persistence and transport
fidelity. Salesko owns tenant/actor authorization and cloud retention. Neither
side treats a full runtime transcript, `MEMORY.md`, `notes/`, or opaque Agent
files as implicitly uploadable. The design rationale and acceptance boundary
remain in [Agent local/cloud projection contract](researches/agent-local-cloud-projection-contract.md).
