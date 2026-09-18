import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fitsRpcFrame,
  rpcFrameByteLength,
  RPC_MAX_FRAME_BYTES,
} from '@earendil-works/pi-coding-agent/rpc-types';
import {
  buildPreparedPromptCommand,
  PREPARED_PROMPT_COMMAND_ID,
} from '../adapters/pi/prepared-prompt-frame';
import { PiRpcClient } from '../adapters/pi/rpc-client';
import type { RuntimePreparedLaunchExpectationV1 } from '../types';

/**
 * The prepared lane's one command, as BYTES.
 *
 * `daemon/input-preparation-service.ts` admits a preparation only if this frame
 * fits the runtime's single-frame cap, and `adapters/pi/pi-adapter.ts` later
 * writes it. Those two are the same frame only for as long as one builder makes
 * both, so that is what this file pins — against the real transport, not
 * against a re-serialization of the command inside the test.
 */

const ECHO_FIXTURE = fileURLToPath(new URL('./fixtures/rpc-frame-echo.mjs', import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function expectation(): RuntimePreparedLaunchExpectationV1 {
  return {
    envelopeDigest: 'b'.repeat(64),
    toolManifestDigest: 'c'.repeat(64),
    model: {
      id: 'glm-4.6',
      name: 'GLM 4.6',
      api: 'openai-completions',
      provider: 'zai',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    binding: {
      inputIdentity: 'src-rev-1:src-digest-1',
      runtimeIdentity: '@byok-sdk/pi-coding-agent@0.85.1005+d981de1229ef899957bbe968bc8dcda02a21f477.5',
      policyIdentity: 'limits-rev-1',
      profileRevision: 'profile-rev-1',
    },
  };
}

/** An envelope the builder carries verbatim; nothing here interprets it. */
function envelope(pad = ''): Record<string, unknown> {
  return { format: 'pi.session.prepared-input', version: 2, pad };
}

describe('the prepared prompt frame is built once and measured as the bytes that are written', () => {
  it('states its own id, so the transport adds nothing the measurement did not see', async () => {
    const command = buildPreparedPromptCommand(envelope(), expectation(), PREPARED_PROMPT_COMMAND_ID);
    expect(command.id).toBe(PREPARED_PROMPT_COMMAND_ID);

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-prepared-frame-'));
    cleanups.push(async () => {
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const client = new PiRpcClient({ command: process.execPath, args: [ECHO_FIXTURE], cwd, env: process.env });
    cleanups.push(async () => {
      client.kill();
    });

    const response = await client.send(command);
    const written = Buffer.from((response.data as { frameBase64: string }).frameBase64, 'base64');

    // Byte-for-byte, terminator included. This is the claim the admission
    // check depends on: what the service measured is what the launcher writes.
    expect(written.equals(Buffer.from(`${JSON.stringify(command)}\n`, 'utf8'))).toBe(true);
    expect(written.length).toBe(rpcFrameByteLength(command));
  });

  it('measures the frame against the runtime cap, never against a local constant', () => {
    const under = buildPreparedPromptCommand(envelope(), expectation(), PREPARED_PROMPT_COMMAND_ID);
    const overhead = rpcFrameByteLength(under);

    // Sized FROM the runtime's own exported bound, so a fork that moves it
    // moves this test with it rather than silently invalidating it.
    const exact = buildPreparedPromptCommand(
      envelope('x'.repeat(RPC_MAX_FRAME_BYTES - overhead)),
      expectation(),
      PREPARED_PROMPT_COMMAND_ID,
    );
    expect(rpcFrameByteLength(exact)).toBe(RPC_MAX_FRAME_BYTES);
    expect(fitsRpcFrame(exact)).toBe(true);

    const over = buildPreparedPromptCommand(
      envelope('x'.repeat(RPC_MAX_FRAME_BYTES - overhead + 1)),
      expectation(),
      PREPARED_PROMPT_COMMAND_ID,
    );
    expect(rpcFrameByteLength(over)).toBe(RPC_MAX_FRAME_BYTES + 1);
    expect(fitsRpcFrame(over)).toBe(false);
  });
});
