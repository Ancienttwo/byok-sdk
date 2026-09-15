import type { McpToolsetServerObservation } from '../../mcp/observation';

/**
 * Build a daemon observation for tests that only care about tool NAMES.
 *
 * The adapters that pre-grant by name (claude, codex) read exactly that much
 * out of the observation, so their tests should not have to spell out a schema
 * per tool. Tests about schemas, ordering or drift use a real observation of a
 * real fixture server instead — see `../mcp-projection.test.ts`.
 *
 * `readOnlyTools` mirrors the device configuration's own scope: passing it at
 * all means every server in this observation belongs to a CLASSIFIED toolset,
 * so a tool it does not list is a mutation tool. Omitting it produces an
 * unclassified observation, which is what a toolset with no
 * `McpToolsetConfig.readOnlyTools` declaration looks like once the daemon has
 * joined configuration to `tools/list`.
 */
export function observationOf(
  servers: Readonly<Record<string, readonly string[]>>,
  options: {
    readonly toolsetId?: string;
    readonly readOnlyTools?: Readonly<Record<string, readonly string[]>>;
  } = {},
): Record<string, McpToolsetServerObservation> {
  const observation: Record<string, McpToolsetServerObservation> = {};
  for (const [serverName, tools] of Object.entries(servers)) {
    const readOnly = options.readOnlyTools?.[serverName];
    observation[serverName] = {
      toolsetId: options.toolsetId ?? `${serverName}.v1`,
      serverName,
      serverInfo: { name: `${serverName}-fixture`, version: '1.0.0' },
      protocolVersion: '2025-06-18',
      tools: tools.map((name) => ({
        name,
        description: `${name} (test fixture)`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        ...(options.readOnlyTools === undefined ? {} : { readOnly: (readOnly ?? []).includes(name) }),
      })),
    };
  }
  return observation;
}
