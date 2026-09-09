import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { RecurringExecutionInputSchema } from '@byok-sdk/cloud';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, createHmacTokenSigner } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer } from './test-support';

it('recovers recurring admission and independent observations through a recreated SQLite facade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'byok-recurring-restart-'));
  const path = join(root, 'sdk.sqlite');
  const inputPath = join(root, 'host-input.json');
  let consumed = 0;
  const options = {
    productId: 'recurring-restart', storage: { kind: 'sqlite' as const, path }, longPollHoldMs: 20,
    tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
    agentMessage: { consume: async () => { consumed++; return { outcome: 'accepted' as const }; } },
  };
  let instance = createByokServer(options);
  let http = await startServer(instance);
  const restart = async () => {
    await stopServer(http.server); await instance.close();
    instance = createByokServer(options); http = await startServer(instance);
  };
  try {
    const device = await connectFakeDaemonLongPoll(http.baseUrl, instance, { productId: options.productId, capabilities: [
      'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress',
      'terminal-projection-selection', 'agent-egress-fresh-session',
    ] });
    const input = RecurringExecutionInputSchema.parse({ taskId: 'persisted-execution', deviceId: device.deviceId,
      payload: { instruction: '历史与当前输入', runtime: 'codex', policy: { mode: 'auto' },
        agentRef: { agentId: 'recurring-agent', profileRevision: '1' },
        egressPolicy: { policyRevision: '1', activity: { mode: 'metadata-status', delivery: 'latest-value' },
          reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
          transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' } },
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
        terminalProjection: { mode: 'none' } },
      agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
    });
    writeFileSync(inputPath, JSON.stringify(input));
    const fault = new DatabaseSync(path);
    fault.exec("CREATE TRIGGER fail_append BEFORE INSERT ON mailbox_message BEGIN SELECT RAISE(ABORT, 'restart append fault'); END;");
    fault.close();
    await expect(instance.recurring.submit(input)).rejects.toThrow('restart append fault');
    expect(await instance.tasks.attempt(input.taskId)).toBeDefined();
    expect(await instance.tasks.offer(input.taskId)).toMatchObject({ delivered: false });
    await restart();
    const repair = new DatabaseSync(path); repair.exec('DROP TRIGGER fail_append'); repair.close();
    const restored = RecurringExecutionInputSchema.parse(JSON.parse(readFileSync(inputPath, 'utf8')));
    await instance.recurring.submit(restored);
    expect(await instance.tasks.offer(restored.taskId)).toMatchObject({ delivered: true, payload: restored.payload });
    await expect(instance.recurring.submit(restored)).rejects.toThrow();
    const message = createEnvelope('agent.message.publish', {
      agentRef: restored.payload.agentRef, sessionRef: 'native-session', contract: 'conversation-turn/v1',
      messageId: '10000000-0000-4000-8000-000000000099', cursor: 1, contentType: 'text/markdown', body: 'hello', byteCount: 5,
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    }, { taskId: restored.taskId });
    const publish = () => fetch(`${http.baseUrl}/byok/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${device.accessToken}` },
      body: JSON.stringify({ messages: [message] }) });
    expect(await (await publish()).json()).toEqual({ accepted: 1 });
    const receipt = await instance.tasks.messageDisposition(restored.taskId, restored.deviceId, message.payload);
    expect(receipt).toMatchObject({ outcome: 'accepted' });
    await instance.tasks.cancel(restored.taskId, 'stop remaining');
    const attempt = await instance.tasks.attempt(restored.taskId);
    expect(attempt).toMatchObject({ cancellation: { reason: 'stop remaining' } });
    await restart();
    expect(await instance.tasks.attempt(restored.taskId)).toEqual(attempt);
    expect(await instance.tasks.messageDisposition(restored.taskId, restored.deviceId, message.payload)).toEqual(receipt);
    expect(await instance.tasks.deviceTerminal(restored.taskId)).toBeUndefined();
    expect(await (await publish()).json()).toEqual({ accepted: 1 });
    expect(consumed).toBe(1);
  } finally {
    await stopServer(http.server); await instance.close(); rmSync(root, { recursive: true, force: true });
  }
});
