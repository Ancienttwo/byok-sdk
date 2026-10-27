import { readFileSync } from 'node:fs';
import { openSealedContent } from '@byok-sdk/core/sealed-payload';
import type { AgentRef, TaskSealing } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { routineTemplateBinding, sealRoutineTemplate, type RoutineRef, type SealedTaskInput } from './sealed-routine';

// The golden corpus seals its routine lines with this scope key, in tenant `tenant-golden` (cloud sealed-payload-wire test).
const CORPUS_SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CORPUS_TENANT = 'tenant-golden';
const MAX = 2 * 1024 * 1024;
type Line = { payload: { routineRef?: RoutineRef; agentRef: AgentRef; sealing: TaskSealing; sealed: SealedTaskInput } };
const routineLines = readFileSync(new URL('../../../packages/protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n').map(raw => JSON.parse(raw) as Line).filter(line => line.payload.routineRef !== undefined);

function open(sealed: SealedTaskInput, binding: ReturnType<typeof routineTemplateBinding>, sealing: TaskSealing, scopeKey = CORPUS_SCOPE_KEY) {
  const { ciphertext, ...header } = sealed as SealedTaskInput & { ciphertext: string };
  return openSealedContent({ header, ciphertext: Buffer.from(ciphertext, 'base64url'), scopeKey, binding,
    sealing: { scopeId: sealing.scopeId, epoch: sealing.epoch }, maxContentLength: MAX });
}

const sealing: TaskSealing = { scopeId: 'scope-1', epoch: 3, categories: ['task-input'] };
const routineRef: RoutineRef = { routineId: 'routine-1', definitionVersion: 2, notAfter: '2026-12-31T00:00:00.000Z' };
const agentRef: AgentRef = { agentId: 'main', profileRevision: '4' };
const scopeKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const member = { tenantId: 'product:p', scopeKey, sealing, chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` }, sender: 'A'.repeat(43) };

describe('the member side of a sealed routine (#953)', () => {
  it('rebuilds the binding that opens each golden routine line', async () => {
    expect(routineLines).toHaveLength(3);
    for (const { payload } of routineLines) {
      const opened = await open(payload.sealed, routineTemplateBinding(CORPUS_TENANT, payload.routineRef!, payload.agentRef, payload.sealing.categories),
        payload.sealing);
      expect(opened.ok && Object.keys(opened.plaintext)).toEqual(['instruction']);
    }
  });

  it('seals a template that opens under the binding the device rebuilds from the offer', async () => {
    const sealed = await sealRoutineTemplate({ ...member, routineRef, agentRef, instruction: 'Check the watchlist.' });
    expect(sealed).toMatchObject({ category: 'task-input', scope: { id: 'scope-1', epoch: 3 } });
    const opened = await open(sealed, routineTemplateBinding('product:p', routineRef, agentRef, ['task-input']), sealing, scopeKey);
    expect(opened.ok && opened.plaintext).toEqual({ instruction: 'Check the watchlist.' });
  });

  it.each([
    ['another routine', { routineRef: { ...routineRef, routineId: 'routine-2' } }],
    ['another version', { routineRef: { ...routineRef, definitionVersion: 3 } }],
    ['another notAfter', { routineRef: { ...routineRef, notAfter: '2026-12-31T00:00:00.001Z' } }],
    ['another Agent revision', { agentRef: { ...agentRef, profileRevision: '5' } }],
    ['another category list', { categories: ['task-input', 'task-output'] as TaskSealing['categories'] }],
    ['another tenant', { tenantId: 'product:q' }],
  ])('does not open for %s', async (_, change: { routineRef?: RoutineRef; agentRef?: AgentRef; categories?: TaskSealing['categories']; tenantId?: string }) => {
    const sealed = await sealRoutineTemplate({ ...member, routineRef, agentRef, instruction: 'Check the watchlist.' });
    const binding = routineTemplateBinding(change.tenantId ?? 'product:p', change.routineRef ?? routineRef, change.agentRef ?? agentRef,
      change.categories ?? ['task-input']);
    expect(await open(sealed, binding, sealing, scopeKey)).toEqual({ ok: false, reason: 'sealed_open_failed' });
  });

  it('refuses a template above the inline limit, and a sealing without task input', async () => {
    await expect(sealRoutineTemplate({ ...member, routineRef, agentRef, instruction: 'x'.repeat(300 * 1024) })).rejects.toThrow('must fit inline');
    await expect(sealRoutineTemplate({ ...member, sealing: { ...sealing, categories: ['task-output'] }, routineRef, agentRef, instruction: 'x' }))
      .rejects.toThrow('sealed task input');
  });

  it('refuses a sealing that adds any category to task-input: K4 runs exactly [task-input]', async () => {
    for (const categories of [['task-input', 'task-output'], ['task-output', 'task-input']] as TaskSealing['categories'][]) {
      await expect(sealRoutineTemplate({ ...member, sealing: { ...sealing, categories }, routineRef, agentRef, instruction: 'x' }))
        .rejects.toThrow('A routine template is sealed task input only');
    }
  });
});
