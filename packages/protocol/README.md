# @byok-sdk/protocol

The frozen v1 BYOK device wire contract: envelope schemas, message payloads,
codecs, version negotiation, and golden fixtures.

The `byok-profile` selection binds a device-local BYOK profile using
`profileRef`, canonical decimal `profileRevision`, SHA-256 `profileHash`, and
bounded `requiredCapabilities`. Its optional `selection.modelId` overrides
the model saved in that profile for the task. The endpoint, auth configuration,
and credential material stay device-local.

An Agent offer's `dispatchSelection` is the optional strict dual-lane target
contract: subscription selects Claude/Codex + model, while BYOK selects Pi +
provider + model. When present it is authoritative and runtime disagreement
fails closed. Servers send it only to a daemon advertising the
`dispatch-selection` capability, preventing an older v1 peer from stripping
the additive field and silently executing a runtime-only offer.

```ts
import { encodeEnvelope, decodeEnvelope } from '@byok-sdk/protocol';
```

MIT licensed. Node.js 24.22.3 or newer.

Runtime dependencies and size budgets: [entry dependency contract](../../README.md#entry-dependencies).
