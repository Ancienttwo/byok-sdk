# Vendoring K8

K8 (`examples/bot-collaboration`) and K4 (`examples/host-execution-core`) are
private workspace packages. Neither is on npm. A Host copies their source files
into its own repository and owns the copy. This file lists what to copy, in
layers. A layer needs the layers above it.

`src/vendor-manifest.test.ts` walks the imports from each layer's roots and
checks each list below against that graph: the files, the packages, and the
names a list gives. So each list is complete for the commit it comes from.

How to read a list:
- A path line is a file to copy. K8 paths are relative to
  `examples/bot-collaboration`. K4 paths are relative to
  `examples/host-execution-core`.
- Any other line is an import that the copy must resolve. Names after `:` are
  the only names that the layer imports from it.

## Record the source

Copy K8 and K4 from the same release tag. K8 is tested only with the K4 of its
own commit. Record the tag and its commit in your repository, for example:

```text
byok-sdk v<version> <commit> examples/bot-collaboration examples/host-execution-core
```

To update, read the diff of both folders between the recorded commit and the
new one, and the `Breaking (examples)` entries of `CHANGELOG.md` in that range:

```sh
git diff <recorded-commit>..<new-commit> -- examples/bot-collaboration examples/host-execution-core
```

## Published SDK packages

The copy imports `@byok-sdk/protocol`, `@byok-sdk/core`, `@byok-sdk/server` and
`@byok-sdk/client` from npm. Layers 2 and 3 need all four, because they need
the K4 root entry (see the [K4](#k4) list). Layer 1 needs only the packages
its list names. These packages are released
together under one version. Use exactly the version of the tag you copied. A commit between tags
can use package changes that are not on npm yet. K4 needs Node 24.15 or later,
because its ledger uses `node:sqlite`.

## Layer 1: rules

`src/rules/` holds the pure rules: no I/O, no ledger and no clock (#606 §5.5).
`src/rules-boundary.test.ts` also holds this layer to its imports.

The rules import `hash` and `canonical` from the K4 `./canonical` entry, never
the K4 root entry (#884). That entry is K4 `src/canonical.ts` and imports only
`node:crypto`. So a copy of this layer alone needs only that K4 file, resolved
as `@byok-sdk/example-host-execution-core/canonical`, and no `node:sqlite` or
`node:async_hooks` (see [K4](#k4)).

```vendor rules
src/rules/cards.ts
src/rules/coalesce.ts
src/rules/commands.ts
src/rules/commit.ts
src/rules/compaction.ts
src/rules/context.ts
src/rules/delegation.ts
src/rules/due.ts
src/rules/frame.ts
src/rules/history.ts
src/rules/message.ts
src/rules/outcome.ts
src/rules/rooms.ts
src/rules/schema.ts
src/rules/sync.ts
src/rules/team.ts
src/rules/turn.ts
@byok-sdk/core
@byok-sdk/protocol
@byok-sdk/example-host-execution-core/canonical: canonical hash
```

## Layer 2: L Host

The roots are `src/host.ts` (`BotCollaboration`) and `src/index.ts`. The package
entries other than the vectors are in this layer too. `src/persona.ts` is the
daemon side of the persona projection. It is the only K8 file that imports
`@byok-sdk/client` directly. The K4 root entry needs that package too.
`src/migration.ts`, the owner switch format, imports only types from the K4
root entry and takes `hash` and `canonical` from the `./canonical` entry.

```vendor host
src/channel.ts
src/coalesce.ts
src/commit.ts
src/compaction.ts
src/delegation.ts
src/delivery-routing.ts
src/delivery.ts
src/history.ts
src/home-projections.ts
src/host.ts
src/index.ts
src/migration.ts
src/model.ts
src/persona.ts
src/reply-receipts.ts
src/retention.ts
src/rooms.ts
src/routines.ts
src/schema.ts
src/team-model.ts
src/team.ts
src/toolset-policy.ts
src/topology.ts
@byok-sdk/client
@byok-sdk/core
@byok-sdk/example-host-execution-core
@byok-sdk/example-host-execution-core/canonical: canonical hash
@byok-sdk/protocol
@byok-sdk/server
node:crypto
```

## Layer 3: shared vectors

The roots are the package entries `./test-support`, `./retention-vectors`,
`./routine-vectors` and `./delivery-vectors`. Each runs the same cases against a
Host's own store, as the hosted example does on Postgres. The vectors need
layers 1 and 2: `CollaborationState`, the outcome schema and the routine rules
come from L files. They also import `hash` and `taskId` from the K4 root, and
they run on vitest.

The commit vectors import only `template` from K4 `test-support`, and the test
holds them to that one name. Do not copy K4 `src/test-support.ts`. It is the
SDK repository's real server and daemon smoke helper. It loads a test
enrollment store from `scripts/testing/`, whose types come from the client
package source, and a stub runtime adapter from the basic example. Resolve
`@byok-sdk/example-host-execution-core/test-support` to a module of your own
instead. Copy the `policy` constant and the `template(deviceId, agentId =
'main')` function from K4 `src/test-support.ts` into it. They need only
`AgentEgressPolicy` from `@byok-sdk/client` and `ExecutionTemplate` from the K4
root entry, so the module typechecks against the published packages. Keep the
returned value the same as K4's.

```vendor vectors
src/commit-vectors.test-support.ts
src/delivery-vectors.test-support.ts
src/retention-vectors.test-support.ts
src/routine-vectors.test-support.ts
@byok-sdk/core
@byok-sdk/example-host-execution-core
@byok-sdk/example-host-execution-core/test-support: template
@byok-sdk/protocol
vitest
```

## K4

K8 imports K4 by its package name, `@byok-sdk/example-host-execution-core`. The
root entry (`.`, `src/index.ts`) reaches every non-test file of K4 `src/`, except
`src/test-support.ts` and `src/fixtures/`. The test checks this. The
`./canonical` entry is `src/canonical.ts`, one of those files, and it is the
only K4 file that [Layer 1](#layer-1-rules) imports. The
`./test-support` entry is not copied ([Layer 3](#layer-3-shared-vectors)). The K4
[README](../../host-execution-core/README.md#files) describes those files.

Copy them, and resolve the package name to the copy. Use a workspace package
with the same name and `exports` table, or an alias such as tsconfig `paths`
with the same alias in your bundler and test runner. Keep the name: the copied
imports and `src/rules-boundary.test.ts` use it. The root entry imports these
files and packages:

```vendor k4
src/canonical.ts
src/core.ts
src/index.ts
src/ledger.ts
src/memory-restore.ts
src/memory.ts
src/model.ts
src/routines.ts
src/schedule.ts
src/sealed-routine.ts
src/submit.ts
src/transitions.ts
@byok-sdk/client
@byok-sdk/client/agent-memory
@byok-sdk/core
@byok-sdk/core/sealed-payload
@byok-sdk/protocol
@byok-sdk/protocol/constants
@byok-sdk/server
node:async_hooks
node:crypto
node:sqlite
```

## Not vendored

K8's own test helpers and the `submit_result` measurement runner. No layer
imports them.

```vendor unvendored
src/channel-contract.ts
src/cross-bot.test-support.ts
src/import-scan.test-support.ts
src/routines.test-support.ts
src/second-device.test-support.ts
src/team.test-support.ts
src/submit-result-measurement/
```
