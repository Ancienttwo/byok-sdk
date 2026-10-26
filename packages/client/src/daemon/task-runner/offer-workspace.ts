// `handleOffer` stage: bind the Agent home
// (see ./support.ts for how a member module runs).
import type { TerminalAgentHomeProjection } from '@byok-sdk/protocol';
import { AgentHomeBusyError, AgentHomeReaderRunMissingError, AgentHomeResolutionError } from '../../agent-home';
import { digestAgentHomeMemory } from '../../agent-home-readers';
import type { ActiveTask, OfferPhaseContext } from './support';
import { errorMessage, outboundErrorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import type { OfferHeld, OfferRequest, OfferRuntime } from './offer';

export interface OfferWorkspaceInput extends Pick<OfferRequest, 'agentRef' | 'readerAttempt' | 'sessionRef' | 'homeAccess' | 'homeBusyCode'> {
  readonly pick: OfferRuntime['pick'];
  readonly messageRequirement: ActiveTask['messageRequirement'];
  readonly terminalProjection: ActiveTask['terminalProjection'];
}

/** Binds the Agent home for an admitted offer. */
export async function bindOfferWorkspace(this: TaskRunner, phase: OfferPhaseContext, held: OfferHeld, input: OfferWorkspaceInput) {
  const { taskId, decline, releaseReservation } = phase;
  const { agentRef, readerAttempt, sessionRef, homeAccess, homeBusyCode, pick, messageRequirement, terminalProjection } = input;
  if (agentRef !== undefined) {
    // A resumed reader runs again in the run directory its session handoff
    // recorded. The ledger lives in the home, so it is found by sessionRef.
    let readerRunDirectory: string | undefined;
    if (readerAttempt && sessionRef !== undefined) {
      try {
        const resolution = await this['deps'].agentHome!.layout.resolve(agentRef);
        readerRunDirectory = await this['deps'].agentSessionHandoffs!.readerSessionCwd({
          agentRef: resolution.agentRef,
          sessionRef,
          runtimeId: pick.descriptor.id,
          home: resolution.canonicalHome,
        });
      } catch (error) {
        decline(`Agent session handoff mismatch: ${outboundErrorMessage(error)}`, error instanceof AgentHomeBusyError,
          error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
        return;
      }
    }
    try {
      held.agentBinding = await this['deps'].agentHome!.acquireExecution(agentRef, {
        taskId,
        sessionRef,
        homeAccess,
        ...(readerRunDirectory === undefined ? {} : { runDirectory: readerRunDirectory }),
      });
      releaseReservation();
    } catch (error) {
      decline(
        `Agent home admission failed: ${outboundErrorMessage(error)}`,
        error instanceof AgentHomeBusyError || !(error instanceof AgentHomeResolutionError),
        error instanceof AgentHomeBusyError ? homeBusyCode : undefined,
      );
      return;
    }
  }

  // readOfferRequest declined every offer without an AgentRef, so the Agent
  // home binding above is the only workspace an offer can have.
  if (held.agentBinding === undefined) {
    decline('Agent offer requires the SDK-owned agent-home-contract layout and handoff store', false);
    return;
  }
  const workspaceDir = held.agentBinding.lease.cwd;
  let appliedAgentHomeProjection: TerminalAgentHomeProjection | undefined;
  let readerMemoryBaseline: ActiveTask['readerMemoryBaseline'];
  if (sessionRef !== undefined) {
    try {
      await this['deps'].agentSessionHandoffs!.requireMatch({
        agentRef: held.agentBinding.resolution.agentRef,
        sessionRef,
        runtimeId: pick.descriptor.id,
        home: held.agentBinding.resolution.canonicalHome,
        cwd: workspaceDir,
        ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
      });
    } catch (error) {
      await held.agentBinding.lease.release().catch(() => {});
      held.agentBinding = undefined;
      decline(`Agent session handoff mismatch: ${outboundErrorMessage(error)}`, false);
      return;
    }
  }
  if (readerAttempt) {
    const fresh = sessionRef === undefined;
    try {
      await this['deps'].agentHome!.prepareReaderRun(held.agentBinding, { fresh });
    } catch (error) {
      await held.agentBinding.lease.release().catch(() => {});
      held.agentBinding = undefined;
      // A busy run directory (a redelivered task found a directory it
      // cannot reuse) may clear; every other failure is permanent.
      decline(error instanceof AgentHomeReaderRunMissingError
        ? `Agent session ${sessionRef} cannot resume: its reader run directory no longer exists`
        : `Agent reader run directory preparation failed: ${outboundErrorMessage(error)}`,
        error instanceof AgentHomeBusyError,
        error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
      return;
    }
  }
  try {
    await this['deps'].agentHome!.initializeExecution(held.agentBinding);
  } catch (error) {
    await held.agentBinding.lease.release().catch(() => {});
    held.agentBinding = undefined;
    decline(`Agent home initialization failed: ${outboundErrorMessage(error)}`, error instanceof AgentHomeBusyError,
      error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
    return;
  }
  // Terminal evidence only (#318): an unreadable projection record must not
  // block an Attempt that ran before this evidence existed, so omit it.
  appliedAgentHomeProjection = await this['deps'].agentHome!.readAppliedProjection(held.agentBinding).catch((error: unknown) => {
    console.warn(`[byok/client] Agent-home projection record is unreadable for ${taskId}; terminal evidence omits it: ${errorMessage(error)}`);
    return undefined;
  });
  // Evidence only (#317): the SDK does not make memory read-only. The
  // reader terminal compares this digest with one taken at the terminal.
  if (readerAttempt) {
    readerMemoryBaseline = { digest: await digestAgentHomeMemory(held.agentBinding.resolution.canonicalHome) };
  }
  if (messageRequirement !== undefined) {
    try {
      const outbox = await this['agentMessageOutbox'](held.agentBinding.resolution.canonicalHome);
      this['pendingMessageTasks'].set(taskId, {
        taskId,
        agentRef: held.agentBinding.resolution.agentRef,
        requirement: messageRequirement,
        outbox,
      });
    } catch (error) {
      await held.agentBinding.lease.release().catch(() => {});
      held.agentBinding = undefined;
      decline(`Agent message outbox initialization failed: ${outboundErrorMessage(error)}`, true);
      return;
    }
  }
  if (terminalProjection?.mode === 'result-document') {
    try {
      const store = await this['agentResultStore'](held.agentBinding.resolution.canonicalHome);
      const context = this['resultContextByTask'].get(taskId);
      if (context === undefined) throw new Error('the task result context was revoked before its Agent home was bound');
      context.store = store;
      context.agentRef = held.agentBinding.resolution.agentRef;
    } catch (error) {
      await held.agentBinding.lease.release().catch(() => {});
      held.agentBinding = undefined;
      decline(`Agent result store initialization failed: ${outboundErrorMessage(error)}`, true);
      return;
    }
  }
  return { workspaceDir, appliedAgentHomeProjection, readerMemoryBaseline };
}
