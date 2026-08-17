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

MIT licensed. Node.js 22.22.0 or newer.
