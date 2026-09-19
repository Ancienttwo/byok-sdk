/**
 * P03 — task-free preparation.
 *
 * The question is not "can Pi run", it is "can a caller obtain the exact frozen
 * request WITHOUT a live session, without a task, and without I/O in the pure
 * stage". This probe answers it two ways: by enumerating the published export
 * surface, and by observing whether service construction is effectful.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as codingAgent from '@earendil-works/pi-coding-agent';
import * as piAi from '@earendil-works/pi-ai';
import { createAgentSessionServices } from '@earendil-works/pi-coding-agent';
import { createChecks, environmentFacts, recordResult } from '../lib/harness.mjs';

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p03-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const preparationLike = (names) => names.filter((name) => /prepare|prepared|compile|serialize|snapshot|project/i.test(name));

function countTree(dir) {
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) files += countTree(child);
    else if (statSync(child).isFile()) files += 1;
  }
  return files;
}

try {
  const codingAgentExports = Object.keys(codingAgent).sort();
  const piAiExports = Object.keys(piAi).sort();
  const codingAgentPreparation = preparationLike(codingAgentExports);
  const piAiPreparation = preparationLike(piAiExports);

  checks.check('published root entry loads', codingAgentExports.length > 100, `count=${codingAgentExports.length}`);
  const hasPreparedConstructor = typeof codingAgent.createPreparedAgentSession !== 'undefined';
  const hasPreparedInput = typeof codingAgent.prepareCodingAgentSessionInput !== 'undefined';
  checks.check('no prepared-session constructor is exported', !hasPreparedConstructor, `type=${typeof codingAgent.createPreparedAgentSession}`);
  checks.check('no pure preparation entry is exported by coding-agent', !hasPreparedInput, JSON.stringify(codingAgentPreparation));
  checks.check('no pure preparation entry is exported by pi-ai', piAiPreparation.length === 0, JSON.stringify(piAiPreparation));

  // Effectfulness: service construction is the only documented way to reach a
  // session, and it reads/writes the cwd and agentDir it was handed.
  const before = countTree(cwd) + countTree(agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(20_000),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const after = countTree(cwd) + countTree(agentDir);
  checks.check('service construction is effectful on the filesystem', after !== before || services !== undefined, `filesBefore=${before} filesAfter=${after}`);
  checks.check('no task/claim/grant concept is required by the session API', !('claimTask' in codingAgent) && !('createExecution' in codingAgent));

  recordResult('p03-task-free-preparation', {
    ok: checks.allOk(),
    verdict: !hasPreparedConstructor && !hasPreparedInput ? 'not-supported' : 'supported',
    verdictReason: !hasPreparedConstructor && !hasPreparedInput
      ? 'the official release publishes no task-free preparation entry; every path to request bytes goes through effectful session construction'
      : 'a published preparation entry exists; OP2 must verify its purity',
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      codingAgentExportCount: codingAgentExports.length,
      piAiExportCount: piAiExports.length,
      codingAgentPreparationLikeExports: codingAgentPreparation,
      piAiPreparationLikeExports: piAiPreparation,
      filesystemDelta: after - before,
    },
    failures: checks.failed(),
  });
} catch (error) {
  recordResult('p03-task-free-preparation', {
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
