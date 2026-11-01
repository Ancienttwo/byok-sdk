// DeepSeek Harness (`dsh --profile acp`) on the vendored OAR ACP session stack. Upstream OAR has no
// dsh runtime, so this profile is SDK source built on the fork (vendor/oar/ddec7e5/PROVENANCE.md).
import { acpSession } from '../../vendor/oar/ddec7e5/shared/acp/session.js';

/**
 * dsh 0.2.1-rc.5 ACP (docs/plans/2026-11-01-dsh-adapter.md §1). The adapter
 * appends `--patch <file>` through `SessionOptions.launchArgs`. No steer, no
 * vendor notifications. A failed resume is left to the adapter: dsh answers
 * an unknown session and another workspace alike with -32602.
 *
 * @type {import('../../vendor/oar/ddec7e5/shared/acp/profile.js').AcpSessionProfile}
 */
export const dshAcpProfile = {
  args: ['--profile', 'acp'],
  // Native subagents run inside the dsh process; ACP shows only the root session.
  capabilities: { queue: { durable: false }, attribution: 'opaque' },
};

export const dshSession = acpSession(dshAcpProfile);
