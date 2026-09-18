/**
 * T2/T4(d): `src/mcp-server` against the REAL `@modelcontextprotocol/client@2.0.0`.
 *
 * Every other suite in this package drives the core over in-memory streams,
 * which proves what bytes it emits but not that a real peer accepts them. This
 * one spawns an actual child process, connects the official client over a real
 * pipe with `enforceStrictCapabilities: true`, and asserts what that client
 * ends up believing: which version it negotiated, which tools it can see, that
 * a call returns, that a cancel leaves its out-of-band error funnel EMPTY, and
 * that a closed session ends the child.
 *
 * Strict capabilities is not decoration. With it on, a server that returns
 * `capabilities: {}` still connects, and then `tools/list` and `tools/call`
 * fail CLIENT-side before a byte goes on the wire
 * (`Server does not support tools (required for tools/list)`). That is the
 * failure mode the core's authored `{tools:{}}` removes at the source, and only
 * a real client can demonstrate it is gone.
 *
 * The three negotiated versions are driven by what the CLIENT offers: it sends
 * the first legacy entry of its own `supportedProtocolVersions` and accepts any
 * member of that list back. So a one-entry list pins the negotiation exactly,
 * and a two-entry list whose first member the core does not implement is the
 * "unsupported offer" case.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS } from '../mcp-server';

const HOOK = fileURLToPath(new URL('./fixtures/ts-source-resolve-hook.mjs', import.meta.url));
const HELPER = fileURLToPath(new URL('./fixtures/mcp-server-core-helper.mjs', import.meta.url));

const ECHO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string' } },
};

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'byok-mcp-interop-'));
  scratchDirs.push(dir);
  return dir;
}

interface Session {
  readonly client: Client;
  readonly transportErrors: string[];
  readonly clientErrors: string[];
  close(): Promise<void>;
}

async function connect(options: {
  readonly supportedProtocolVersions?: string[];
  readonly env?: Record<string, string>;
}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', HOOK, HELPER],
    env: { ...options.env, PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  const clientErrors: string[] = [];
  const transportErrors: string[] = [];
  const client = new Client(
    { name: '@byok-sdk/client', version: '1' },
    {
      capabilities: {},
      enforceStrictCapabilities: true,
      ...(options.supportedProtocolVersions === undefined
        ? {}
        : { supportedProtocolVersions: options.supportedProtocolVersions }),
    },
  );
  client.onerror = (error: unknown) => {
    clientErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  };
  transport.onerror = (error: Error) => {
    transportErrors.push(`${error.name}: ${error.message}`);
  };
  await client.connect(transport, { timeout: 8_000 });
  return {
    client,
    clientErrors,
    transportErrors,
    close: async () => {
      await client.close();
    },
  };
}

describe('the MCP server core against the official client', () => {
  for (const version of MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS) {
    it(`negotiates ${version}, lists its tools and answers a call under it`, async () => {
      const session = await connect({ supportedProtocolVersions: [version] });
      try {
        expect(session.client.getNegotiatedProtocolVersion()).toBe(version);
        expect(session.client.getServerVersion()).toEqual({ name: 'mcp-server-core-fixture', version: '0.0.1' });
        // F2: strict capabilities gate REQUESTS, not the handshake. The two
        // calls below are what a `capabilities: {}` server could never serve.
        expect(session.client.getServerCapabilities()).toEqual({ tools: {} });

        const listed = await session.client.listTools(undefined, { timeout: 8_000 });
        expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'slow', 'boom']);
        // Per-version schema shape: the caller's JSON Schema literal survives
        // the round trip byte for byte and is accepted under this revision's
        // schema rules (2020-12 is the default dialect under 2025-11-25, and
        // this schema declares no `$schema`, so it must be valid 2020-12).
        expect(listed.tools[0]?.inputSchema).toEqual(ECHO_SCHEMA);
        expect('nextCursor' in listed).toBe(false);

        const called = await session.client.callTool(
          { name: 'echo', arguments: { message: 'hi' } },
          { timeout: 8_000 },
        );
        expect((called.content as { type: string; text: string }[])[0]).toEqual({ type: 'text', text: 'echo: hi' });

        await session.client.ping({ timeout: 8_000 });

        // A server-authored tool failure stays the server's: the core forwards
        // the code it was given rather than substituting one of its own.
        await expect(session.client.callTool({ name: 'boom' }, { timeout: 8_000 })).rejects.toThrow(
          /the fixture tool refused/,
        );

        expect(session.clientErrors).toEqual([]);
        expect(session.transportErrors).toEqual([]);
      } finally {
        await session.close();
      }
    });
  }

  it('answers an unsupported offered version with a supported one, and the client continues', async () => {
    // The client offers the first legacy entry — `2025-03-26`, which this core
    // deliberately does not implement (it mandates batch receipt) — and accepts
    // any member of its own list back.
    const session = await connect({ supportedProtocolVersions: ['2025-03-26', '2025-11-25'] });
    try {
      expect(session.client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      const listed = await session.client.listTools(undefined, { timeout: 8_000 });
      expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'slow', 'boom']);
      const called = await session.client.callTool(
        { name: 'echo', arguments: { message: 'after fallback' } },
        { timeout: 8_000 },
      );
      expect((called.content as { type: string; text: string }[])[0]?.text).toBe('echo: after fallback');
      expect(session.clientErrors).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('honours a cancel with NO late response, which the client would otherwise report out of band', async () => {
    const dir = scratch();
    const log = path.join(dir, 'events.ndjson');
    const session = await connect({ env: { MCP_FIXTURE_SLOW_MS: '5000', MCP_FIXTURE_LOG: log } });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('caller aborted')), 150);
      await expect(
        session.client.callTool({ name: 'slow' }, { timeout: 8_000, signal: controller.signal }),
      ).rejects.toThrow();

      // The handler really was aborted, and it really did settle.
      await expect
        .poll(() => readFileSync(log, 'utf8'), { timeout: 5_000 })
        .toMatch(/"tag":"slow-settled"/);
      expect(readFileSync(log, 'utf8')).toMatch(/"tag":"aborted"/);

      // F3, inverted: a server that answered late would make the client log
      // `Received a response for an unknown message ID`. The funnel is empty.
      expect(session.clientErrors).toEqual([]);
      expect(session.transportErrors).toEqual([]);

      // The session survives the cancel.
      const after = await session.client.callTool(
        { name: 'echo', arguments: { message: 'still here' } },
        { timeout: 8_000 },
      );
      expect((after.content as { type: string; text: string }[])[0]?.text).toBe('echo: still here');
      expect(session.clientErrors).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('ends the child on EOF rather than lingering', async () => {
    const dir = scratch();
    const log = path.join(dir, 'events.ndjson');
    const session = await connect({ env: { MCP_FIXTURE_LOG: log } });
    await session.client.ping({ timeout: 8_000 });
    await session.close();
    await expect.poll(() => readFileSync(log, 'utf8'), { timeout: 5_000 }).toMatch(/"tag":"close","data":"eof"/);
  });
});
