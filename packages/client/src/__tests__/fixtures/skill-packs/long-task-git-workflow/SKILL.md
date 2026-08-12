---
name: long-task-git-workflow
description: Use when a task will span multiple sessions or days and its state must survive a crash, a context reset, or a handoff. Keeps a Git-backed ledger of task state, commits one entry per state transition, and recovers the last known position from git log and git reflog instead of from memory.
---

# Long-task Git workflow

A task that outlives one session cannot keep its state in your context. Anything
you remember is gone at the next reset; anything you commit is still there. This
skill puts the task's state in Git, so "where was I" is a question the
repository answers.

Use it when the work spans more than one sitting: a migration, a multi-stage
refactor, a long investigation, a release train. Do not use it for a task you
will finish in one pass — a ledger costs more than it returns there.

## The ledger

Keep one file, `TASK-LEDGER.md`, at the root of the working directory. It holds
the goal, the current state, and the transitions so far. It is the only place
task state lives.

Initialize once, at the start:

```bash
git init                      # skip if the directory is already a repository
git add TASK-LEDGER.md
git commit -m "task: open <task-id> — <one-line goal>"
```

If the directory is already a repository with unrelated history, do not
reinitialize it and do not create a branch unless you were asked to. Add the
ledger to the existing history.

The ledger has three sections and no more:

```markdown
# Task <task-id>

## Goal
One paragraph. What "done" means, in terms someone else can check.

## State
One of: open | in-progress | blocked | verifying | done.
Plus one line naming the exact next action.

## Log
- <ISO timestamp> open — <what was decided>
- <ISO timestamp> in-progress — <what was attempted>
- <ISO timestamp> blocked — <what is blocking, and what would unblock it>
```

## One commit per state transition

Commit when the STATE changes, not when a file changes. A state transition is:
you started work, you finished a unit, you got blocked, you unblocked, you began
verification, you finished.

```bash
# after editing the State and Log sections of the ledger
git add -A
git commit -m "task: <task-id> <old-state> -> <new-state> — <what changed>"
```

Two rules make the history readable later:

- **The ledger edit and the work it describes go in the same commit.** A commit
  that says "blocked" while the ledger still says "in-progress" makes the
  history a second, unreliable authority.
- **The subject line names the transition.** `git log --oneline` then reads as
  the task's state machine, which is the whole point.

Between transitions, commit ordinary work normally. Do not commit broken
intermediate states with a `task:` subject — reserve that prefix for
transitions, so a later `git log --grep` finds exactly the state changes.

## Recovering after a reset

Never reconstruct state from what you think you remember. Read it:

```bash
git log --oneline -20                    # the recent shape of the work
git log --oneline --grep '^task:'        # transitions only — the state machine
git show HEAD:TASK-LEDGER.md             # the committed ledger, not the working copy
git status --short                       # what was in flight when you stopped
git diff                                 # uncommitted work you left behind
```

Read the ledger's `State` section first and take its "next action" line
literally. If `git status` shows uncommitted changes, they are work that was in
flight — decide whether to finish or discard them BEFORE recording a new
transition, and say which you did in the log entry.

If the ledger disagrees with the repository (it says `done` and tests fail, or
it says `open` and half the work is committed), trust the repository and correct
the ledger in the next commit. Note the correction in the log; a silently
rewritten ledger destroys the only record of what went wrong.

## When a commit seems to have vanished

`git log` shows the current branch's history. Work you cannot find there — after
an amend, a reset, or a checkout that moved HEAD — is usually still reachable:

```bash
git reflog                        # every position HEAD has held, newest first
git show <sha>                    # inspect a candidate before acting on it
git branch recovered/<task-id> <sha>   # park it on a branch, then decide
```

Park a recovered commit on a branch and inspect it. Do not reset the current
branch onto it to "get it back" — that trades one lost state for another.

## Boundaries

- Never run network Git (`clone`, `fetch`, `pull`, `push`) as part of this
  workflow. The ledger is local state; publishing it is a human decision.
- Never rewrite history (`rebase`, `reset --hard`, `commit --amend` on a commit
  that is already the ledger's record, `stash drop`, branch deletion). Recovery
  depends on the history being append-only.
- Never configure or change Git identity. If no identity is configured, commit
  the ledger changes as a working-tree file and say so in your report rather
  than setting one.
- Leave incomplete work visible. An uncommitted, clearly-described mess is
  recoverable; a cleaned-up directory is not.

## Reporting

When you stop — finished, blocked, or out of time — end with the current state,
the last `task:` commit's short SHA, and the exact next action. That triple is
what makes the next session (or the next agent) able to continue instead of
restart.
