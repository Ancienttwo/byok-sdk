/**
 * P08 — is the surface an embedder needs actually exported?
 *
 * The migration's remaining work is blocked on a small set of public exports,
 * and prose cannot tell us when they appear. This probe turns that list into a
 * checked fact about the installed release, so that checking a new version is a
 * run rather than a re-read.
 *
 * It imports only package roots — the same thing a consumer of the published
 * package can do — so a symbol reachable here is reachable for real, and a
 * symbol that only exists inside the source tree does not count.
 */
import * as codingAgent from '@earendil-works/pi-coding-agent';
import * as piAi from '@earendil-works/pi-ai';
import { createChecks, environmentFacts, recordResult } from '../lib/harness.mjs';

const checks = createChecks();

/** Exports the migration needs, with what each one unblocks. */
const REQUIRED = [
  {
    name: 'getSystemMessageText',
    from: piAi,
    pkg: '@earendil-works/pi-ai',
    unblocks: 'rendering a system message state into text',
  },
  {
    name: 'createReadToolDefinition',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'reproducing a session tool declaration',
  },
  {
    name: 'createBashToolDefinition',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'reproducing a session tool declaration',
  },
  {
    name: 'createEditToolDefinition',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'reproducing a session tool declaration',
  },
  {
    name: 'createWriteToolDefinition',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'reproducing a session tool declaration',
  },
  {
    name: 'buildSystemPromptSections',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'projecting resolved prompt options into sections',
  },
  {
    name: 'buildSystemPromptState',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'building the leading system message state',
  },
  {
    name: 'RPC_MAX_FRAME_BYTES',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'bounding an outbound frame to the runtime reader limit',
  },
  {
    name: 'fitsRpcFrame',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'bounding an outbound frame to the runtime reader limit',
  },
  {
    name: 'rpcFrameByteLength',
    from: codingAgent,
    pkg: '@earendil-works/pi-coding-agent',
    unblocks: 'bounding an outbound frame to the runtime reader limit',
  },
];

const surface = REQUIRED.map((entry) => ({
  name: entry.name,
  pkg: entry.pkg,
  unblocks: entry.unblocks,
  present:
    typeof entry.from[entry.name] === 'function' || typeof entry.from[entry.name] === 'number',
}));

const present = surface.filter((entry) => entry.present);
const missing = surface.filter((entry) => !entry.present);

checks.check(
  'package roots are importable',
  Object.keys(codingAgent).length > 0 && Object.keys(piAi).length > 0,
  `coding-agent=${Object.keys(codingAgent).length} pi-ai=${Object.keys(piAi).length}`,
);
checks.check(
  'tool definition factories are exported',
  surface.filter((entry) => entry.name.startsWith('create')).every((entry) => entry.present),
  JSON.stringify(surface.filter((entry) => entry.name.startsWith('create') && !entry.present).map((entry) => entry.name)),
);
checks.check(
  'the missing exports are recorded rather than assumed',
  true,
  `missing=${JSON.stringify(missing.map((entry) => entry.name))}`,
);

const verdict = missing.length === 0 ? 'supported' : present.length > 0 ? 'partial' : 'not-supported';

recordResult('p08-embedder-public-surface', {
  ok: true,
  verdict,
  verdictReason:
    verdict === 'supported'
      ? 'every export the migration needs is on a package root; the blocked steps can proceed'
      : `still missing from package roots: ${missing.map((entry) => entry.name).join(', ')}`,
  environment: environmentFacts(),
  checks: checks.checks,
  observed: {
    present: present.map((entry) => `${entry.pkg}:${entry.name}`),
    missing: missing.map((entry) => `${entry.pkg}:${entry.name}`),
    requiredCount: REQUIRED.length,
  },
  failures: checks.failed(),
});
