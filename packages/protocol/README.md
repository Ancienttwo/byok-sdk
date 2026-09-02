# @byok-sdk/protocol

The frozen v1 BYOK device wire contract: envelope schemas, message payloads,
codecs, version negotiation, and golden fixtures.

`provider-profile-binding` is an additive v1 capability for exact device-local
BYOK routing. Its `byok-profile` selection contains only `profileRef`, canonical
decimal `profileRevision`, SHA-256 `profileHash`, `modelId`, and bounded
`requiredCapabilities`. Endpoint, auth configuration, and credential material
remain outside the protocol.

`TaskOfferPayload.dispatchSelection` is the optional strict dual-lane target
contract: subscription selects Claude/Codex + model, while BYOK selects Pi +
provider + model. When present it is authoritative and runtime disagreement
fails closed. Servers send it only to a daemon advertising the
`dispatch-selection` capability, preventing an older v1 peer from stripping
the additive field and silently executing a runtime-only offer.

```ts
import { encodeEnvelope, decodeEnvelope } from '@byok-sdk/protocol';
```

MIT licensed. Node.js 22.22.0 or newer.
