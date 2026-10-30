import type { ControlMethods } from '../control-server';
import { ControlError, parseEnrollmentPairParams, ENROLLMENT_PAIRING_CODE_MAX_BYTES, parseToolsetsReloadParams, parseApprovalsResolveParams, parseApprovalsRequestParams, parseTeamWorkspaceCreateParams, parseTeamWorkspaceJoinParams, parseTeamContextParams, parseTeamMessagePostParams, parseTeamMessageReadParams, parseTeamMessageAckParams, parseTeamNotificationSnapshotParams, parseTeamMessageInspectParams, parseAgentMessagePublishParams, parseAgentResultDescribeParams, parseAgentResultSubmitParams, parseAgentMemoryRecallParams, parseAgentMemorySaveParams, type AssertionIssueResult, parseAssertionIssueParams, type TaskAssertionIssueResult, parseTaskAssertionIssueParams, TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES, parseShutdownParams } from '../control-protocol';
import { checkVerificationSecret } from '../device-member';
import { type DeviceRecord, DeviceRecordRePairRequiredError } from '../store';
import { PairedWithoutMemberError } from './support';
import { AuthRequestAbortedError } from '../auth-manager';
import { cancelAuthOperations, runAuthOperation } from './lifecycle';
import { INPUT_PREPARATION_PREPARE_METHOD, parseInputPreparationRequestParams, INPUT_PREPARATION_LOOKUP_METHOD, parseInputPreparationLookupParams, INPUT_PREPARATION_CANCEL_METHOD, parseInputPreparationCancelParams } from '../control-protocol';
import { McpToolsetRevisionConflictError } from '../toolset-registry';
import { ApprovalNotFoundError, ApprovalRequiresHostError } from '../approvals';
import { encodeTeamMemberContext, decodeTeamMemberContext } from '../team-workspace';
import { DEVICE_ASSERTION_AUDIENCE_MAX_BYTES } from '@byok-sdk/core';
import { mintDeviceAssertion, mintTaskAssertion } from '../device-assertion-signer';
import { toHttpBase } from '../url';
import { HOST_MCP_TASK_CONTEXT_CAPABILITY } from '@byok-sdk/protocol';
import type { DaemonScope } from './scope';
import { RUNTIMES_ENVIRONMENT_METHOD, type ControlRuntimeEnvironment, type ControlRuntimesEnvironmentResult } from '../control-protocol';
import { RuntimeEnvironmentUnavailableError } from '../../runtime/environment';
import type { RuntimeAdapter } from '../../types';

/** The control-socket methods of one daemon (#926). */

export function createControlMethods(daemonScope: DaemonScope): ControlMethods {
  const { daemonState, performControlShutdown, observer } = daemonScope;
  return {
    unary: {
      ...operationControlMethods(daemonScope),
      ...deviceAssertionControlMethods(daemonScope),
      ...taskAssertionControlMethods(daemonScope),
      [RUNTIMES_ENVIRONMENT_METHOD]: () => describeRuntimeEnvironments(daemonScope.adapters),
      shutdown: (params) => {
        // Plan `device-assertion-broker` (codex F1): arm the minting latch
        // SYNCHRONOUSLY, as the very first statement of this handler, BEFORE
        // the `setImmediate` defer below. The teardown itself is deferred so
        // the `{acknowledged:true}` response is written first — but the LATCH
        // must not be. A client can pipeline `shutdown` and `assertion.issue`
        // as two NDJSON lines in one write; the server dispatches them in
        // order on the same tick, so if the latch were only set inside the
        // deferred `performControlShutdown` (next macrotask), the
        // `assertion.issue` that runs on THIS tick would still see
        // `shuttingDown === false` and mint. Setting it here, before yielding,
        // closes that exact window. `runShutdownSequence` sets it again
        // (idempotent) so the non-RPC `stop()`/`unpair()` paths are covered
        // too.
        daemonState.shuttingDown = true;
        // Also synchronous: a start or pair requested before this shutdown,
        // queued or running, must not take the store lease again after the
        // teardown has released it (service enrollment's deferred start, an
        // `enrollment.pair` pipelined behind this request).
        cancelAuthOperations(daemonScope);
        const { reason } = parseShutdownParams(params);
        // Fire-and-forget, deliberately AFTER this handler's own return
        // value has been serialized and written to the socket (see
        // `control-server.ts`'s dispatch: it awaits this handler, THEN
        // writes the response) — `setImmediate` schedules the teardown for
        // the next macrotask tick, strictly after that write.
        setImmediate(() => {
          void performControlShutdown(reason).catch((err: unknown) => {
            console.error('[byok/client] error during control-socket shutdown teardown:', err);
          });
        });
        return { acknowledged: true };
      },
    },
    stream: {
      'tasks.subscribe': (_params, ctx) =>
        new Promise<void>((resolve) => {
          const unsubscribeObserver = observer.subscribe((event) => ctx.emit(event));
          ctx.signal.addEventListener(
            'abort',
            () => {
              unsubscribeObserver();
              resolve();
            },
            { once: true },
          );
        }),
    },
  };
}

/**
 * #1095: each adapter builds its environment now, under its own policy, and
 * only the report leaves this process: names and sources, never a value.
 */
async function describeRuntimeEnvironments(adapters: readonly RuntimeAdapter[]): Promise<ControlRuntimesEnvironmentResult> {
  const runtimes = await Promise.all(adapters.map(async (adapter): Promise<ControlRuntimeEnvironment> => {
    const runtimeId = adapter.descriptor.id;
    try {
      const { report } = await adapter.runtimeEnvironment();
      // A custom adapter's report may carry more fields than the type names: only these cross the socket.
      return {
        runtimeId,
        status: 'built',
        names: report.names.map(({ name, source }) => ({ name, source })),
        removed: report.removed.map(({ name, rule }) => ({ name, rule })),
      };
    } catch (error) {
      if (error instanceof RuntimeEnvironmentUnavailableError) return { runtimeId, status: 'unavailable', code: error.reason };
      return { runtimeId, status: 'failed' };
    }
  }));
  return { runtimes };
}

/** Enrollment, input preparation, toolset, approval, team workspace and Agent message, result and memory methods. */
function operationControlMethods(daemonScope: DaemonScope): ControlMethods['unary'] {
  const {
    buildControlStatus, config, memberRecords, daemonState, startUnderLease,
    pairUnderLease, runInputPreparation, toolsetRegistry, approvalRegistry, teamWorkspaces,
  } = daemonScope;
  return {
    status: () => buildControlStatus(),
    'enrollment.pair': async (params) => {
      if (config.serviceEnrollment?.enabled !== true) {
        throw new ControlError('enrollment_disabled', 'service enrollment is not enabled for this daemon');
      }
      const parsed = parseEnrollmentPairParams(params);
      if (!parsed) {
        throw new ControlError(
          'bad_request',
          `enrollment.pair requires {pairingCode} with 1-${ENROLLMENT_PAIRING_CODE_MAX_BYTES} UTF-8 bytes, and an optional verificationSecret`,
        );
      }
      let verificationSecret: string | undefined;
      try {
        verificationSecret = parsed.verificationSecret === undefined ? undefined : checkVerificationSecret(parsed.verificationSecret);
      } catch {
        throw new ControlError('bad_request', 'enrollment.pair verificationSecret is not a pairing verification secret');
      }
      if (verificationSecret !== undefined && memberRecords === undefined) {
        throw new ControlError('bad_request', 'an E2EE pairing needs the OS credential custody; this daemon uses an injected credential backend');
      }
      const enrollmentEpoch = daemonState.serviceEnrollmentEpoch;
      if (enrollmentEpoch === undefined || daemonState.daemonStarted) {
        throw new ControlError('already_paired', 'this service daemon is not waiting for initial enrollment');
      }
      if (enrollmentEpoch !== daemonState.authCancellationEpoch) {
        throw new ControlError('shutting_down', 'this service daemon is shutting down and will not enroll');
      }
      if (daemonState.serviceEnrollmentTransitioning) {
        throw new ControlError('pairing_in_progress', 'service enrollment is already in progress');
      }
      daemonState.serviceEnrollmentTransitioning = true;
      // `control-server.ts` writes this handler's result in the current
      // microtask. Starting on the next macrotask lets that persisted-id
      // receipt leave before normal startup promotes the enrollment-only
      // method table. A crash in this narrow window is safe: WinSW restarts,
      // loadExisting() sees the already-persisted credential, and takes the
      // same normal startup path. The pair and its start both belong to the
      // enrollment phase's epoch and re-check it in their lifecycle slot, so
      // a stop requested at any point before the start runs cancels it.
      const startAfterEnrollment = (): void => {
        setImmediate(() => {
          void runAuthOperation(daemonScope, startUnderLease, enrollmentEpoch).catch((err: unknown) => {
            if (err instanceof AuthRequestAbortedError) return;
            // Do not project provider/server exception text into service logs;
            // the stopped/non-ready daemon is the fail-closed observable fact.
            console.error('[byok/client] service enrollment persisted but normal daemon startup failed');
          });
        });
      };
      let record: DeviceRecord;
      try {
        record = await runAuthOperation(daemonScope, () => pairUnderLease(parsed.pairingCode, verificationSecret), enrollmentEpoch);
      } catch (err) {
        // The pairing is saved, so the service starts as a device without E2EE.
        if (err instanceof PairedWithoutMemberError) startAfterEnrollment();
        else daemonState.serviceEnrollmentTransitioning = false;
        throw err;
      }
      startAfterEnrollment();
      return { deviceId: record.deviceId };
    },
    /**
     * B-P2 local primitive (§10.3.1). Task-free: no task, claim, Execution,
     * nonce or tool grant is created by any of the three methods below, and
     * the service they call holds no reference to `TaskRunner`.
     *
     * The HMAC handshake has already completed by the time dispatch reaches
     * here — that proves a local device operator, and nothing more. Every
     * claimed device / Agent / profile value in the params is re-validated
     * against the configured authority inside the service, on EVERY call
     * including `lookup` and `cancel`, which is what stops one local scope
     * from reading or cancelling another's preparation.
     */
    [INPUT_PREPARATION_PREPARE_METHOD]: (params) =>
      runInputPreparation((service) => {
        const parsed = parseInputPreparationRequestParams(params);
        if (!parsed.ok) {
          // Two distinct codes, forwarded as the parser classified them: a
          // caller sending a RETIRED key hears `unsupported_input` and which
          // key, rather than adjusting field types against a generic shape
          // error forever.
          throw new ControlError(
            parsed.code,
            `${INPUT_PREPARATION_PREPARE_METHOD}: ${parsed.detail}`,
          );
        }
        return service.prepare(parsed.request);
      }),
    [INPUT_PREPARATION_LOOKUP_METHOD]: (params) =>
      runInputPreparation((service) => {
        const parsed = parseInputPreparationLookupParams(params);
        if (!parsed) throw new ControlError('bad_request', `${INPUT_PREPARATION_LOOKUP_METHOD} requires exactly {requestId, scope}`);
        return service.lookup(parsed);
      }),
    [INPUT_PREPARATION_CANCEL_METHOD]: (params) =>
      runInputPreparation((service) => {
        const parsed = parseInputPreparationCancelParams(params);
        if (!parsed) throw new ControlError('bad_request', `${INPUT_PREPARATION_CANCEL_METHOD} requires exactly {requestId, scope}`);
        return service.cancel(parsed);
      }),
    'toolsets.reload': (params) => {
      const parsed = parseToolsetsReloadParams(params);
      if (!parsed) {
        throw new ControlError(
          'bad_request',
          'toolsets.reload requires exactly {expectedRevision, mcpToolsets}',
        );
      }
      try {
        return toolsetRegistry.reload(parsed.mcpToolsets, parsed.expectedRevision);
      } catch (err) {
        if (err instanceof McpToolsetRevisionConflictError) {
          throw new ControlError('revision_conflict', err.message);
        }
        throw new ControlError('bad_request', err instanceof Error ? err.message : String(err));
      }
    },
    'approvals.list': () => ({ approvals: approvalRegistry.list() }),
    'approvals.resolve': (params) => {
      const parsed = parseApprovalsResolveParams(params);
      if (!parsed) throw new ControlError('bad_request', 'approvals.resolve requires {approvalId, decision}');
      try {
        approvalRegistry.resolve(parsed.approvalId, parsed.decision, parsed.reason, 'control');
      } catch (err) {
        if (err instanceof ApprovalNotFoundError) throw new ControlError('not_found', err.message);
        if (err instanceof ApprovalRequiresHostError) throw new ControlError(err.code, err.message);
        throw err;
      }
      return { resolved: true };
    },
    // Shared out-of-process approval control, retained for adapters beyond Claude.
    // The TaskRunner deadline bounds the wait; callers choose a longer control timeout.
    'approvals.request': (params) => {
      const parsed = parseApprovalsRequestParams(params);
      if (!parsed) throw new ControlError('bad_request', 'approvals.request requires {taskId, summary}');
      if (!daemonState.runner) throw new ControlError('not_found', 'daemon is not started');
      return daemonState.runner.requestApproval(parsed.taskId, parsed.summary);
    },
    'team_workspaces.create': async (params) => {
      const parsed = parseTeamWorkspaceCreateParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_workspaces.create requires exactly {workspaceId,members,limits}');
      return teamWorkspaces.createWorkspace(parsed);
    },
    'team_workspaces.list': () => teamWorkspaces.listWorkspaces(),
    'team_workspaces.join': async (params) => {
      const parsed = parseTeamWorkspaceJoinParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_workspaces.join requires exactly {workspaceId,memberId,ttlMs?}');
      const lease = await teamWorkspaces.createMemberLease(parsed);
      return { workspaceId: lease.workspaceId, memberId: lease.memberId, expiresAt: lease.expiresAt, context: encodeTeamMemberContext(lease) };
    },
    'team_workspaces.revoke': async (params) => {
      const parsed = parseTeamContextParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_workspaces.revoke requires exactly {context}');
      await teamWorkspaces.revokeMemberLease({ lease: decodeTeamMemberContext(parsed.context) });
      return { revoked: true };
    },
    'team_messages.post': (params) => {
      const parsed = parseTeamMessagePostParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_messages.post requires exactly {context,body,contentType?}');
      return teamWorkspaces.postMessage({ lease: decodeTeamMemberContext(parsed.context), body: parsed.body, ...(parsed.contentType === undefined ? {} : { contentType: parsed.contentType }) });
    },
    'team_messages.read': (params) => {
      const parsed = parseTeamMessageReadParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_messages.read requires exactly {context,afterSeq?}');
      return teamWorkspaces.readMessages({ lease: decodeTeamMemberContext(parsed.context), ...(parsed.afterSeq === undefined ? {} : { afterSeq: parsed.afterSeq }) });
    },
    'team_messages.ack': (params) => {
      const parsed = parseTeamMessageAckParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_messages.ack requires exactly {context,throughSeq}');
      return teamWorkspaces.ackMessages({ lease: decodeTeamMemberContext(parsed.context), throughSeq: parsed.throughSeq });
    },
    'team_notifications.snapshot': (params) => {
      const parsed = parseTeamNotificationSnapshotParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_notifications.snapshot requires exactly {context,afterSeq?}');
      return teamWorkspaces.notificationSnapshot({ lease: decodeTeamMemberContext(parsed.context), ...(parsed.afterSeq === undefined ? {} : { afterSeq: parsed.afterSeq }) });
    },
    'team_messages.inspect': (params) => {
      const parsed = parseTeamMessageInspectParams(params);
      if (!parsed) throw new ControlError('bad_request', 'team_messages.inspect requires exactly {workspaceId,afterSeq?}');
      return teamWorkspaces.inspectMessages(parsed.workspaceId, parsed.afterSeq);
    },
    'agent_messages.publish': (params) => {
      const parsed = parseAgentMessagePublishParams(params);
      if (!parsed) throw new ControlError('bad_request', 'agent_messages.publish requires exactly {contextToken,contentType,body}');
      if (!daemonState.runner) throw new ControlError('not_found', 'daemon is not started');
      return daemonState.runner.publishAgentMessage(parsed);
    },
    'agent_results.describe': (params) => {
      const parsed = parseAgentResultDescribeParams(params);
      if (!parsed) throw new ControlError('bad_request', 'agent_results.describe requires exactly {contextToken}');
      if (!daemonState.runner) throw new ControlError('not_found', 'daemon is not started');
      return daemonState.runner.describeAgentResult(parsed);
    },
    'agent_results.submit': (params) => {
      const parsed = parseAgentResultSubmitParams(params);
      if (!parsed) throw new ControlError('bad_request', 'agent_results.submit requires exactly {contextToken,outcome}');
      if (!daemonState.runner) throw new ControlError('not_found', 'daemon is not started');
      return daemonState.runner.submitAgentResult(parsed);
    },
    'agent_memory.recall': (params) => {
      const parsed = parseAgentMemoryRecallParams(params);
      if (!parsed) throw new ControlError('bad_request', 'agent_memory.recall requires exactly {contextToken,path,ifRevision?}');
      if (!daemonState.runner) throw new ControlError('not_found', 'daemon is not started');
      return daemonState.runner.recallAgentMemory(parsed);
    },
    'agent_memory.save': (params) => {
      const parsed = parseAgentMemorySaveParams(params);
      if (!parsed) throw new ControlError('bad_request', 'agent_memory.save requires exactly {contextToken,op,path,expectedRevision,content?}');
      if (!daemonState.runner) throw new ControlError('not_found', 'daemon is not started');
      return daemonState.runner.saveAgentMemory(parsed);
    },
  };
}

/** `assertion.issue`: a device assertion for a local caller. */
function deviceAssertionControlMethods(daemonScope: DaemonScope): ControlMethods['unary'] {
  const {
    deviceAssertionAudiences, observer, daemonState, config, deviceAssertionTtlMs, assertionProbe,
  } = daemonScope;
  return {
    /**
     * Plan `device-assertion-broker`: mint one short-lived, audience-scoped
     * device assertion for a sibling local process.
     *
     * SIX fail-closed gates, in this exact order, none of which signs
     * anything on the way out. The order is part of the contract, not an
     * implementation detail:
     *
     * 1. `assertion_disabled` — before anything else, because a daemon that
     *    was never configured for this must not reveal, by answering
     *    differently for different inputs, that it even validates params.
     * 2. `bad_request` — shape/length, checked before the allowlist so a
     *    malformed request cannot be used to probe membership.
     * 3. `audience_denied` — EXACT `Set.has`, never a prefix/suffix rule
     *    (`salesko-api.evil.com` and `salesko-ap` both fail against an entry
     *    of `salesko-api`). The message deliberately does not echo the
     *    allowlist: a refusal must not be an enumeration oracle.
     * 4. `shutting_down` — see `performControlShutdown`'s own comment for
     *    the minting window this closes.
     * 5. `revoked` — the server-side revocation this daemon already knows
     *    about.
     * 6. `not_paired` — the on-disk record, re-read on EVERY call (never
     *    cached), so clearing `device.json` removes local signing authority
     *    immediately.
     *
     * Only after all six does the private key get imported, used once, and
     * dropped (`device-assertion-signer.ts`).
     *
     * Honest limit, and it must stay in the docs as well as here: gates 4-6
     * are only HALF of revocation. They make this daemon stop minting
     * promptly, but an assertion already in a caller's hands is not recalled
     * by any of them. The other half is the host's own recheck at exchange
     * time, which is why core's `verifyDeviceAssertion` makes the device
     * row's `revoked` state a REQUIRED parameter. Nothing here entitles
     * anyone to claim this daemon delivers synchronous invalidation on its
     * own.
     */
    'assertion.issue': async (params): Promise<AssertionIssueResult> => {
      // Gate 1.
      if (deviceAssertionAudiences === undefined) {
        observer.noteDeviceAssertion({ result: 'denied', reason: 'assertion_disabled' });
        throw new ControlError(
          'assertion_disabled',
          'this daemon is not configured to issue device assertions (DaemonConfig.deviceAssertion.audiences is absent or empty)',
        );
      }
      // Gate 2.
      const parsed = parseAssertionIssueParams(params);
      if (!parsed) {
        // The audience is reported only when it was a string at all — and
        // even then the event carries just its byte size, since on
        // this path it is unvalidated caller free text.
        const rawAudience =
          typeof params === 'object' && params !== null && typeof (params as { audience?: unknown }).audience === 'string'
            ? (params as { audience: string }).audience
            : undefined;
        observer.noteDeviceAssertion({ result: 'denied', reason: 'bad_request', audience: rawAudience });
        throw new ControlError(
          'bad_request',
          `assertion.issue requires exactly {audience} where audience is a non-empty string of at most ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes`,
        );
      }
      // Gate 3. Exact membership only.
      if (!deviceAssertionAudiences.has(parsed.audience)) {
        observer.noteDeviceAssertion({ result: 'denied', reason: 'audience_denied', audience: parsed.audience });
        throw new ControlError('audience_denied', 'the requested audience is not allowed by this daemon');
      }
      // Gate 4.
      if (daemonState.shuttingDown) {
        observer.noteDeviceAssertion({ result: 'denied', reason: 'shutting_down', audience: parsed.audience });
        throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
      }
      // Gate 5.
      if (daemonState.auth.isRevoked()) {
        observer.noteDeviceAssertion({ result: 'denied', reason: 'revoked', audience: parsed.audience });
        throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
      }
      // Gate 6. Read from disk every time — never a cached record.
      let record: DeviceRecord | undefined;
      try {
        record = await daemonState.auth.readCurrent();
      } catch (error) {
        if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
      }
      if (record === undefined) {
        observer.noteDeviceAssertion({ result: 'denied', reason: 'not_paired', audience: parsed.audience });
        throw new ControlError('not_paired', 'this device is not paired; nothing can be asserted about it');
      }

      // Plan `device-assertion-broker` (codex F2): re-check the mutable
      // conditions IMMEDIATELY before signing, at the signing point itself.
      // `auth.readCurrent()` above is async, and a shutdown request or a
      // revocation can land during that `await` — after gates 4/5 already
      // passed but before the key is ever touched. The same
      // check-then-await-then-sign shape that made the result-document
      // capability re-check necessary applies here: the only checks that
      // count are the ones that still hold at the moment of signing.
      //
      // `auth.readCurrent()` returning a record is itself the fresh
      // not-paired re-check: it composes current metadata with the sole OS
      // credential authority, so unpair cannot leave a stale signer cache.
      // Shutdown and revocation are in-memory flags, so they are re-read
      // here explicitly.
      if (daemonState.shuttingDown) {
        observer.noteDeviceAssertion({ result: 'denied', reason: 'shutting_down', audience: parsed.audience });
        throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
      }
      if (daemonState.auth.isRevoked()) {
        observer.noteDeviceAssertion({ result: 'denied', reason: 'revoked', audience: parsed.audience });
        throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
      }

      const minted = mintDeviceAssertion({
        record,
        // `toHttpBase` is the one place a configured serverUrl is normalized
        // (path stripped), so the issuer ignores an operator-provided path
        // or query.
        issuer: new URL(toHttpBase(config.serverUrl)).origin,
        productId: config.productId,
        audience: parsed.audience,
        ttlMs: deviceAssertionTtlMs,
        now: new Date(),
      });
      observer.noteDeviceAssertion({
        result: 'issued',
        audience: minted.claims.audience,
        jti: minted.claims.jti,
        expiresAt: minted.expiresAt,
      });
      // codex round-2 F3: post-sign observer — non-secret metadata only,
      // reachable only from the internal test seam. Never sees the key,
      // never alters anything above it.
      assertionProbe?.onIssued({ jti: minted.claims.jti, audience: minted.claims.audience });
      return { assertion: minted.envelope, expiresAt: minted.expiresAt };
    },
  };
}

/** `task_assertion.issue`: a task assertion for a running task's Host tools. */
function taskAssertionControlMethods(daemonScope: DaemonScope): ControlMethods['unary'] {
  const {
    deviceAssertionAudiences, observer, taskContextCapabilityAvailable, daemonState, config,
    deviceAssertionTtlMs, assertionProbe,
  } = daemonScope;
  return {
    /**
     * Contract §8.1 / §8.2(1): mint one task-scoped assertion for ONE
     * upcoming tool invocation by the MCP child of an admitted host toolset
     * server.
     *
     * A separate method from `assertion.issue`, never a mode of it (§8.1:
     * the two lanes have zero interchange). NINE fail-closed gates, in this
     * exact order — one this lane alone has, then the device lane's six
     * unchanged, then the two that make this lane task-scoped:
     *
     * 2. `capability_undeclared` — §8.1's capability gate is not in place:
     *    this daemon has read no deployment declaration naming
     *    `host-mcp-task-context` (or read one that withdrew it). Checked
     *    before the params are parsed, because a daemon that cannot serve
     *    this lane has nothing to say about the shape of a request for it.
     *    §8.3 makes this a refusal and not a degradation: an undeclared lane
     *    is `unavailable`, never a reason to hand back a device assertion.
     *
     * 8. `context_token_invalid` — no registry entry for this nonce. The
     *    same answer for "never existed" and "its task has been cleaned up",
     *    so a refusal is not a probe for what this device has run.
     * 9. `context_revoked` — the entry exists and its task's local authority
     *    has been withdrawn (cancel accepted, terminal reached, shutdown).
     *
     * The gates are ordered so a refusal never leaks more than the caller
     * already knew: the audience allowlist is checked BEFORE the registry, so
     * a caller holding no nonce cannot use a denied audience to learn whether
     * some guessed token exists.
     *
     * `taskId`, `agentRef` and `toolsetId` come from the registry entry and
     * from nowhere else. `parseTaskAssertionIssueParams` rejects params that
     * even mention them, so there is no "requested" value for this handler to
     * prefer, reconcile, or accidentally trust.
     *
     * The honest limit, same as the device lane's: this is the SECOND
     * fail-closed layer (I12). The authoritative revocation point is the
     * host's own cancel/End commit; refusing here does not recall an
     * assertion already issued, and nothing about this handler entitles
     * anyone to claim the daemon delivers synchronous invalidation.
     */
    'task_assertion.issue': async (params): Promise<TaskAssertionIssueResult> => {
      // Gate 1.
      if (deviceAssertionAudiences === undefined) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'assertion_disabled' });
        throw new ControlError(
          'assertion_disabled',
          'this daemon is not configured to issue assertions (DaemonConfig.deviceAssertion.audiences is absent or empty)',
        );
      }
      // Gate 2.
      if (!taskContextCapabilityAvailable()) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'capability_undeclared' });
        throw new ControlError(
          'capability_undeclared',
          `this deployment does not declare ${HOST_MCP_TASK_CONTEXT_CAPABILITY}, so no task-scoped assertion can be issued`,
        );
      }
      // Gate 3.
      const parsed = parseTaskAssertionIssueParams(params);
      if (!parsed) {
        const rawAudience =
          typeof params === 'object' && params !== null && typeof (params as { audience?: unknown }).audience === 'string'
            ? (params as { audience: string }).audience
            : undefined;
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'bad_request', audience: rawAudience });
        throw new ControlError(
          'bad_request',
          `task_assertion.issue requires exactly {contextToken,audience}, both non-empty strings, with contextToken at most ${TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES} and audience at most ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes; taskId, agentRef and toolsetId are resolved by this daemon and may not be sent`,
        );
      }
      // Gate 4. Exact membership only, and BEFORE the registry lookup.
      if (!deviceAssertionAudiences.has(parsed.audience)) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'audience_denied', audience: parsed.audience });
        throw new ControlError('audience_denied', 'the requested audience is not allowed by this daemon');
      }
      // Gate 5.
      if (daemonState.shuttingDown) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'shutting_down', audience: parsed.audience });
        throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
      }
      // Gate 6.
      if (daemonState.auth.isRevoked()) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'revoked', audience: parsed.audience });
        throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
      }
      // Gate 7. Read from disk every time — never a cached record.
      let record: DeviceRecord | undefined;
      try {
        record = await daemonState.auth.readCurrent();
      } catch (error) {
        if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
      }
      if (record === undefined) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'not_paired', audience: parsed.audience });
        throw new ControlError('not_paired', 'this device is not paired; nothing can be asserted about it');
      }

      // Gates 8/9, read AFTER the `await` above: a cancel can land during
      // that disk read, and the only registry state that counts is the one
      // that still holds on this side of it. A daemon with no runner has no
      // registry at all, which is indistinguishable from an unknown token —
      // deliberately, so "is this daemon started" is not answerable here
      // either.
      const context = daemonState.runner?.hostToolsetContext(parsed.contextToken) ?? { status: 'unknown' as const };
      if (context.status === 'unknown') {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'context_token_invalid', audience: parsed.audience });
        throw new ControlError('context_token_invalid', 'no live host toolset context matches this token');
      }
      if (context.status === 'revoked') {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'context_revoked', audience: parsed.audience });
        throw new ControlError('context_revoked', 'this task context has been revoked; no further assertions will be issued for it');
      }

      // Same check-then-await-then-sign discipline as the device lane above:
      // shutdown and revocation are in-memory flags re-read at the signing
      // point itself, and `auth.readCurrent()` returning a record is itself
      // the fresh not-paired re-check.
      if (daemonState.shuttingDown) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'shutting_down', audience: parsed.audience, taskId: context.taskId });
        throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
      }
      if (daemonState.auth.isRevoked()) {
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'revoked', audience: parsed.audience, taskId: context.taskId });
        throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
      }

      const minted = mintTaskAssertion({
        record,
        issuer: new URL(toHttpBase(config.serverUrl)).origin,
        productId: config.productId,
        audience: parsed.audience,
        // §8.1: the task lane inherits the device lane's TTL ceiling rather
        // than deriving a second lifetime from the task's own, unpredictable
        // duration.
        ttlMs: deviceAssertionTtlMs,
        now: new Date(),
        taskId: context.taskId,
        agentRef: context.agentRef,
        toolsetId: context.toolsetId,
      });

      // Second registry read, after signing: the envelope is discarded, not
      // returned, if the task's authority ended while it was being produced.
      // Signing is synchronous today, so this cannot currently observe a
      // change — it is the gate that keeps that true, because a signed
      // envelope leaving this handler after a cancel would be exactly the
      // failure AC11 names, and the cost of proving it cannot happen is one
      // map lookup.
      //
      // Read through the SAME `?? {status:'unknown'}` shape gate 8 uses. A
      // missing runner is an unknown token, not a revoked context: the two
      // refusals mean different things to a caller (`context_revoked` says a
      // registry entry existed and its task's authority ended), and answering
      // the wrong one from a defensive `?.` would teach a caller that its
      // still-valid nonce had been withdrawn.
      const stillActive = daemonState.runner?.hostToolsetContext(parsed.contextToken) ?? { status: 'unknown' as const };
      if (stillActive.status !== 'active') {
        const reason = stillActive.status === 'unknown' ? 'context_token_invalid' : 'context_revoked';
        observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason, audience: parsed.audience, taskId: context.taskId });
        throw new ControlError(
          reason,
          reason === 'context_token_invalid'
            ? 'no live host toolset context matches this token'
            : 'this task context was revoked while the assertion was being issued',
        );
      }

      observer.noteDeviceAssertion({
        result: 'issued',
        lane: 'task',
        taskId: context.taskId,
        audience: minted.claims.audience,
        jti: minted.claims.jti,
        expiresAt: minted.expiresAt,
      });
      assertionProbe?.onIssued({ jti: minted.claims.jti, audience: minted.claims.audience });
      return { assertion: minted.envelope, expiresAt: minted.expiresAt };
    },
  };
}
