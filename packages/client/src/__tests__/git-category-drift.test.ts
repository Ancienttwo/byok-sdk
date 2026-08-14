import { describe, expect, it } from 'vitest';
import { STABLE_GIT_ERROR_CATEGORIES as AUDIT_LOG_ERROR_CATEGORIES } from '../bin/audit-log';
import { STABLE_GIT_ERROR_CATEGORIES as FORMAT_ERROR_CATEGORIES } from '../bin/format';
import {
  STABLE_GIT_ERROR_CATEGORIES as TASKS_VIEW_ERROR_CATEGORIES,
  STABLE_GIT_PHASES,
} from '../bin/tasks-view';
import { STABLE_ERROR_CATEGORIES as WORKSPACES_COMMAND_ERROR_CATEGORIES } from '../bin/commands/workspaces';
import { GIT_ERROR_CATEGORIES, GIT_WORKSPACE_PHASES } from '../daemon/git-workspace';

// Runtime half of the O-5 single-source-of-truth guarantee: the compile-time
// half (every union member listed, no non-members listed) lives in
// `daemon/git-workspace.ts`'s `AssertExhaustive` proofs. Here we pin that the
// exported constants carry no duplicates and that every CLI stable-output
// validator projects EXACTLY the exported constant — nobody can re-harden a
// consumer with a literal copy (or a subset/superset) without failing this.

describe('git category/phase single source of truth (drift guard)', () => {
  it('GIT_ERROR_CATEGORIES lists every category exactly once', () => {
    expect(new Set(GIT_ERROR_CATEGORIES).size).toBe(GIT_ERROR_CATEGORIES.length);
  });

  it('GIT_WORKSPACE_PHASES lists every phase exactly once', () => {
    expect(new Set(GIT_WORKSPACE_PHASES).size).toBe(GIT_WORKSPACE_PHASES.length);
  });

  it('every CLI stable-output category validator projects exactly GIT_ERROR_CATEGORIES', () => {
    const projection = new Set(GIT_ERROR_CATEGORIES);
    expect(FORMAT_ERROR_CATEGORIES).toEqual(projection);
    expect(AUDIT_LOG_ERROR_CATEGORIES).toEqual(projection);
    expect(TASKS_VIEW_ERROR_CATEGORIES).toEqual(projection);
    expect(WORKSPACES_COMMAND_ERROR_CATEGORIES).toEqual(projection);
  });

  it('the tasks-view stable phase filter projects exactly GIT_WORKSPACE_PHASES', () => {
    expect(STABLE_GIT_PHASES).toEqual(new Set(GIT_WORKSPACE_PHASES));
  });
});
