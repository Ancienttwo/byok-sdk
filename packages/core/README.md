# @byok-sdk/core

Tenant-first platform contracts, branded identity types, store ports, device
proof canonicalization, object/quota contracts, and in-memory reference stores.
This package is runtime-neutral: it has no Node built-in or protocol dependency.

```ts
import { tenantId, InMemoryCoreStores } from '@byok-sdk/core';
```

For connector setup, `authenticateDeviceAssertion()` verifies exact trusted
issuer/product/audience bindings, derives the principal from the current device
row, and consumes the JTI through an injected `DeviceAssertionReplayAuthority`.
`InMemoryDeviceAssertionReplayAuthority` is the reference implementation; a
hosted production composition must inject durable atomic storage. The assertion
authorizes one exchange only and is not a connector session or refresh token.

Sealed payload v1 (#654) has its own subpath, so the root entry does not grow:

```ts
import { openSealedContent, sealContent } from '@byok-sdk/core/sealed-payload';
```

It seals and opens one category of a payload, wraps a scope key to one member
as a signed key package, and signs and verifies one member chain entry. The
receivers return a typed failure for hostile input and do not throw. The wire
does not carry sealed content yet; later #654 slices add it.

## SQLite snapshots

The Node-only `@byok-sdk/core/sqlite-node` entry can read committed WAL data
without opening or changing the original database or its sidecars:

```ts
import { readSqliteSnapshot, SqliteSnapshotError } from '@byok-sdk/core/sqlite-node';

try {
  const rows = readSqliteSnapshot('control.db', db => db.prepare('SELECT * FROM tasks').all());
  // rows is undefined for :memory:, a missing file, or an empty file.
} catch (error) {
  if (error instanceof SqliteSnapshotError) console.error(error.reason);
  else throw error;
}
```

The callback is synchronous and also receives the private copy's path. The
copy and its writable connection exist only during the callback. A snapshot is
refused if source files change while copying or a rollback journal may be hot;
stop the writer or recover the database before retrying. For a main-file-only
immutable format check, use `readSqliteFileUnchanged` instead.

MIT licensed. Node.js 24.22.3 or newer.

Runtime dependencies and size budgets: [entry dependency contract](../../README.md#entry-dependencies).
