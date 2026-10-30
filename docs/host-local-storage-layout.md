# Host local storage: Agent-first contract

## Canonical layout

For configuration, directory ownership and operator setup, use the
[device setup guide](device-setup.md#directory-ownership). The contract below
defines the SDK-owned contents and containment rules.

An embedding product supplies one absolute `hostStorageRoot`. To choose it
and `storeDir`, call `resolveHostLayout`; the per-platform table and the
ownership rules are in [the spec](spec.md#recommended-host-layout). BYOK SDK
owns the only Agent-home composition rule:

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
          <runtime>-<session-hash>.jsonl   writer and reader sessions; 30 days after the last append once the home is idle
          <runtime>-task-<task-hash>.jsonl
        runs/
          <taskId>/                    memory-reader runtime cwd, kept after the terminal
        results/
          result-<task-hash>.json      staged submit_result outcome; 7 days / 256 per home once the home is idle
      ...                             opaque Agent files
```

The SDK validates the typed `AgentRef`, composes that suffix, creates missing
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
has a byte budget. The default root and its short-root fallback follow
[the spec rule](spec.md#client-intermediate-retention-399) (#493);
`resolveHostLayout` and `config check` report the result. An explicit
`storage.scratchRoot` moves exec scratch to one short private root with no
symbolic-link ancestors; daemon temps remain in the store. A shared external
root is refused. A root owned by another user is refused before permission changes. Each
retention class records its root, SDK/Host owner, store/home/replica scope and
bound (see [Retention bounds](#retention-bounds)). The registry serves GC, pressure, status and support readback.
The store lease covers scratch recovery; the shared home base lease plus the
agents-root mutation gate covers readers and exact memory/projection temp
names. Gate acquisition is per home with a bounded walk and round-robin
cursor, so maintenance does not reserve the entire root for a full pass.
Memory-delete tombstones, opaque Agent files and `.byok` records other than reader runs (`.byok/runs/`), staged result records (`.byok/results/`), session ledgers (`.byok/runtime-sessions/<runtime>-<session-hash>.jsonl`) and terminal evidence (`.byok/runtime-sessions/<runtime>-task-<task-hash>.jsonl`) are protected.
Skill-pack roots outside the store must be listed in `storage.skillPackDataDirs`;
only non-current hash revisions past 24h are deleted under the install gate.

### Retention bounds

Every retention class declares how its storage stays finite (#1105). An
expiring class has a TTL and sometimes a count; a protected class has a fixed
count, or an exemption that says why it cannot be bounded, who clears it and
through which API. The registry refuses a class without a declaration, and the
type of `PROTECTED_CLASS_BOUNDS` makes a new protected class fail to compile
until it has one. TTLs are `storage.retention.ttlMs[<class>]`.

| Class | Bound | Cleared by |
| --- | --- | --- |
| `exec-sdk`, `durable-replica`, `input-preparation` | TTL 0 (removed at release or terminal) | SDK |
| `daemon-temp`, `home-temp` | TTL 1 hour | SDK |
| `exec-runtime`, `skill-pack-old` | TTL 24 hours | SDK |
| `reader-run` | TTL 7 days, 32 per home | SDK, idle home |
| `agent-result` | TTL 7 days, 256 per home | SDK, idle home |
| `confirmed-journal` | TTL 30 days (must exceed 7 days) | SDK |
| `session-ledger` | TTL 30 days by last append | SDK, idle home |
| `terminal-evidence` | TTL 30 days by last append | SDK, idle home |
| `pi-session-dir` | TTL 31 days by last write; at least `session-ledger` plus one day | SDK |
| `agent-home-lease` | 1 per home | SDK |
| `skill-pack-current` | 1 revision per installed pack | Host, by uninstalling the pack |
| `journal` | Exempt: live-task ack and recovery rows; confirmed rows expire as `confirmed-journal` and maintenance compacts the file | SDK |
| `durable-replica-live` | Exempt: one replica per non-terminal durable Pi task, which becomes `durable-replica` at terminal | SDK |
| `owned-processes` | Exempt: one record per live runtime process; crash residue the SDK could not end stays | Operator (`owned-process-residue`) |
| `quarantine` | Exempt: the only evidence of a corrupt journal or health file; one entry per corruption event, not per task | Operator, after `byok-agent doctor` |
| `agent-content` | Exempt: Host product data | Host |
| `byok-authority` | Exempt: a fixed set of SDK records per home with bounded log tails; grows with Agent count, not task count | Host, with the Agent home |
| `store-authority` | Exempt: fixed device records and self-bounded logs (`audit.jsonl` rewrites past 10 MiB) | SDK, with the store |
| `runtime-session-external` | Exempt: Claude, Codex, Grok and Pi-login session records under the runtime's own config directory, mixed with the user's sessions; never measured or deleted | Host: `ClaudeAdapterOptions.agentSessionPersistence: 'disabled'` for Claude, the runtime's own session management otherwise |

`pi-session-dir` is `DaemonConfig.piByokLauncher.sessionDir`. The SDK deletes
only Pi's own session files there, flat `<ISO time>_<session id>.jsonl` names,
once their last write is older than the TTL; other names, folders and symbolic
links stay. Age alone never proves that a session is idle. Before validating a
resume ledger, TaskRunner obtains the prepared operation's `RuntimeSessionLease`
and retains it through startup and disposal. Standalone PiAdapter uses the same
admission gate. The actual Pi RPC host holds a separate writer gate for its
session file, so a surviving child stays protected even if its parent is killed.
The gates use canonical paths. They coordinate only processes (the daemon, the
adapters, the actual Pi writer, the sweeper and relocation) that run as the same
UID, in the same Linux network namespace, and reach each protected target
through a consistent canonical path. That holds for every gated target (the
store, the Agent home root, the skill-pack store and the Pi session directory)
and for the pathless Pi rebinding barrier, which exists once per UID and network
namespace rather than per directory. Processes in different network namespaces
do not exclude each other: give each namespace its own store.
A short discovery gate covers native session opening and replacement; different
sessions run concurrently. Cleanup must acquire discovery, admission and writer
gates, then recheck last-write time. Native `newSession.setup` receives a mutable
session manager and may synchronously select another directory. Only that
callback holds the shared Pi rebinding barrier, through confirmation of its
final file's writer lease, including callback failure. Nested setup calls reuse
the same barrier. A callback that never returns delays Pi session cleanup and
other setup callbacks, but does not stop already running sessions or other
retention classes. Normal turns never hold this barrier. Files whose header id disagrees with their
filename, or whose header identity cannot be determined within the bounded
header read, are retained. A config whose `pi-session-dir` TTL is less than the
`session-ledger` TTL plus one day fails with `LocalStorageConfigError`. A
resume whose file was already reclaimed fails like a resume of an expired ledger.

Custom adapters that own swept session data implement
`PreparedRuntimeOperation.acquireSessionLease(sessionRef)`. A custom caller must
acquire it before handoff validation, pass the exact returned object as
`RuntimeOperationStartInput.sessionLease`, and release it only after confirmed
runtime disposal, or when declining an offer that never started. The Pi token
is bound to its prepared operation and directory; a fabricated or released token
is rejected. Prepared in-memory and external login sessions have no such lease.

Migration from 0.31: a Host that trimmed this folder itself, such as
AiphaBee's `pruneLocalPiSessions` in `apps/local-agent/src/pi-provider-launcher.ts`,
deletes that code. A Host that raised `ttlMs['session-ledger']` also raises
`ttlMs['pi-session-dir']` to at least one day more. Terminal evidence now
expires after 30 days; a Host that reads it keeps it with
`ttlMs['terminal-evidence']`. The never-populated `retired-namespace` class is
gone.

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
| Sessions | Persist append-only exact-match handoff and terminal evidence under `.byok/runtime-sessions`; report bounded write exhaustion without stranding the cloud task or lease; remove session ledgers and `-task-` terminal evidence from an idle home by retention once their last append is 30 days old by default | Treat mismatch as a product-visible failed admission and surface the host audit signal; do not invent migration semantics; resume within the window or start fresh, and tune only `storage.retention.ttlMs['session-ledger']` and `ttlMs['terminal-evidence']` |
| Egress | Send Agent events as the runtime produced them (ADR-037 D4); own the per-Agent reliable spool, cursor/ack/retry, quota and typed drop facts | Select one exact policy revision; decide what to store and show |
| Explicit reads | Own per-surface capability, canonical path policy, per-Agent audit journal and BlobRef receipt fidelity | Author tenant/actor authz plus narrower root/MIME/text/size policy; never infer authorization from file presence |
| Concurrency | Enforce one writer Attempt per canonical Agent home, and at most `maxConcurrentReaderAttemptsPerAgentHome` (default 4) `memory-reader` Attempts, each in its own `.byok/runs/<taskId>/`; report reader memory changes in `agentHomeMemoryChange` without enforcing read-only memory; remove reader run directories by retention (32 per home, 7 days, never an active one or one a recent reader handoff points to) | Send concurrent memory-reading work as reader offers and keep memory writes in the writer; do not write memory files while readers run if the attribution matters; do not schedule around or bypass a busy decline |
| Results | Stage each `submit_result` outcome in `.byok/results/`; remove records from an idle home by retention (7 days by default, 256 per home) | Read structured outcomes from the terminal result document; do not read or delete `.byok/results/`; tune only `storage.retention.ttlMs['agent-result']` |
| Credentials | Never persist credential bytes in Agent home | Store secrets in SDK-owned macOS Keychain, Windows Credential Manager, or Linux Secret Service entries; project references/configured state only |

## Host-root relocation authority

An embedding host may run an explicit one-shot migration, but it cannot infer
quiescence from its service manager or inspect `.byok` markers. The public
client exposes only a high-level relocation lease. Internally, daemon/store
owner publication and Agent-home directory/lease publication contend with the
same path-scoped gates held by relocation. A writer that wins first is observed
and rejected; a relocation that wins first prevents publication until release.

### Path-mutation gates

A path-scoped gate is an OS lock that belongs to one open handle (#1149): on
macOS an `O_EXLOCK` open of `/tmp/byok-pm-<uid>/<identity>.lock`, on Linux an
abstract unix socket `\0byok-pm-<uid>-<identity>`, on Windows a named pipe. The
OS releases it when the handle closes or the holding process dies; the SDK never
removes a lock path, so no process can remove another holder's gate. A held
gate fails at once as busy. The macOS lock files stay on disk, one per gated
path. A Linux abstract socket name has no file permissions, so another local
user in the same network namespace could hold a name and keep that gate busy;
it can never become a second holder. The macOS lock files sit in the uid-keyed
`/tmp/byok-pm-<uid>`, which does not depend on `HOME`, so every process of one
user resolves the same file. A tool that deletes a lock file while its gate is
held would split ownership: the next acquirer creates a new file and locks it.
macOS ships no periodic `/tmp` cleaner, so only a third-party cleaner can do
this; the long-held Pi session writer gate is the main exposure. A reboot clears
`/tmp` with no gate held, which is harmless.

#### Upgrading from 0.31 or earlier

On macOS and Linux the gates of 0.31 and earlier (a unix socket file under
`/tmp/byok-pm-<uid>`) and the new OS locks do not exclude each other. Stop every
SDK process on a store (the daemon, the CLI, and an App that embeds the SDK)
before you upgrade any of them, and start them again only on the new release.
Windows is unaffected.

The new gates exclude each other only between processes (the daemon, the
adapters, the actual Pi writer, the sweeper and relocation) that run as the same
UID, in the same Linux network namespace, and reach each protected target
through a consistent canonical path; the pathless Pi rebinding barrier is shared
per UID and network namespace. A Host that runs processes in different network
namespaces gives each namespace its own store.

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

Agent execution uses `task.offer` and the `agent-home-contract` capability.
Through `dispatch({ agentRef })` and `enqueueAgentOffer` the offer is
exact-resume-only and requires `session: { mode: 'resume', sessionRef }`;
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
