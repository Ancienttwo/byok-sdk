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

MIT licensed. Node.js 24.22.1 or newer.

Runtime dependencies and size budgets: [entry dependency contract](../../README.md#entry-dependencies).
