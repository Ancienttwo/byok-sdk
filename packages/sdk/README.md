# byok-sdk

The complete BYOK dispatch SDK. It groups the six public dispatch packages by
their ownership boundary:

```ts
import { client, cloud, cloudPostgres, core, protocol, server } from 'byok-sdk';
```

- `client`: the end-user daemon and local runtime adapters.
- `server`: the self-hosted in-memory coordinator.
- `cloud`: stateless hosted HTTP handlers and in-memory composition.
- `cloudPostgres`: durable Postgres + R2 composition and migrations.
- `core`: tenant-first platform contracts and store ports.
- `protocol`: the frozen v1 device wire contract.

`@byok-sdk/keys` is deliberately not exported or installed by this package.
Provider-key custody has a separate security model; install it explicitly only
when the host needs direct provider transports.

See the [repository README](https://github.com/Ancienttwo/byok-sdk#readme) for
composition examples and operational boundaries.

## License

MIT
