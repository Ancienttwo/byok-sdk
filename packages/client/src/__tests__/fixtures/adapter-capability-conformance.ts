import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { SteerUnsupportedError, type RuntimeAdapter, type Session } from '../../types';

/**
 * Test-only qualification boundary. A case must exercise a real adapter with a
 * synthetic runtime, and supply native receipts for positive capability claims.
 * This is not another production capability registry or a provider certification.
 */
export interface AdapterCapabilityFixture {
  readonly adapter: RuntimeAdapter;
  readonly sessionRef: string;
  readonly mismatchedIdentityEnvironment: NodeJS.ProcessEnv;
  start(input?: {
    sessionRef?: string;
    running?: boolean;
    env?: NodeJS.ProcessEnv;
  }): Promise<Session>;
  assertResumeReceipt(): Promise<void>;
  assertSteerReceipt(text: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface AdapterCapabilityQualification {
  readonly id: string;
  readonly steer: boolean;
  create(): Promise<AdapterCapabilityFixture>;
}

export async function collectAdapterTurn(session: Session): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === 'turn_end') return events;
  }
  throw new Error('adapter stream ended without a turn_end receipt');
}

/** One assertion source for the bundled subscription adapters, without package cycles. */
export function runAdapterCapabilityConformance(qualification: AdapterCapabilityQualification): void {
  describe(`${qualification.id} capability conformance (synthetic runtime)`, () => {
    let fixture: AdapterCapabilityFixture;

    beforeEach(async () => { fixture = await qualification.create(); });
    afterEach(async () => { await fixture?.dispose(); });

    it('advertises the qualified resume, steer and legacy approval contract', () => {
      expect(fixture.adapter.descriptor.id).toBe(qualification.id);
      expect(fixture.adapter.descriptor.capabilities).toMatchObject({
        resume: true,
        steer: qualification.steer,
        approvalInteractive: false,
      });
      expect(fixture.adapter.descriptor.capabilities).not.toHaveProperty('permissionModes');
      expect(Object.isFrozen(fixture.adapter.descriptor)).toBe(true);
      expect(Object.isFrozen(fixture.adapter.descriptor.capabilities)).toBe(true);
    });

    it('resumes the exact provider identity through its native resume operation', async () => {
      const session = await fixture.start({ sessionRef: fixture.sessionRef });
      expect(session.sessionRef).toBe(fixture.sessionRef);
      await collectAdapterTurn(session);
      await fixture.assertResumeReceipt();
    });

    it('rejects a missing provider session instead of silently creating a replacement', async () => {
      await expect(fixture.start({ sessionRef: 'nonexistent-conformance-session' })).rejects.toThrow();
    });

    it('rejects native resume identity drift', async () => {
      await expect(fixture.start({
        sessionRef: fixture.sessionRef,
        env: fixture.mismatchedIdentityEnvironment,
      })).rejects.toThrow(/different.*(?:session|thread) id/i);
    });

    it('keeps idle follow-up separate from steer and preserves native identity', async () => {
      const session = await fixture.start();
      const firstRef = session.sessionRef;
      await collectAdapterTurn(session);
      await session.followUp({ instruction: 'second turn' });
      expect((await collectAdapterTurn(session)).at(-1)).toEqual({ type: 'turn_end' });
      expect(session.sessionRef).toBe(firstRef);
    });

    it('proves mid-turn steering or returns the typed unsupported result', async () => {
      const session = await fixture.start({ running: true });
      if (qualification.steer) {
        await session.steer('conformance redirect');
        await fixture.assertSteerReceipt('conformance redirect');
      } else {
        await expect(session.steer('conformance redirect')).rejects.toBeInstanceOf(SteerUnsupportedError);
      }
    });

    it('does not pretend fork or rollback exists in the Session contract', async () => {
      const session = await fixture.start();
      for (const operation of ['fork', 'rollback']) {
        expect(fixture.adapter.descriptor.capabilities).not.toHaveProperty(operation);
        expect(session).not.toHaveProperty(operation);
      }
      await collectAdapterTurn(session);
    });

    it.each([false, true])('does not claim native approval/question recovery for a resumed=%s session', async (resume) => {
      const session = await fixture.start(resume ? { sessionRef: fixture.sessionRef } : {});
      expect(fixture.adapter.descriptor.capabilities).not.toHaveProperty('nativeInteractions');
      expect(session).not.toHaveProperty('interactions');
      await collectAdapterTurn(session);
    });


    it.each([true, false])('rejects legacy approval resolution (%s) without claiming recovery', async (approved) => {
      const session = await fixture.start();
      await collectAdapterTurn(session);
      await expect(session.resolveApproval(approved)).rejects.toThrow(/interactive approval/i);
    });

    it('disposes an active process idempotently', async () => {
      const session = await fixture.start({ running: true });
      await session.close();
      await session.close();
    });
  });
}
