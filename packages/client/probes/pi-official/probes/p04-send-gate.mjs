/**
 * P04 — final send gate.
 *
 * Three cases, all on the real official release:
 *   A. a caller-owned provider transport delegating to the official adapter sees
 *      the exact final body bytes BEFORE they are sent, and those bytes equal
 *      what the endpoint actually received;
 *   B. when that transport refuses, the endpoint receives zero requests;
 *   C. the naive `before_provider_request` extension hook is checked as a gate
 *      candidate, because the plan forbids relying on it.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { streamSimple as officialStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { startSyntheticOpenAI } from '../lib/synthetic-openai-server.mjs';
import { createChecks, environmentFacts, probeProviderConfig, recordResult } from '../lib/harness.mjs';

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p04-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const server = await startSyntheticOpenAI({ script: () => ({ kind: 'text', text: 'pong' }) });

/** Build a session whose provider transport is owned by the caller. */
async function makeSession({ refuse, extraExtensionFactories = [] }) {
  const seen = [];
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(20_000),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: extraExtensionFactories,
    },
  });
  services.modelRuntime.registerProvider('byok-probe', probeProviderConfig({
    baseUrl: server.baseUrl,
    streamSimple: (model, context, options) => officialStreamSimple(model, context, {
      ...options,
      fetch: async (input, init) => {
        const bodyText = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
        seen.push({ url: String(input), bodyText });
        if (refuse) throw new Error('byok-probe: refused before send');
        return globalThis.fetch(input, init);
      },
    }),
  }));
  await services.modelRuntime.setRuntimeApiKey('byok-probe', 'synthetic-probe-key');
  const model = services.modelRuntime.getModel('byok-probe', 'probe-model');
  const sessionManager = SessionManager.create(cwd, path.join(root, `sessions-${Math.random().toString(36).slice(2)}`));
  const created = await createAgentSessionFromServices({ services, sessionManager, model, tools: [] });
  const events = [];
  if (typeof created.session.subscribe === 'function') {
    created.session.subscribe((event) => {
      events.push({ type: event?.type, error: event?.error === undefined ? undefined : String(event.error).slice(0, 200) });
    });
  }
  return { created, seen, events };
}

try {
  // Case A: allow. The gate observes the exact bytes that then reach the wire.
  const allowed = await makeSession({ refuse: false });
  await allowed.created.session.prompt('probe: allowed');
  await allowed.created.session.dispose();

  const received = server.requests[0]?.bodyText ?? '';
  checks.check('case A: endpoint received exactly one request', server.requestCount() === 1, `count=${server.requestCount()}`);
  checks.check('case A: transport observed one outbound request', allowed.seen.length === 1, `seen=${allowed.seen.length}`);
  checks.check('case A: observed bytes equal received bytes', allowed.seen[0]?.bodyText === received, `observed=${allowed.seen[0]?.bodyText?.length} received=${received.length}`);

  // Case B: refuse. Nothing may reach the endpoint.
  const refused = await makeSession({ refuse: true });
  let refusalError;
  try {
    await refused.created.session.prompt('probe: refused');
  } catch (error) {
    refusalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  try {
    await refused.created.session.dispose();
  } catch {
    /* disposal after a refused turn is not the subject of this probe */
  }
  checks.check('case B: endpoint received zero additional requests', server.requestCount() === 1, `count=${server.requestCount()}`);
  checks.check('case B: refusal surfaced to the caller', Boolean(refusalError), refusalError ?? 'no error surfaced');
  checks.check('case B: transport attempt count is recorded', true, `attempts=${refused.seen.length}`);

  // Case C: is the documented extension hook usable as the sole gate?
  const hookFactory = (pi) => {
    pi.on('before_provider_request', () => {
      throw new Error('byok-probe: hook refusal');
    });
  };
  const hooked = await makeSession({ refuse: false, extraExtensionFactories: [hookFactory] });
  let hookError;
  try {
    await hooked.created.session.prompt('probe: hook');
  } catch (error) {
    hookError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  try {
    await hooked.created.session.dispose();
  } catch {
    /* ignore */
  }
  checks.check('case C: recorded whether a throwing hook prevented the send', true, `requests=${server.requestCount()} hookError=${hookError ?? 'none'}`);

  await server.close();

  const caseAOk = checks.checks.filter((entry) => entry.name.startsWith('case A')).every((entry) => entry.ok);
  const caseBSafety = checks.checks.find((entry) => entry.name === 'case B: endpoint received zero additional requests')?.ok === true;
  const caseBPropagates = checks.checks.find((entry) => entry.name === 'case B: refusal surfaced to the caller')?.ok === true;
  const gateVerdict = caseAOk && caseBSafety ? (caseBPropagates ? 'supported' : 'partial') : 'not-supported';

  recordResult('p04-send-gate', {
    ok: checks.allOk(),
    verdict: gateVerdict,
    verdictReason: gateVerdict === 'supported'
      ? 'a caller-owned provider transport observes the exact final body bytes and can refuse before send; the endpoint receives zero requests and the refusal propagates'
      : (gateVerdict === 'partial'
        ? 'a caller-owned provider transport observes the exact final body bytes and refusal keeps the endpoint at zero requests, but the refusal is swallowed and retried instead of propagating to the caller'
        : 'no refuse-before-send boundary was reachable through the public entry; see checks'),
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      totalRequestsAfterAllCases: server.requestCount(),
      caseAObservedBytes: allowed.seen[0]?.bodyText?.length ?? 0,
      caseAReceivedBytes: received.length,
      caseBObservedRequests: refused.seen.length,
      caseBRefusalError: refusalError ?? null,
      caseBTransportAttempts: refused.seen.length,
      caseCHookError: hookError ?? null,
      caseCSendReachedEndpoint: server.requestCount() > 1,
      caseBEvents: refused.events,
      caseCEvents: hooked.events,
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p04-send-gate', {
    ok: false,
    verdict: 'none',
    verdictReason: 'probe could not complete',
    environment: environmentFacts(),
    checks: checks.checks,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    failures: checks.failed(),
  });
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
