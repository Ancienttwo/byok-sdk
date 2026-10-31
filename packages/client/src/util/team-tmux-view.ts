import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export type TmuxRunner = (file: string, args: readonly string[]) => Promise<{ stdout?: string; stderr?: string }>;

export class TeamTmuxViewError extends Error {
  constructor(readonly code: 'unsupported_platform' | 'invalid_tmux_binary' | 'tmux_unavailable', message: string) {
    super(message); this.name = 'TeamTmuxViewError';
  }
}

export interface OpenTeamTmuxViewInput {
  tmuxBin: string;
  sessionName: string;
  watcherCommand: string;
  watcherArgs: readonly string[];
  platform?: NodeJS.Platform;
  run?: TmuxRunner;
}

function validSessionName(value: string): boolean { return /^[A-Za-z0-9_-]{1,64}$/u.test(value); }

export async function openTeamTmuxView(input: OpenTeamTmuxViewInput): Promise<{ sessionName: string }> {
  if ((input.platform ?? process.platform) === 'win32') throw new TeamTmuxViewError('unsupported_platform', 'tmux view is unavailable on native Windows');
  if (!path.isAbsolute(input.tmuxBin)) throw new TeamTmuxViewError('invalid_tmux_binary', 'tmux binary must be an explicit absolute path');
  if (!path.isAbsolute(input.watcherCommand)) throw new TeamTmuxViewError('invalid_tmux_binary', 'team watcher command must be an explicit absolute path');
  if (!validSessionName(input.sessionName)) throw new TeamTmuxViewError('invalid_tmux_binary', 'tmux session name must match [A-Za-z0-9_-]{1,64}');
  const run = input.run ?? (async (file, args) => execFileAsync(file, [...args], { windowsHide: true }));
  try { await run(input.tmuxBin, ['-V']); } catch (error) { throw new TeamTmuxViewError('tmux_unavailable', `tmux preflight failed: ${error instanceof Error ? error.message : String(error)}`); }
  // tmux is presentation only: no send-keys/capture-pane and no message body in argv.
  await run(input.tmuxBin, ['new-session', '-d', '-s', input.sessionName, '-n', 'comm', input.watcherCommand, ...input.watcherArgs]);
  return { sessionName: input.sessionName };
}
