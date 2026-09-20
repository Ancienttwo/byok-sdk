import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputPreparationModelSchema } from '@byok-sdk/protocol';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  PREPARED_PROJECTION_COMPARED_MODEL_FIELDS,
  PREPARED_PROJECTION_EXCLUDED_MODEL_FIELDS,
  preparedProviderRegistrationRefusal,
} from '../bin/pi-prepared-host';
import type { InputPreparationModelV1 } from '../input-preparation';
// Relative and test-only, for the same reason the model-parity test states:
// the release graph keeps `@byok-sdk/keys` and the dispatch packages disjoint
// as SHIPPED dependencies, and a test is the one place both authorities can be
// looked at together.
import { PI_PROJECTED_KEY_ENV, buildPiProviderProjection } from '../../../keys/src/pi-provider-projection';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';

const PROBE_SECRET = 'sk-synthetic-consent-probe-0001';
const PROFILE_REF = 'consent-probe';
const PROVIDER_ID = `byok-sdk-${PROFILE_REF}`;
const BASE_URL = 'http://127.0.0.1:9/v1';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const profile = parseModelProviderProfile({
  created_at: '2026-09-21T00:00:00.000Z',
  updated_at: '2026-09-21T00:00:00.000Z',
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: BASE_URL,
  capabilities: [],
  display_name: 'GLM 4.6',
  enabled: true,
  kind: 'model',
  model: 'glm-4.6',
  profile_ref: PROFILE_REF,
  provider_kind: 'custom',
  pi_model: {
    contextWindow: 200_000,
    maxTokens: 8_192,
    reasoning: false,
    thinkingLevel: 'off',
    thinkingLevelMap: PI_MODEL_FIXTURE.thinkingLevelMap,
    compat: PI_MODEL_FIXTURE.compat,
  },
});

type Projection = {
  providers: Record<string, { baseUrl: string; api: string; models: Record<string, unknown>[] }>;
};

function countedModel(): InputPreparationModelV1 {
  const provider = (buildPiProviderProjection(profile) as Projection).providers[PROVIDER_ID]!;
  const entry = provider.models[0]!;
  return {
    id: entry.id as string,
    name: entry.name as string,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: provider.baseUrl,
    reasoning: entry.reasoning as boolean,
    input: entry.input as ('text' | 'image')[],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow as number,
    maxTokens: entry.maxTokens as number,
    thinkingLevelMap: entry.thinkingLevelMap as InputPreparationModelV1['thinkingLevelMap'],
    compat: entry.compat as InputPreparationModelV1['compat'],
  };
}

describe('the consent gate’s compared-field list', () => {
  it('accounts for every field the wire model can carry', () => {
    const wireFields = Object.keys(InputPreparationModelSchema.shape).sort();
    const accounted = [
      ...PREPARED_PROJECTION_COMPARED_MODEL_FIELDS,
      ...PREPARED_PROJECTION_EXCLUDED_MODEL_FIELDS,
    ].sort();
    // A body-affecting field added to the wire model MUST be added to the gate
    // (or to the commented exclusion list) in the same work-package; otherwise
    // the device and the Host could declare it differently while this process
    // already holds the device's credential.
    expect(accounted).toEqual(wireFields);
  });

  it('excludes only cost, and compares everything else', () => {
    expect([...PREPARED_PROJECTION_EXCLUDED_MODEL_FIELDS]).toEqual(['cost']);
    expect([...PREPARED_PROJECTION_COMPARED_MODEL_FIELDS]).toEqual([
      'api', 'baseUrl', 'compat', 'contextWindow', 'id', 'input', 'maxTokens', 'name',
      'provider', 'reasoning', 'thinkingLevelMap',
    ]);
  });

  it('names the same launcher-delivered credential variable the keys projection references', () => {
    expect(PI_PROJECTED_KEY_ENV).toBe('PI_PROVIDER_API_KEY');
    const provider = (buildPiProviderProjection(profile) as Projection)
      .providers[PROVIDER_ID] as unknown as { apiKey: string };
    expect(provider.apiKey).toBe(`$${PI_PROJECTED_KEY_ENV}`);
  });
});

describe('provider resolution in the installed fork', () => {
  async function runtime(): Promise<ModelRuntime> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-consent-probe-')));
    dirs.push(dir);
    return ModelRuntime.create({
      authPath: path.join(dir, 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  }

  it('resolves no credential for an unregistered projected provider, and one after registration', async () => {
    vi.stubEnv(PI_PROJECTED_KEY_ENV, PROBE_SECRET);
    const model = countedModel();
    const rt = await runtime();
    // The fact the whole K-3 gate exists for: `Models.getAuth` answers
    // `undefined` for a provider id it does not hold, BEFORE it reads any
    // credential store — so mirroring a key into pi's `auth.json` could never
    // have made a `byok-sdk-<ref>` model resolvable.
    await expect(rt.getAuth(model as never)).resolves.toBeUndefined();

    const provider = (buildPiProviderProjection(profile) as Projection).providers[PROVIDER_ID]!;
    rt.registerProvider(PROVIDER_ID, provider as never);
    const resolved = await rt.getAuth(model as never) as
      { auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> } } | undefined;
    expect(resolved?.auth.apiKey).toBe(PROBE_SECRET);
    expect(resolved?.auth.headers?.Authorization).toBe(`Bearer ${PROBE_SECRET}`);
    // No locally configured endpoint travels back in the auth result, so the
    // native `prepared_endpoint_mismatch` check cannot misfire on it — and
    // equally cannot close the hole this SDK's consent gate closes.
    expect(resolved?.auth.baseUrl).toBeUndefined();
  });

  it('refuses a registration failure with a fixed literal that no fork exception can reach', async () => {
    vi.stubEnv(PI_PROJECTED_KEY_ENV, PROBE_SECRET);
    const rt = await runtime();
    // A REAL exception from the REAL fork call the host makes, composed by the
    // fork from the values it was handed — which is exactly why the host may
    // not repeat it: `registerProvider` and `getAuth` are the two calls on this
    // path that touch the resolved device credential, and a projection field
    // could just as well have been the secret itself.
    let thrown: unknown;
    try {
      rt.registerProvider(PROVIDER_ID, {
        baseUrl: BASE_URL,
        apiKey: `$${PI_PROJECTED_KEY_ENV}`,
        models: [{ id: PROBE_SECRET }],
      } as never);
    } catch (cause) {
      thrown = cause;
    }
    const foreign = (thrown as Error | undefined)?.message;
    expect(foreign).toContain(PROBE_SECRET);

    for (const site of ['register', 'resolve'] as const) {
      const refusal = preparedProviderRegistrationRefusal(site);
      expect(refusal.startsWith('prepared_provider_registration_failed: ')).toBe(true);
      // The whole line the host writes to stderr for this refusal: `fail()`
      // prefixes the process name and writes nothing else.
      const stderr = `byok-pi-prepared: ${refusal}\n`;
      expect(stderr).not.toContain(PROBE_SECRET);
      expect(stderr).not.toContain(foreign!);
      expect(stderr).not.toContain(PI_PROJECTED_KEY_ENV);
    }
    // Two sites, two fixed details — the refusal still says WHICH call failed
    // without saying anything the call said.
    expect(preparedProviderRegistrationRefusal('register'))
      .not.toBe(preparedProviderRegistrationRefusal('resolve'));
  });

  it('registers from the $ reference and reaches no network while doing it', async () => {
    vi.stubEnv(PI_PROJECTED_KEY_ENV, PROBE_SECRET);
    const requests: string[] = [];
    const connect = net.Socket.prototype.connect;
    const fetchImpl = globalThis.fetch;
    net.Socket.prototype.connect = function trapped(this: net.Socket, ...args: unknown[]): net.Socket {
      requests.push(`socket:${JSON.stringify(args[0])}`);
      throw new Error('the registration probe reached the network');
    } as typeof net.Socket.prototype.connect;
    globalThis.fetch = ((...args: unknown[]) => {
      requests.push(String(args[0]));
      throw new Error('the registration probe reached the network');
    }) as typeof globalThis.fetch;
    try {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-consent-egress-')));
      dirs.push(dir);
      const rt = await ModelRuntime.create({
        authPath: path.join(dir, 'auth.json'), modelsPath: null,
        allowModelNetwork: false, refreshOnCreate: false,
      });
      const provider = (buildPiProviderProjection(profile) as Projection).providers[PROVIDER_ID]!;
      expect(JSON.stringify(provider)).not.toContain(PROBE_SECRET);
      rt.registerProvider(PROVIDER_ID, provider as never);
      // `registerProvider` ends with a floating `refresh({allowNetwork:false})`;
      // give it a turn to land before measuring.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(requests).toEqual([]);
      // With `modelsPath: null` the models store is in memory, so that refresh
      // writes nothing into the launcher-owned projection directory either.
      expect(await fs.readdir(dir)).toEqual(['auth.json']);
    } finally {
      net.Socket.prototype.connect = connect;
      globalThis.fetch = fetchImpl;
    }
  });
});
