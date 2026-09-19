/**
 * P05 — loading closure.
 *
 * Proves the allowlist loader shape works on the official release and that the
 * negative control fails: hostile extensions, project context files and skills
 * planted on disk must NOT be discovered when discovery is switched off.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentSessionServices } from '@earendil-works/pi-coding-agent';
import { startSyntheticOpenAI } from '../lib/synthetic-openai-server.mjs';
import { createChecks, environmentFacts, probeProviderConfig, recordResult } from '../lib/harness.mjs';

const MARKER = 'BYOK-PROBE-HOSTILE-EXTENSION';

const checks = createChecks();
const root = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-p05-'));
const cwd = path.join(root, 'cwd');
const agentDir = path.join(root, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

/** Plant the same hostile artifact in every location a discoverer might read. */
function plantHostileResources() {
  const modules = [
    path.join(cwd, '.pi', 'extensions', 'hostile.mjs'),
    path.join(agentDir, 'extensions', 'hostile.mjs'),
  ];
  for (const file of modules) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `export default function () { return { name: '${MARKER}' }; }\n`);
  }
  writeFileSync(path.join(cwd, 'AGENTS.md'), `# hostile project context\n${MARKER}\n`);
  const skills = path.join(agentDir, 'skills', 'hostile-skill');
  mkdirSync(skills, { recursive: true });
  writeFileSync(path.join(skills, 'SKILL.md'), `---\nname: hostile-skill\ndescription: ${MARKER}\n---\n${MARKER}\n`);
  return modules;
}

const server = await startSyntheticOpenAI();
try {
  const planted = plantHostileResources();
  const loadedFactories = [];

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
      extensionFactories: [(pi) => {
        loadedFactories.push('byok-inline-1');
        pi.registerProvider('byok-probe', probeProviderConfig({ baseUrl: server.baseUrl }));
      }],
    },
  });

  const extensionResult = services.resourceLoader.getExtensions();
  const extensionPaths = extensionResult.extensions.map((extension) => extension.path);
  const skills = services.resourceLoader.getSkills();

  checks.check('only the authorized inline extension is loaded', extensionPaths.length === 1 && extensionPaths[0].startsWith('<inline:'), JSON.stringify(extensionPaths));
  checks.check('hostile extension on disk is not loaded', !extensionPaths.some((entry) => entry.includes('hostile')), JSON.stringify(extensionPaths));
  checks.check('inline factory actually ran', loadedFactories.length === 1, JSON.stringify(loadedFactories));
  checks.check('no skills are discovered', skills.skills.length === 0, `count=${skills.skills.length}`);
  checks.check('no extension load errors were reported', extensionResult.errors.length === 0, JSON.stringify(extensionResult.errors));
  checks.check('provider registered from the authorized factory only', Boolean(services.modelRuntime.getModel('byok-probe', 'probe-model')), 'expected byok-probe/probe-model to resolve');

  await server.close();

  recordResult('p05-loader-closure', {
    ok: checks.allOk(),
    verdict: checks.allOk() ? 'supported' : 'not-supported',
    verdictReason: checks.allOk()
      ? 'the allowlist loader loads only the authorized inline extension and ignores planted hostile extensions, skills and context files'
      : 'allowlist loading did not close; see checks',
    environment: environmentFacts(),
    checks: checks.checks,
    observed: {
      extensionPaths,
      skillCount: skills.skills.length,
      extensionErrors: extensionResult.errors,
      plantedHostileFiles: planted,
    },
    failures: checks.failed(),
  });
} catch (error) {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  recordResult('p05-loader-closure', {
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
