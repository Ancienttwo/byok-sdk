import type { RuntimeAdapter } from '../../types';
import type { AssertionIssueProbe, DaemonConfig, DaemonOverrides } from '../create-daemon';

/** `buildDaemonWithAdapters`' own parameters, as its stages receive them (#926). */
export interface DaemonInputs {
  readonly config: DaemonConfig;
  readonly adapters: RuntimeAdapter[];
  readonly overrides: DaemonOverrides;
  readonly assertionProbe: AssertionIssueProbe | undefined;
}
