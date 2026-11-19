import { addAbortListener } from 'node:events';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import { withOversizeToolResult } from '../../mcp-server/call-frame.js';
import { serveMcpOverStdio, type McpServerOptions, type McpServerToolCall } from '../../mcp-server/index.js';
import { McpAuthorityError } from '../client.js';
import { McpCallOutcomeUnknownError, McpServerDriftError, McpServerPool } from '../server-pool.js';
import { publishMcpHubCatalog, readMcpHubCatalog, snapshotHubBinding, type McpHubCatalog, type McpHubCatalogBinding } from './catalog.js';
import { discoverMcpHubServers } from './discovery.js';
import { HUB_CALL_TOOL, HUB_SEARCH_TOOL, MCP_HUB_SERVER_NAME, MCP_HUB_TOOLS, hubText, parseHubCall, parseHubQuery, type McpHubCall } from './protocol.js';
import { searchMcpHubCatalog } from './search.js';

export { readMcpHubCatalog, type McpHubCatalog, type McpHubCatalogBinding } from './catalog.js';
export { HUB_CALL_TOOL, HUB_SEARCH_TOOL, MCP_HUB_SERVER_NAME, MCP_HUB_TOOLS, parseHubCall, type McpHubCall } from './protocol.js';

interface McpHubOptions extends Pick<McpServerOptions, 'input' | 'output'> {
  readonly binding: McpHubCatalogBinding;
  readonly isActive?: (signal: AbortSignal) => boolean | Promise<boolean>;
  readonly authorizeCall?: (call: McpHubCall, signal: AbortSignal) => boolean | Promise<boolean>;
  readonly toolCallTimeoutMs?: number;
}

class InactiveAttemptError extends Error {}

interface Discovery {
  readonly abort: AbortController;
  readonly done: Promise<McpHubCatalog>;
  waiters: number;
}

const inputValidator = new CfWorkerJsonSchemaValidator();

function matchesInputSchema(args: McpHubCall['arguments'], schema: unknown): boolean {
  try {
    // The validator resolves references by annotating its schema. The model
    // and drift comparison must keep the server's original snapshot.
    const copy = structuredClone(schema) as Parameters<typeof inputValidator.getValidator>[0];
    return inputValidator.getValidator(copy)(args).valid;
  } catch {
    return false;
  }
}

/** Internal stdio helper. Only a daemon-owned Attempt proof makes either tool callable. */
export function serveMcpHub(options: McpHubOptions): { close(): Promise<void> } {
  const binding = snapshotHubBinding(options.binding);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let catalog: McpHubCatalog | undefined;
  let discovery: Discovery | undefined;
  let closing: Promise<void> | undefined;

  const pool = new McpServerPool((name) => {
    const frozen = catalog?.get(name);
    if (frozen === undefined) throw new McpAuthorityError('Server is absent from the MCP hub catalog');
    return { spec: binding.mcpServers[name]!, env: binding.mcpEnv, cwd: binding.launchCwd, frozen };
  }, { boundedHandshake: true });

  async function checkActive(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let active = false;
    try {
      active = (await options.isActive?.(signal)) === true;
    } catch {
      // A missing or failed control proof denies this operation.
    }
    if (!active) throw new InactiveAttemptError('MCP hub Attempt is inactive or could not be verified.');
    signal.throwIfAborted();
  }

  async function readPublishedCatalog(): Promise<McpHubCatalog | undefined> {
    try {
      catalog ??= await readMcpHubCatalog(binding);
      return catalog;
    } catch {
      throw new Error('The published MCP hub catalog is invalid for this Attempt.');
    }
  }

  async function freezeCatalog(signal: AbortSignal): Promise<McpHubCatalog> {
    const published = await readPublishedCatalog();
    if (published !== undefined) return published;
    const servers = await discoverMcpHubServers(binding, signal);
    try {
      catalog = await publishMcpHubCatalog(binding, servers, signal);
      return catalog;
    } catch {
      throw new Error('The MCP hub could not publish its complete catalog.');
    }
  }

  async function searchCatalog(signal: AbortSignal): Promise<McpHubCatalog> {
    signal.throwIfAborted();
    if (catalog !== undefined) return catalog;
    // A cancelled waiter can leave a closing discovery. Wait for its children
    // to finish before granting the next run its own concurrency budget.
    if (discovery?.abort.signal.aborted) await discovery.done.catch(() => undefined);
    signal.throwIfAborted();
    if (discovery === undefined) {
      const abort = new AbortController();
      discovery = { abort, waiters: 0, done: freezeCatalog(abort.signal).finally(() => { discovery = undefined; }) };
    }
    const run = discovery;
    run.waiters++;
    const aborted = Promise.withResolvers<never>();
    const listener = addAbortListener(signal, () => aborted.reject(signal.reason));
    try {
      return await Promise.race([run.done, aborted.promise]);
    } finally {
      listener[Symbol.dispose]();
      if (--run.waiters === 0 && discovery === run) run.abort.abort();
    }
  }

  async function callTool(request: McpServerToolCall): Promise<Record<string, unknown>> {
    const { name, signal } = request;
    if (name === HUB_SEARCH_TOOL) {
      const query = parseHubQuery(request.arguments);
      if (query === undefined) return hubText('tool_search requires a query string of at most 256 characters.', true);
      try {
        await checkActive(signal);
        const matches = searchMcpHubCatalog(await searchCatalog(signal), query);
        return withOversizeToolResult(matches, hubText('Search results exceed the output frame limit.', true));
      } catch (error) {
        return hubText(error instanceof Error ? error.message : 'MCP hub search failed.', true);
      }
    }
    if (name !== HUB_CALL_TOOL) return hubText('Unknown MCP hub tool.', true);
    const call = parseHubCall(request.arguments);
    if (call === undefined) return hubText('call_tool requires exact server and tool names and a JSON arguments object.', true);
    let frozen: McpHubCatalog | undefined;
    try {
      frozen = await readPublishedCatalog();
    } catch (error) {
      return hubText((error as Error).message, true);
    }
    if (frozen === undefined) return hubText('Run tool_search before calling an MCP tool.', true);
    const descriptor = frozen.get(call.server)?.tools.find((tool) => tool.name === call.tool);
    if (descriptor === undefined) return hubText('The exact server and tool are absent from the frozen catalog.', true);
    if (!matchesInputSchema(call.arguments, descriptor.inputSchema)) {
      return hubText('Arguments do not match the frozen MCP tool input schema.', true);
    }
    if (options.authorizeCall !== undefined) {
      try {
        if (await options.authorizeCall(call, signal) !== true) return hubText('MCP tool call is not authorized.', true);
      } catch {
        return hubText('MCP tool call authorization could not be verified.', true);
      }
    }
    try {
      const result = await pool.callVerified(
        call.server, call.tool, call.arguments, signal, () => checkActive(signal), options.toolCallTimeoutMs,
      );
      return withOversizeToolResult(result, hubText('MCP tool call result unknown: its reply exceeds the output frame limit.', true));
    } catch (error) {
      if (error instanceof InactiveAttemptError) return hubText(error.message, true);
      if (error instanceof McpServerDriftError) return hubText(`The MCP tools for server "${call.server}" changed since search.`, true);
      if (error instanceof McpCallOutcomeUnknownError) return hubText('MCP tool call result unknown. The request was not replayed.', true);
      return hubText(`Could not verify MCP server "${call.server}" before dispatch.`, true);
    }
  }

  const stdio = serveMcpOverStdio({
    input, output, serverInfo: { name: MCP_HUB_SERVER_NAME, version: '1' }, tools: MCP_HUB_TOOLS, callTool,
    onClose: closeStreams,
  });
  input.once('close', closeStreams);
  input.once('error', closeStreams);
  output.once('close', closeStreams);
  output.once('error', closeStreams);

  function closeStreams(): void {
    void close();
  }

  function close(): Promise<void> {
    if (closing !== undefined) return closing;
    stdio.close();
    input.off('close', closeStreams);
    input.off('error', closeStreams);
    output.off('close', closeStreams);
    output.off('error', closeStreams);
    discovery?.abort.abort();
    closing = Promise.allSettled([pool.close(), discovery?.done]).then(() => undefined);
    return closing;
  }

  return { close };
}
