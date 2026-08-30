import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openTeamTmuxView } from '../bin/team-tmux-view';

describe('team tmux view', () => {
  it('requires an explicit absolute tmux binary and rejects native Windows', async () => {
    await expect(openTeamTmuxView({ tmuxBin: 'tmux', sessionName: 'team', watcherCommand: '/bin/echo', watcherArgs: [] })).rejects.toMatchObject({ code: 'invalid_tmux_binary' });
    await expect(openTeamTmuxView({ tmuxBin: 'C:\\tmux.exe', sessionName: 'team', watcherCommand: 'C:\\watch.exe', watcherArgs: [], platform: 'win32' })).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it('creates one comm pane without terminal-text IPC verbs or message bodies', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const run = vi.fn(async (file: string, args: readonly string[]) => { calls.push({ file, args }); return { stdout: 'tmux 3.7c' }; });
    const tmuxBin = path.resolve('/opt/homebrew/bin/tmux');
    await openTeamTmuxView({ tmuxBin, sessionName: 'byok-team', watcherCommand: '/usr/bin/node', watcherArgs: ['/safe/byok-agent.js', 'team', 'watch', '--workspace', 'room'], run });
    expect(calls[0]).toEqual({ file: tmuxBin, args: ['-V'] });
    expect(calls[1]?.args.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'byok-team', '-n', 'comm']);
    expect(calls.flatMap((call) => call.args)).not.toContain('send-keys');
    expect(calls.flatMap((call) => call.args)).not.toContain('capture-pane');
    expect(JSON.stringify(calls)).not.toContain('secret message body');
  });
});
