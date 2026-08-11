# Review: S6-c Daemon Proof and Memory Path

> **Status**: Accepted

## Review history

- `42632c06616e2947411a006cba1338e3b6608f9c`: **REJECTED** by independent Codex read-only security review (session `019fe317-20e8-72b2-bf60-b22c6c79a142`).
  - HIGH-1: unbounded object `downloadUrl` plus automatic redirects created a daemon SSRF surface.
  - HIGH-2: syntactically valid write responses were not semantically bound to the requested primary and ordered snapshots.
- `ead8a8746188b8f480c0115ad556b766dfbd73fa`: **ACCEPTED** by independent Codex read-only security review (session `019fe324-7ce7-7311-87a9-349184499800`).
  - HIGH-1 closed: exact credential-free HTTP(S) origin allowlist plus `redirect: manual` prevents object-grant SSRF and redirect escape.
  - HIGH-2 closed: primary and ordered snapshots are bound to selector, next revision, content hash and byte size; duplicate selectors fail before signing/network.
  - The complete S6 stack was reviewed from exact base `2a1c4a7acb250ef38eee54ae9cec2e4fc48dbb85`; no blocking proof, bearer-isolation, Postgres atomicity, migration/protocol or daemon-memory finding remains.

Claude review is paused and must not be invoked.

## Acceptance Receipt Projection

- Disposition: `external_pass`
- Reviewer: independent Codex (`openai`, `gpt-5.6-sol`, read-only)
- Reviewed target: `2a1c4a7acb250ef38eee54ae9cec2e4fc48dbb85`
- Reviewed subject: `ead8a8746188b8f480c0115ad556b766dfbd73fa`
- Receipt: `ACCEPTED: ead8a8746188b8f480c0115ad556b766dfbd73fa`
