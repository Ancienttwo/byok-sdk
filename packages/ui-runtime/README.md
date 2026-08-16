# @byok-sdk/ui-runtime

React-free deterministic projection from BYOK typed activity tails to a
host-facing Live Activity Timeline view model. It owns no network,
authentication, persistence, redaction, or presentation behavior.

```ts
import { replayTimeline } from '@byok-sdk/ui-runtime';

const snapshot = replayTimeline(activityTail);
```

MIT licensed. Node.js 22.22.0 or newer.
