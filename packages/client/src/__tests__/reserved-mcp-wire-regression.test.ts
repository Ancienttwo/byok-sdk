/**
 * T1: the four SDK-reserved MCP helpers' EMITTED WIRE BYTES, frozen.
 *
 * `byok-approval-mcp`, `byok-agent-message-mcp`, `byok-agent-memory-mcp` and
 * `byok-agent-team-mcp` are spawned as child processes by runtimes this SDK
 * does not own (claude's `--permission-prompt-tool`, pi's and codex's MCP
 * config). Their contract with those runtimes is bytes on a pipe, not a
 * TypeScript signature, so the only regression that matters is a byte one.
 *
 * Each server is driven over in-memory streams with one fixed request script
 * (`initialize`, `notifications/initialized`, `tools/list`, `ping`, a happy
 * `tools/call`, a faulting `tools/call`, an unknown method) and every emitted
 * line is compared with `fixtures/reserved-mcp-wire-baseline.json`.
 *
 * THE BASELINE IS CAPTURED FROM THE MIGRATION BASE, NOT FROM `main`.
 * `capturedAt` below records the exact commit whose behaviour these bytes
 * describe, and `BASELINE_CAPTURE_SHA` pins it here so a regeneration cannot
 * quietly re-baseline onto post-migration bytes: changing the fixture means
 * changing this constant in the same commit, deliberately.
 *
 * Regenerate (only against the recorded base) with:
 *   BYOK_UPDATE_RESERVED_MCP_WIRE_BASELINE=1 bunx vitest run src/__tests__/reserved-mcp-wire-regression.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serveApprovalMcpOverStdio, APPROVAL_TOOL_NAME } from '../bin/approval-mcp-server';
import { serveAgentMessageMcpOverStdio } from '../bin/agent-message-mcp-server';
import {
  serveAgentMemoryMcpOverStdio,
  AGENT_MEMORY_RECALL_TOOL_NAME,
} from '../bin/agent-memory-mcp-server';
import { serveTeamMcpOverStdio, TEAM_POST_TOOL_NAME } from '../bin/team-mcp-server';
import { AGENT_MESSAGE_TOOL_NAME } from '../sdk-reserved-mcp';

/** The commit the frozen bytes below were captured from: `codex/c07-g4b-merge`, not `main`. */
const BASELINE_CAPTURE_SHA = '5fd5e503';

const BASELINE_FILE = fileURLToPath(new URL('./fixtures/reserved-mcp-wire-baseline.json', import.meta.url));

const UPDATING = process.env.BYOK_UPDATE_RESERVED_MCP_WIRE_BASELINE === '1';

interface WireStep {
  readonly label: string;
  readonly request: Record<string, unknown>;
  /** `false` for a notification: the step must emit NOTHING. */
  readonly expectResponse: boolean;
}

interface WireBaseline {
  readonly capturedAt: string;
  readonly note: string;
  readonly servers: Record<string, { readonly steps: readonly string[]; readonly responses: readonly (string | null)[] }>;
}

const REVISION = `sha256:${'a'.repeat(64)}`;

/**
 * One script, four servers. `initialize` deliberately offers `2025-03-26`: a
 * real MCP revision this core does not implement, so the row is the one that
 * separates "echo whatever the peer said" from "answer with a version we
 * actually implement".
 */
function scriptFor(happy: Record<string, unknown>, faulting: Record<string, unknown>): WireStep[] {
  return [
    {
      label: 'initialize',
      request: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wire-regression', version: '1' } },
      },
      expectResponse: true,
    },
    { label: 'notifications/initialized', request: { jsonrpc: '2.0', method: 'notifications/initialized' }, expectResponse: false },
    { label: 'tools/list', request: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, expectResponse: true },
    { label: 'ping', request: { jsonrpc: '2.0', id: 3, method: 'ping' }, expectResponse: true },
    { label: 'tools/call happy', request: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: happy }, expectResponse: true },
    { label: 'tools/call fault', request: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: faulting }, expectResponse: true },
    { label: 'unknown method', request: { jsonrpc: '2.0', id: 6, method: 'totally/unknown' }, expectResponse: true },
  ];
}

interface ServerCase {
  readonly name: string;
  readonly serve: (stdin: PassThrough, stdout: PassThrough) => void;
  readonly steps: readonly WireStep[];
}

const SERVERS: readonly ServerCase[] = [
  {
    name: 'byok-approval-mcp',
    serve: (stdin, stdout) =>
      serveApprovalMcpOverStdio({
        taskId: 'task-wire-1',
        deps: { requestApproval: async () => ({ approved: true }) },
        input: stdin,
        output: stdout,
      }),
    steps: scriptFor(
      { name: APPROVAL_TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: 'toolu_1' } },
      { name: 'some_other_tool', arguments: {} },
    ),
  },
  {
    name: 'byok-agent-message-mcp',
    serve: (stdin, stdout) =>
      serveAgentMessageMcpOverStdio({
        deps: { publish: async () => ({ messageId: 'msg-1', state: 'queued' }) },
        stdin,
        stdout,
      }),
    steps: scriptFor(
      { name: AGENT_MESSAGE_TOOL_NAME, arguments: { body: 'hello' } },
      { name: 'some_other_tool', arguments: {} },
    ),
  },
  {
    name: 'byok-agent-memory-mcp',
    serve: (stdin, stdout) =>
      serveAgentMemoryMcpOverStdio({
        deps: {
          recall: async () => ({ path: 'MEMORY.md', revision: REVISION, content: '# index\n' }),
          save: async () => ({ path: 'MEMORY.md', revision: REVISION, deleted: false }),
        },
        stdin,
        stdout,
      }),
    steps: scriptFor(
      { name: AGENT_MEMORY_RECALL_TOOL_NAME, arguments: { path: 'MEMORY.md' } },
      { name: 'some_other_tool', arguments: {} },
    ),
  },
  {
    name: 'byok-agent-team-mcp',
    serve: (stdin, stdout) =>
      serveTeamMcpOverStdio({
        deps: {
          post: async () => ({ seq: 1 }),
          read: async () => ({ messages: [] }),
          ack: async () => ({ throughSeq: 1 }),
        },
        stdin,
        stdout,
      }),
    steps: scriptFor({ name: TEAM_POST_TOOL_NAME, arguments: { body: 'hi' } }, { name: 'some_other_tool', arguments: {} }),
  },
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a response line');
    await sleep(2);
  }
}

/**
 * Drives one step at a time and waits for that step's line before sending the
 * next. The servers handle lines concurrently by design, so a batch write would
 * make the ORDER of the captured bytes depend on how many microtasks each
 * handler happens to await. Step-at-a-time removes that from the fixture
 * without weakening what it asserts: each step's exact emitted line.
 */
async function driveScript(server: ServerCase): Promise<(string | null)[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  server.serve(stdin, stdout);

  const emitted: (string | null)[] = [];
  for (const step of server.steps) {
    const before = lines.length;
    stdin.write(`${JSON.stringify(step.request)}\n`);
    if (step.expectResponse) {
      await waitUntil(() => lines.length > before);
      expect(lines.length, `${server.name} ${step.label} emitted more than one line`).toBe(before + 1);
      emitted.push(lines[before] as string);
    } else {
      await sleep(40);
      expect(lines.length, `${server.name} ${step.label} is a notification and must emit nothing`).toBe(before);
      emitted.push(null);
    }
  }
  stdin.end();
  return emitted;
}

async function captureAll(): Promise<WireBaseline> {
  const servers: WireBaseline['servers'] = {};
  for (const server of SERVERS) {
    servers[server.name] = {
      steps: server.steps.map((step) => step.label),
      responses: await driveScript(server),
    };
  }
  return {
    capturedAt: BASELINE_CAPTURE_SHA,
    note:
      'Emitted wire bytes of the four SDK-reserved MCP stdio helpers, captured from ' +
      `${BASELINE_CAPTURE_SHA} on codex/c07-g4b-merge (the migration base, NOT main) before the ` +
      'shared MCP server core landed. Regenerate only against that base.',
    servers,
  };
}

/**
 * The COMPLETE set of intentional wire changes the shared-core migration
 * introduces for these four servers, one entry per affected step.
 *
 * Every step NOT listed here must be byte-identical to the frozen baseline.
 * Each entry asserts both halves explicitly — what the frozen line was, and
 * what the line must now be — rather than relaxing the comparison, so a second
 * unintended change on the same step cannot hide behind the first.
 *
 * The other documented baseline changes (`notifications/cancelled` now aborts
 * instead of answering, an unusable or duplicate id is now rejected, and both
 * frame directions are now bounded) do not appear here because no step of this
 * script exercises them; `mcp-server-core.test.ts` asserts each of them
 * directly.
 */
const MIGRATION_DELTAS: Readonly<Record<string, (frozen: string) => { readonly before: string; readonly after: string }>> = {
  // `initialize.result.protocolVersion`: echoed verbatim -> selected from the
  // fixed three-member list. The script offers `2025-03-26`, a real revision
  // this core does not implement, so the peer now gets the newest supported
  // one instead of a false claim of support.
  initialize: (frozen) => {
    const parsed = JSON.parse(frozen) as { result: { protocolVersion: string } };
    expect(parsed.result.protocolVersion, 'the baseline must show the echoed offer').toBe('2025-03-26');
    parsed.result.protocolVersion = '2025-11-25';
    return { before: frozen, after: JSON.stringify(parsed) };
  },
  // `ping`: fell through to the unknown-method arm -> answered `{}`.
  ping: (frozen) => {
    expect(frozen).toContain('"code":-32601');
    return { before: frozen, after: '{"jsonrpc":"2.0","id":3,"result":{}}' };
  },
};

describe('the four SDK-reserved MCP helpers on the wire', () => {
  it(`still emits the bytes frozen at ${BASELINE_CAPTURE_SHA}, except the declared migration deltas`, async () => {
    if (UPDATING) {
      writeFileSync(BASELINE_FILE, `${JSON.stringify(await captureAll(), null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as WireBaseline;
    expect(baseline.capturedAt, 'the frozen bytes must stay attributed to the migration base').toBe(
      BASELINE_CAPTURE_SHA,
    );

    for (const server of SERVERS) {
      const frozen = baseline.servers[server.name];
      expect(frozen, `${server.name} is missing from the baseline`).toBeDefined();
      expect(frozen?.steps).toEqual(server.steps.map((step) => step.label));
      const emitted = await driveScript(server);

      const expected = server.steps.map((step, index) => {
        const frozenLine = frozen?.responses[index] ?? null;
        const delta = MIGRATION_DELTAS[step.label];
        if (delta === undefined || frozenLine === null) return frozenLine;
        const { before, after } = delta(frozenLine);
        expect(frozenLine, `${server.name} ${step.label} baseline moved`).toBe(before);
        expect(after, `${server.name} ${step.label} delta is not a change`).not.toBe(before);
        return after;
      });

      expect(emitted, `${server.name} drifted from the frozen wire bytes`).toEqual(expected);
    }
  });
});
