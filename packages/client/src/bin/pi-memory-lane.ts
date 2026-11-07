import type { AgentSessionRuntime, CreateAgentSessionOptions, CreateAgentSessionServicesOptions, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createScopedFileTools, type ScopedFileToolOptions } from '../file-scope-tools';
import { isScopedFileToolName, SCOPED_FILE_TOOL_NAMES } from '../file-scope-types';
import type { PiToolLoadoutSession } from './pi-session-runtime';

import { PI_MEMORY_LANE } from '../adapters/pi/memory-lane-contract';
export { PI_MEMORY_LANE } from '../adapters/pi/memory-lane-contract';

export class PiMemoryLaneError extends Error {
  constructor(readonly code: 'memory_lane_tool_set_mismatch' | 'memory_lane_closed' | 'memory_lane_operation_denied') {
    super(code);
    this.name = 'PiMemoryLaneError';
  }
}

export function assertPiMemoryToolLoadout(session: PiToolLoadoutSession): void {
  const registered = session.getAllTools();
  const active = session.getActiveToolNames();
  const exact = (names: readonly string[]) => names.length === SCOPED_FILE_TOOL_NAMES.length
    && new Set(names).size === names.length && names.every(isScopedFileToolName);
  // The SDK owns customTools; inline/file extensions cannot claim this source.
  if (!exact(registered.map(tool => tool.name)) || !exact(active)
    || registered.some(tool => tool.sourceInfo?.source !== 'sdk')) {
    throw new PiMemoryLaneError('memory_lane_tool_set_mismatch');
  }
}

export interface PiMemoryLane {
  readonly egress: typeof PI_MEMORY_LANE.egress;
  readonly cancellation: typeof PI_MEMORY_LANE.cancellation;
  readonly tools: ToolDefinition[];
  readonly extension: ExtensionFactory;
  readonly toolOptions: Pick<CreateAgentSessionOptions, 'tools' | 'noTools' | 'excludeTools' | 'customTools'>;
  readonly resourceLoaderOptions: CreateAgentSessionServicesOptions['resourceLoaderOptions'];
  close(): Promise<void>;
  bindRuntime(runtime: AgentSessionRuntime): void;
}

export function createPiMemoryLane(options: ScopedFileToolOptions): PiMemoryLane {
  if (options.grant.mode !== 'memory') throw new PiMemoryLaneError('memory_lane_operation_denied');
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const assertOpen = (signal?: AbortSignal): void => {
    if (closed || signal?.aborted) throw new PiMemoryLaneError('memory_lane_closed');
  };
  const tools = createScopedFileTools(options).map(tool => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      assertOpen(args[2]);
      // Admission and tracking happen without an await. A cancellation seals
      // admission synchronously; every already-admitted IO completes before its receipt.
      const operation = tool.execute(...args);
      pending.add(operation);
      try { return await operation; } finally { pending.delete(operation); }
    },
  }));
  const close = async (): Promise<void> => {
    closed = true;
    await Promise.allSettled([...pending]);
  };
  const extension: ExtensionFactory = pi => {
    pi.on('tool_call', event => {
      if (closed || !isScopedFileToolName(event.toolName)) return { block: true, reason: closed ? 'memory_lane_closed' : 'memory_lane_operation_denied' };
      return undefined;
    });
  };
  const toolOptions = {
    tools: [...SCOPED_FILE_TOOL_NAMES], noTools: 'builtin', excludeTools: ['bash', 'powershell'], customTools: tools,
  } satisfies Pick<CreateAgentSessionOptions, 'tools' | 'noTools' | 'excludeTools' | 'customTools'>;
  return {
    ...PI_MEMORY_LANE, tools, extension, toolOptions, close,
    resourceLoaderOptions: {
      extensionFactories: [extension], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      noContextFiles: true,
      // noContextFiles excludes AGENTS/CLAUDE; these explicit inputs also
      // bypass SYSTEM.md and APPEND_SYSTEM.md discovery before any file read.
      systemPrompt: '', appendSystemPrompt: [],
    },
    bindRuntime(runtime: AgentSessionRuntime): void {
      const session = runtime.session;
      assertPiMemoryToolLoadout(session);
      const denied = async (): Promise<never> => { throw new PiMemoryLaneError('memory_lane_operation_denied'); };
      // RPC has shell/export/replacement commands outside the tool pipeline.
      session.executeBash = denied;
      session.exportToHtml = denied;
      runtime.newSession = denied;
      runtime.switchSession = denied;
      runtime.fork = denied;
      runtime.importFromJsonl = denied;
      const prompt = session.prompt.bind(session);
      session.prompt = async (...args) => {
        assertOpen();
        assertPiMemoryToolLoadout(session);
        return prompt(...args);
      };
      const abort = session.abort.bind(session);
      session.abort = async () => {
        const drained = close();
        try { await abort(); } finally { await drained; }
      };
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => {
        await session.abort();
        await dispose();
      };
    },
  };
}
