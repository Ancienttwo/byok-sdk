import { describe, expect, it, vi } from 'vitest';
import { codexThreadOpen } from '../../vendor/oar/044633e/runtimes/codex/open';
import { createSessionKernel } from '../../vendor/oar/044633e/shared/session-kernel';

describe('OAR 0.80 upstream behavior at SDK seams', () => {
  it('keeps every observer in sequence when an observer emits another record', () => {
    const kernel = createSessionKernel('root');
    const first: number[] = [];
    const second: number[] = [];
    kernel.rawEvents(record => {
      first.push(record.seq);
      if (record.seq === 0) kernel.frame({ type: 'nested', native: {}, events: [] });
    });
    kernel.rawEvents(record => second.push(record.seq));
    kernel.frame({ type: 'outer', native: {}, events: [] });
    expect(first).toEqual([0, 1]);
    expect(second).toEqual([0, 1]);
    expect(kernel.records().map(record => record.seq)).toEqual([0, 1]);
  });

  it('rejects a prompt claiming an input the session never withdrew', async () => {
    const kernel = createSessionKernel('root');
    const decide = vi.fn(() => ({ kind: 'accepted' as const }));
    const result = await kernel.control({ kind: 'prompt', input: 'merged', carries: ['missing'] }, decide);
    expect(result.response.body).toMatchObject({ kind: 'rejected', code: 'unsupported' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses appendSystemPrompt on resume while retaining BYOK approval policy on new sessions', () => {
    expect(() => codexThreadOpen({ cwd: '/workspace', resume: 'saved', appendSystemPrompt: 'rules' }))
      .toThrow('Codex ignores appendSystemPrompt when resuming');
    expect(codexThreadOpen({ cwd: '/workspace', appendSystemPrompt: 'rules', approvalPolicy: 'on-request' }).params)
      .toMatchObject({ developerInstructions: 'rules', approvalPolicy: 'on-request' });
    expect(codexThreadOpen({ cwd: '/workspace', resume: 'saved' }).method).toBe('thread/resume');
  });

  it('refuses unsupported user-configuration exclusion before opening Codex', () => {
    expect(() => codexThreadOpen({ cwd: '/workspace', userConfiguration: 'exclude' }))
      .toThrow('user-configuration exclusion is not supported');
  });
});
