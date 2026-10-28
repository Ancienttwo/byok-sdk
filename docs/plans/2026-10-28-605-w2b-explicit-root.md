# W2 scheme B — blocked implementation draft

Refs #605. Baseline: `671309da6`. This branch is not eligible for main.
Windows `strictLedgerBarrier` remains false, and production `open` does not
call the prepared explicit-root primitive. No guest or power-loss run is made.

## Preconditions for one complete integration

1. Maintainer signs the private helper v3 contract: add an explicit ancestor
   root to `open`; upgrade daemon and helper together, with no v2 compatibility
   reader, fallback root, or mixed-version admission. The current v2 `root`
   continues to mean Agent home and cannot also own the ancestor boundary.
2. A4: the owner approves guest media and the governing evaluation licence.
3. A7: retain the pre-scheme-B revision and run the selected power-loss
   experiment both before and after scheme B on the same recorded storage
   profile. W6 uses the latter evidence. CI process kills do not substitute.

Only after these prerequisites are satisfied should the change complete its
daemon request, helper admission, capability enablement and experiments as one
reviewable work package. This partial branch must remain Draft and blocked.

## P1 / P2 / P3

The TS helper client owns the `open` request; the Go helper pins Agent home
and currently skips the chain barrier on Windows. Unix discovery walks to
the same-volume ancestor and retains descriptor-relative parent/child roots.
Scheme B instead needs an explicit pre-existing, user-writable chain root;
walking to the volume root would force standard users through directories
they cannot flush.

The draft separates ancestor selection from the retained-chain barrier. The
existing Unix path still discovers its chain; the prepared Windows primitive
requires an absolute ancestor containing the canonical home. Both use the
same pinned chain walk, same-file checks, terminal home identity and two
strict flush passes. Volume identity comes from retained handles on Windows.
Any failed flush or changed identity rejects admission. No wire fields or
capability values change in this draft.

The future spec contract is: the caller explicitly supplies the chain root;
each directory from that root through home is on the admitted local NTFS
volume, pinned through its parent, and successfully flushed. No ancestor
above the selected root is flushed. The root's pre-existing durability and
the approved storage profile delimit the claim. Newly created `.byok` and
`notes` still need their owning initialization barriers in the complete v3
integration; this primitive alone is insufficient to admit B.

At 10x path depth, retained handles and flush calls grow linearly with chain
depth. This draft neither changes payload budgets nor adds an unapproved
depth/timeout fallback. The complete v3 request must keep the existing bounded
request transport and fail closed when the chain cannot be established.

Tests exercise the actual directory flushes, exact selected root boundary,
every injected flush failure, non-ancestor roots, and a different pinned home.
They run in the existing Go suites on windows-latest/Windows 2022 and macOS;
neither runner is Windows 10 or an early Windows 11 consumer build.
