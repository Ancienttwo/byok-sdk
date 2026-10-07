import { describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ finish: undefined as undefined | (() => void), calls: [] as unknown[] }));
vi.mock('../subagents/runner-bridge.js', () => ({
  runSubagentRunnerEntry: (argv: readonly string[]) => {
    bridge.calls.push(argv);
    return new Promise<void>((resolve) => { bridge.finish = resolve; });
  },
}));

const { runSubagentRunner } = await import('../bin/subagent-runner-host');

describe('runSubagentRunner', () => {
  it('settles only when the vendored runner entry has finished its run', async () => {
    let settled = false;
    const run = runSubagentRunner('/tmp/runner config.json').then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.calls).toEqual([['/tmp/runner config.json']]);
    expect(settled).toBe(false);
    bridge.finish!();
    await run;
    expect(settled).toBe(true);
  });
});
