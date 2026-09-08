# SDK release readiness — current source audit

Audit: 2026-09-08. Scope: read-only release readiness; no package publication, tag, Release creation or deployment. This supersedes the current-blocker conclusions in the earlier `2026-09-08-release-readiness.md`, whose R7/R8/R9 findings describe an older source.

## P1: release boundary

- Local and remote main: `0510bdc58fdbeabdb406be214f774e4cd6e1cb1c`.
- npm SDK train: latest 0.14.0; candidate 0.15.0 across nine packages. Independent keys: latest 0.4.0, candidate 0.4.1.
- No open GitHub PRs or issues at readback. This is bookkeeping evidence, not a proof of absence of defects.
- Four existing root context/architecture modifications and four other dirty worktrees remain outside the frozen release subject.
- Product deployment, Salesko pins/updater qualification and live OS-provider qualification are separate boundaries from npm SDK publication.

## P2: verified release path

1. Exact main push CI `34218336539`: completed/success, 23/23 jobs.
2. Downloaded artifact `10052740640`, `release-pack-0510bdc58fdbeabdb406be214f774e4cd6e1cb1c`.
3. Manifest source SHA matches main. All ten tarballs pass SHA-256, SHA-512 integrity, packed name/version and exact internal SDK dependency checks.
4. Registry reads of all ten candidate name/version pairs return HTTP 404; no candidate version is currently published.
5. Node 22.22.3 official dry run: `node scripts/release/publish.mjs --artifacts _ops/release-audit-20260908/0510bdc` exits 0. It reuses and validates frozen artifacts, skips build/pack, and does not execute account/publish/readback/tag stages.
6. Independent `npm whoami` returns E401. The authenticated account and required auth-and-writes 2FA mode have not passed the execution gate.
7. Remote v0.15.0 tag does not exist. Latest GitHub Release remains v0.13.0; v0.14.0 has a tag but no corresponding Release page in the list.

Local artifact audit: `_ops/release-audit-20260908/artifact-audit.json`; downloaded manifest and tarballs: `_ops/release-audit-20260908/0510bdc/`.

## P3: remaining work and decision

No outstanding mandatory product-code repair was identified in this bounded audit. Earlier durability blockers have landed and exact-main CI and packing pass; a new broad bug hunt or full test rerun is not a release prerequisite established by this evidence.

- Reconcile release notes: doctor public API remains under Unreleased although the 0.15.0 artifact contains it. The spec assigns additive APIs to MINOR; 0.15.0 is still unpublished, so this addition can join that train without inventing a 0.16.0 requirement. Also describe the landed unsupported wire-major admission refusal in the release notes.
- Restore npm authentication, verify the intended account and auth-and-writes policy, then execute the existing frozen-artifact publish driver under explicit publication authorization.
- Complete the actual publication transaction: dependency-order npm writes, registry integrity/dependency readback, annotated tag and remote tag readback; publish the corresponding GitHub Release as part of release communications.
- Keep any documentation-only release-note correction aligned with artifact provenance: the driver requires manifest sourceGitSha equal to HEAD. Do not relabel old tarballs as a new commit. A newly selected source requires its matching CI artifact; alternatively, use the current frozen source and explicitly scoped external release notes.

The next bounded slice is release-note scope reconciliation plus npm account restoration, followed by the existing publish driver. Production migration and downstream rollout remain separate work, not reasons to reopen SDK implementation.
