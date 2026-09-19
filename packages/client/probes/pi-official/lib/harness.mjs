/**
 * Shared plumbing for OP1 probes.
 *
 * A probe runs as its own process, inside an isolated official-Pi install, and
 * reports one JSON result. Nothing here writes to the repository: the probe root
 * and every runtime directory live under a temporary tree.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const evidenceDir = process.env.PI_PROBE_EVIDENCE_DIR;

export function recordResult(name, result) {
  const payload = { probe: name, ...result };
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(payload)}\n`);
  return payload;
}

/**
 * Describe what the probe concluded about the capability, independently of
 * whether the capability was the one we hoped for. "not-supported" is a result,
 * not a probe failure.
 */
export function verdict(kind, reason, extra = {}) {
  return { verdict: kind, verdictReason: reason, ...extra };
}

/** Collect assertions so a probe reports every failure, not just the first. */
export function createChecks() {
  const checks = [];
  return {
    checks,
    check(name, condition, detail) {
      checks.push({ name, ok: Boolean(condition), detail: detail === undefined ? undefined : String(detail) });
      return Boolean(condition);
    },
    failed: () => checks.filter((entry) => !entry.ok),
    allOk: () => checks.every((entry) => entry.ok),
  };
}

/** Model descriptor for the synthetic provider. Synthetic cost: all zeros. */
export function probeModel({ baseUrl, provider = 'byok-probe', id = 'probe-model' }) {
  return {
    id,
    name: `BYOK probe ${id}`,
    api: 'openai-completions',
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
}

/**
 * Provider registration config for the synthetic endpoint.
 *
 * `streamSimple` is optional: P04 uses it to own the transport while still
 * delegating serialization to the official adapter.
 */
export function probeProviderConfig({ baseUrl, streamSimple }) {
  return {
    name: 'BYOK probe provider',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'synthetic-probe-key',
    models: [{
      id: 'probe-model',
      name: 'BYOK probe probe-model',
      api: 'openai-completions',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 4096,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    }],
    ...(streamSimple ? { streamSimple } : {}),
  };
}

/** Environment summary so the evidence states which interpreter/HOME it ran under. */
export function environmentFacts() {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    home: process.env.HOME,
    installRoot: process.env.PI_PROBE_INSTALL_ROOT,
    officialVersion: process.env.PI_PROBE_OFFICIAL_VERSION,
  };
}
