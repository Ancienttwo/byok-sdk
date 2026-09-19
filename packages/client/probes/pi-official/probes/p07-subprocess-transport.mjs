/**
 * P07 — does the caller-owned transport hold in a separate process?
 *
 * BYOK runs real work in child processes (print/runner). Everything proven so
 * far ran in one process. This probe answers the OP4 scoping question: when a
 * second process builds its own session against the same release, does the
 * caller still observe the exact request bytes, and does a refusal still keep the
 * endpoint at zero?
 *
 * The child script is written into the isolated install root at runtime so its
 * imports resolve to the official release, exactly like the probes themselves.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSyntheticOpenAI } from '../lib/synthetic-openai-server.mjs';
import { createChecks, environmentFacts, recordResult } from '../lib/harness.mjs';

const CHILD_SOURCE = `
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { streamSimple as officialStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';

const baseUrl = process.env.PROBE_BASE_URL;
const refuse = process.env.PROBE_REFUSE === '1';
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p07-child-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const seen = [];
const services = await createAgentSessionServices({
  cwd,
  agentDir,
  modelRuntimeSignal: AbortSignal.timeout(20000),
  resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
});
services.modelRuntime.registerProvider('byok-probe', {
  name: 'child probe provider',
  baseUrl,
  api: 'openai-completions',
  apiKey: 'synthetic-probe-key',
  models: [{
    id: 'probe-model', name: 'child probe model', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 4096,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  }],
  streamSimple: (model, context, options) => officialStreamSimple(model, context, {
    ...options,
    fetch: async (input, init) => {
      seen.push(typeof init?.body === 'string' ? init.body.length : -1);
      if (refuse) throw new Error('child: refused before send');
      return globalThis.fetch(input, init);
    },
  }),
});
await services.modelRuntime.setRuntimeApiKey('byok-probe', 'synthetic-probe-key');
const model = services.modelRuntime.getModel('byok-probe', 'probe-model');
const sessionManager = SessionManager.create(cwd, path.join(root, 'sessions'));
const created = await createAgentSessionFromServices({ services, sessionManager, model, tools: [] });
let promptError;
try {
  await created.session.prompt('probe: child');
} catch (error) {
  promptError = String(error?.message ?? error);
}
try { await created.session.dispose(); } catch { /* ignore */ }
process.stdout.write('CHILD_RESULT ' + JSON.stringify({ pid: process.pid, seen, promptError: promptError ?? null }) + '\\n');
`;

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p07-'));
const installRoot = process.env.PI_PROBE_INSTALL_ROOT;
const server = await startSyntheticOpenAI({ script: () => ({ kind: 'text', text: 'pong' }) });

function runChild(env) {
  return new Promise((resolve) => {
    const childFile = path.join(installRoot, 'child', `p07-${Math.random().toString(36).slice(2)}.mjs`);
    mkdirSync(path.dirname(childFile), { recursive: true });
    writeFileSync(childFile, CHILD_SOURCE);
    const child = spawn(process.execPath, [childFile], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('close', (code) => {
      const line = stdout.split('\n').find((entry) => entry.startsWith('CHILD_RESULT '));
      resolve({ code, stderr, result: line ? JSON.parse(line.slice('CHILD_RESULT '.length)) : undefined });
    });
  });
}

try {
  checks.check('child probes run against the isolated official install', Boolean(installRoot), `installRoot=${installRoot}`);

  const allowed = await runChild({ PROBE_BASE_URL: server.baseUrl, PROBE_REFUSE: '0' });
  checks.check('child process exited cleanly', allowed.code === 0, `code=${allowed.code} stderr=${allowed.stderr.slice(0, 300)}`);
  checks.check('child transport observed an outbound request', allowed.result?.seen?.length === 1, JSON.stringify(allowed.result?.seen));
  checks.check('parent endpoint received exactly one request', server.requestCount() === 1, `count=${server.requestCount()}`);
  const parentBytes = (server.requests[0]?.bodyText ?? '').length;
  checks.check('child and parent observe the same request size', allowed.result?.seen?.[0] === parentBytes, `child=${allowed.result?.seen?.[0]} parent=${parentBytes}`);

  const refused = await runChild({ PROBE_BASE_URL: server.baseUrl, PROBE_REFUSE: '1' });
  checks.check('refusing child exited cleanly', refused.code === 0, `code=${refused.code} stderr=${refused.stderr.slice(0, 300)}`);
  checks.check('refusing child never delivered a request', server.requestCount() === 1, `count=${server.requestCount()}`);
  checks.check('refusing child still reached its transport', (refused.result?.seen?.length ?? 0) > 0, JSON.stringify(refused.result?.seen));
  checks.check('refusing child did not surface the refusal', refused.result?.promptError === null, refused.result?.promptError ?? 'no error surfaced');

  await server.close();

  const supported = checks.allOk();
  recordResult('p07-subprocess-transport', {
    ok: supported,
    verdict: supported ? 'supported' : 'not-supported',
    verdictReason: supported
      ? 'a second process builds its own session against the same release, observes the same request bytes before send, and its refusal keeps the endpoint at zero — the pattern holds across the process boundary'
      : 'the caller-owned transport does not reproduce across a process boundary; see checks',
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      childPids: [allowed.result?.pid, refused.result?.pid],
      allowedChildSeen: allowed.result?.seen ?? [],
      refusedChildSeen: refused.result?.seen ?? [],
      parentRequests: server.requestCount(),
      parentBytes,
      refusedPromptError: refused.result?.promptError ?? null,
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p07-subprocess-transport', {
    ok: false,
    verdict: 'none',
    verdictReason: 'probe could not complete',
    environment: environmentFacts(),
    checks: checks.checks,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
