# Disposable Salesko consumer result

The read-only Salesko worktree was copied to a disposable directory. Only that
copy received temporary absolute `file:` dependencies pointing at the exact
tarballs in this directory. The original Salesko worktree, its manifests, and
its lockfile were not changed; no deliverable manifest or lockfile retains a
`file:`, `link:`, or git dependency edge.

| Subject | SHA-256 | Outcome |
| --- | --- | --- |
| GA-01 device credential falsifier | `cba06056cbda569e8e8e0f99c80b9d341d8ae593638a984198d434e976c0a886` | Pass: paired metadata had no access-token/private-key fields. |
| GA-02 strict admission falsifier | `a3c498868313bfac8b3a620d4759b21060f29bdad31179030bd3aae740a75179` | Expected red pre-fix: its own host composition omits `strictAgentOnly`; both variants start and create a workspace. File/hash unchanged. |
| Phase B strict admission subject | `dee410fe02786c922ec586b9f4a9689d0ba212d63dc4c2536f6d98aafea07f27` | Pass (2): strict capability is durable and both explicit legacy producer dispatches reject before a task record. |
| Runtime session/lease consumer | `aa0899e19694998b666d159e5b325b6704b295a777f087d0f6f8a4ec1902df02` | Pass (6). |
| Root-only falsifier | `7f4a90fc2d453c99940c23c0ce223d96b6d7db7c2b8f786efa8f2193d0468f3e` | Fail outside this package: untouched Salesko `workspaceRoot` and `storeDir` do not both remain under supplied `SALESKO_HOME`. |

The Phase B subject is archived alongside this manifest so independent gates
can reproduce it in a fresh disposable Salesko copy. It supplements, and does
not edit or rehash, the immutable GA-02 pre-fix subject.
