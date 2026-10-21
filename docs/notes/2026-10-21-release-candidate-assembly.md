# Local release candidate source ledger

Base: `d0350c6bf6c36dafd303179e3f1e5cef71b20ef9`.
Branch: `integration/byok-batch-20261021`. No push, publication or main merge.

| Approved source | Exact source SHA |
| --- | --- |
| 638 | `4ed8355aff645ea803ac1339aa83b9685fc814dc` |
| 639 | `28b745d0c7b134d537fd5041c561827d39071b1d` |
| 640 | `2aef5b4a7ad76f1078355e8243ce78186d39d08d` |
| 641 | `82cccdd75a0dfeec0814914af0ed13aa1b0d3fde` |
| 642 | `e69a819cd07bf0468a1c437b00db99d475c2f6b4` |
| 642 fixture repair | `c52a3ff20f01ac8600c2edcc6165a00de86b2ff0` |
| 643 | `79ac966323a9f2f45d8a8ac9e5097dab3f37a948` |
| 644 | `7f5c9c32c1ce03eb1769571f4e6708612c6f6d44` |
| 645 | `44d5a513208945037747aa7c8ffd5ed939c4fd2e` |
| 646 | `825486f2a73a4c82e01d3a4d2b7a639786b28e58` |
| 647 | `5ac357893c733b2fbd9b989e0ef59413a6cddb38` |
| 648 | `420849f93a7aa7c3ddf108f5c64a7581edb7cf37` |
| CI local | `6daf2c49c5f0099ad7c7f396beb5c9f8d5455d2a` |
| 630 local | `7b98809f7d129f0c3e616d9ea75bf1e04badd29d` |
| 632 local | `591a542a566a3ea0e063065dd8ebff1005264257` |
| 623 exact PR head | `b09a42d01b2cbf2b5951c54ee7fb9e5486afc97a` |
| 629 local | `3dfb12615f37a533221b536b3b0b12d04f1003f0` |

PR623 head was verified through GitHub and a direct branch fetch. Its merge commit
was merged locally, preserving its main synchronization and retirement guards;
the stale local source branch was not substituted. Other sources were cherry-picked.

## Conflict decisions

- CI packaging retains loopback, SQLite SEA, Windows native-assets SEA and macOS
  cross-copy steps. Memory export's Linux job and restore checks remain. The
  required aggregate and inventory test now include all 14 job families.
- Hermes detect/gateway/viewer retain custody launcher arguments and allowlisted
  environment while forwarding per-adapter nativeAssetRoot to owned processes.
- Public exports, documentation and API declarations retain both additive sides.
- K4 retains restore's same-ledger binding and cleanup plus event subscription,
  outbox subscription, abort/drain and reentrancy cleanup. Invalid event iterators
  also release the new ledger binding.
- Host ledger transaction combines retired-intent insertion guards with
  post-commit projection notification. Receipt ingestion uses that same atomic
  ledger transaction. Compaction preserves unsettled execution receipts and memory
  restore state, but removes settled acknowledged executions including their
  message receipts under the explicit retention policy.
- Main's stateless HTTP response finalizer could not be applied verbatim to
  progress SSE: headers resolve before handler completion. Stateless progress
  cores now retire on reply completion/cancellation/error; ordinary JSON retains
  its existing finalizer. Stateless SSE omits session IDs. Focused combined tests
  cover completion, reader cancellation, server close and unread queue overflow.
  Superseded on 2026-10-22: main's merged #647 makes stateless HTTP reject
  progress requests with 400. The owner chose main's contract when this branch
  merged main `1e5326eb`, so the stateless progress SSE code and its tests are gone.
- API budget conflicts kept interim values until the single cumulative workspace
  build. Only measured exceeded entries changed to exact resulting sizes:

| Entry | Interim ceiling | Measured cumulative ceiling |
| --- | ---: | ---: |
| `@byok-sdk/client` | 2053644 | 2069201 |
| `@byok-sdk/client/agent-memory` | 67427 | 68657 |
| `@byok-sdk/client/mcp-server/http` | 34179 | 36476 |
| `@byok-sdk/cloud` | 533880 | 534369 |
| `@byok-sdk/cloud-dataplane` | 783752 | 784241 |
| `@byok-sdk/protocol` | 127572 | 127926 |
| `@byok-sdk/ui-runtime` | 562140 | 562629 |

No dependency admission policy, assertion, timeout or platform skip was relaxed.

## Validation

Single workspace build, workspace typecheck, API surface and version authority
passed. CI contract tests pass. Original build/API measurement logs are retained
at task-4/evidence-candidate-*.log. Full workspace tests were not run locally.
Focused combined integration test outcomes and final independent reviews are
reported separately against the final candidate SHA. Hosted full-matrix validation
remains pending the parent's single combined-candidate push.

Fresh-main check after assembly found `95357bb07ba7b1b45a75ba463a170a75af435bd1`,
which merges #638 (`4ed8355a`, already included above). Synchronizing this ancestry
must preserve the assembled source tree. HTTP suite: 38 passed. K4 message/events/
restore selection: 34 passed across three files. The initially selected filename
`compaction.test.ts` did not exist; actual `retention.test.ts` and
`event-wake-count.test.ts` were run separately, not claimed covered by that run.
