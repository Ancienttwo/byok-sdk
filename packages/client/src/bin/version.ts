import { OFFICIAL_LOCAL_AGENT_RELEASE } from './official-release';

/** Zero-state command: one constant projection, no config, store, runtime, or network dependency. */
export function runVersionCommand(log: (line: string) => void = console.log): void {
  log(OFFICIAL_LOCAL_AGENT_RELEASE.version);
}
