/**
 * What `McpStdioClient` actually does with a tool's `outputSchema`, and which
 * provider does it.
 *
 * `src/mcp/client.ts` names `CfWorkerJsonSchemaValidator` explicitly instead of
 * letting `@modelcontextprotocol/client` resolve its default provider through
 * the `./_shims` conditional export, whose `node`/`default` branch is ajv —
 * a provider that compiles every schema with `new Function`. The point of the
 * injection is that the runtime choice stops depending on the consumer's
 * bundler; the point of this suite is that the choice is observable, so it
 * cannot be quietly reverted by an import edit that still typechecks.
 *
 * Everything here runs against a real child process over a real pipe. The
 * server is `mcp-fixture-server.mjs` rather than one built on this package's
 * own `src/mcp-server` core, for a stated reason: that core's
 * `McpServerToolDefinition` carries `name`, `description` and `inputSchema`
 * only, and `handleToolsList` re-authors each entry from exactly those three
 * fields (`src/mcp-server/index.ts`), so a tool served by it can never
 * advertise an `outputSchema` at all. Adding one would be a change to that
 * core's public surface, which is not what this change is about. The
 * hand-rolled fixture can advertise a raw `tools` array, which is precisely
 * the server behaviour under test.
 *
 * THE PROVIDER DELTA, measured rather than asserted. Both providers accept the
 * same valid instance and reject the same invalid one; the error TEXT differs,
 * and the tests below pin the cf-worker wording:
 *
 *   ajv (package default on Node):
 *     data/count must be number
 *   cf-worker (what this SDK now injects):
 *     #: Property "count" does not match schema.; #/count: Instance type
 *     "string" is invalid. Expected "number".
 *
 * A host that was matching on the ajv text sees different text. Nothing else
 * observable changes: the same calls succeed and the same calls fail, under
 * both the 2020-12 default dialect and an explicit draft-07 `$schema`.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpStdioClient } from '../mcp';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH ?? '' } as const;

/** Default dialect: no `$schema`, so the 2020-12 the package assumes. */
const SCHEMA_2020 = {
  type: 'object',
  additionalProperties: false,
  required: ['count'],
  properties: { count: { type: 'number' } },
} as const;

/** The same constraint under an explicitly declared draft-07 `$schema`. */
const SCHEMA_DRAFT07 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  ...SCHEMA_2020,
} as const;

function serverWith(outputSchema: Record<string, unknown>, structuredContent: unknown) {
  const config = {
    tools: [
      {
        name: 'report',
        description: 'Report a count.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        outputSchema,
      },
    ],
    callResult: { content: [], structuredContent },
  };
  return { command: process.execPath, args: [FIXTURE, JSON.stringify(config)] };
}

/**
 * One connect / list / call round trip.
 *
 * `listTools()` is not decoration: the package compiles a tool's output
 * validator out of its RESPONSE CACHE for `tools/list`, so a `callTool` on a
 * client that never listed has no schema to validate against and returns the
 * server's structured content unchecked. That is the package's behaviour, not
 * this SDK's, and the daemon's own paths list before they call.
 */
async function callReport(
  outputSchema: Record<string, unknown>,
  structuredContent: unknown,
): Promise<{ readonly ok: true; readonly structuredContent: unknown } | { readonly ok: false; readonly message: string }> {
  const client = new McpStdioClient(serverWith(outputSchema, structuredContent), { env: ENV, label: 'fixture' });
  try {
    await client.connect();
    await client.listTools();
    const result = await client.callTool('report', {});
    return { ok: true, structuredContent: result.structuredContent };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close();
  }
}

describe('MCP tool output validation runs on the eval-free provider', () => {
  it('accepts structured content that matches the declared outputSchema', async () => {
    const outcome = await callReport({ ...SCHEMA_2020 }, { count: 3 });
    expect(outcome).toEqual({ ok: true, structuredContent: { count: 3 } });
  });

  it('surfaces a validation failure when the structured content does not match', async () => {
    const outcome = await callReport({ ...SCHEMA_2020 }, { count: 'three' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("Structured content does not match the tool's output schema");
    // The cf-worker wording, pinned. This is the one observable difference from
    // the ajv default (`data/count must be number`), and pinning it is what
    // proves WHICH provider ran rather than merely that something rejected.
    expect(outcome.message).toContain('Instance type "string" is invalid. Expected "number"');
    expect(outcome.message).not.toContain('must be number');
  });

  it('validates a draft-07 $schema and the 2020-12 default identically', async () => {
    expect(await callReport({ ...SCHEMA_DRAFT07 }, { count: 3 })).toEqual({
      ok: true,
      structuredContent: { count: 3 },
    });
    expect(await callReport({ ...SCHEMA_2020 }, { count: 3 })).toEqual({
      ok: true,
      structuredContent: { count: 3 },
    });

    const draft07Bad = await callReport({ ...SCHEMA_DRAFT07 }, { count: 'three' });
    const default2020Bad = await callReport({ ...SCHEMA_2020 }, { count: 'three' });
    expect(draft07Bad.ok).toBe(false);
    expect(default2020Bad.ok).toBe(false);
    if (draft07Bad.ok || default2020Bad.ok) return;
    // Same verdict and same wording under both dialects: declaring draft-07
    // does not route the instance through a different provider.
    expect(draft07Bad.message).toBe(default2020Bad.message);
    expect(draft07Bad.message).toContain('Instance type "string" is invalid. Expected "number"');
  });
});
