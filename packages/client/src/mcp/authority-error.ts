/**
 * The MCP authority error, on a module of its own and importing nothing.
 *
 * `mcp/client.ts` owns the single MCP client authority, but the client's own
 * module graph reaches `@modelcontextprotocol/client`. Modules that must
 * IDENTIFY an authority refusal without taking that graph — the daemon-free
 * adapters closure above all (`dist-subpath-closure.test.ts` guards the
 * emitted bundle against exactly this edge) — import the class from here.
 * One definition, re-exported by `mcp/client.ts`, so `instanceof` is exact
 * everywhere and no second error type is minted.
 */
export class McpAuthorityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpAuthorityError';
  }
}
