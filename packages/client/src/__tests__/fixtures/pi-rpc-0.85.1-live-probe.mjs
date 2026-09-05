// This probe runs the RPC serializer shipped by the package pinned in this
// workspace. It supplies the smallest possible in-memory session so it needs
// neither credentials nor a network request.

const packageEntryUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const rpcModeUrl = new URL('./modes/rpc/rpc-mode.js', packageEntryUrl);
const { runRpcMode } = await import(rpcModeUrl);

const session = {
  model: undefined,
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'queue',
  sessionFile: undefined,
  sessionId: 'pi-rpc-live-probe',
  sessionName: undefined,
  autoCompactionEnabled: true,
  messages: [],
  pendingMessageCount: 0,
  bindExtensions: async () => {},
  subscribe(listener) {
    queueMicrotask(() => {
      listener({
        type: 'tool_execution_start',
        toolCallId: 'pi-probe-tool-call',
        toolName: 'pi_probe_tool',
        args: { input: 'probe' },
      });
      listener({
        type: 'tool_execution_end',
        toolCallId: 'pi-probe-tool-call',
        toolName: 'pi_probe_tool',
        result: { content: [{ type: 'text', text: 'probe failure' }] },
        isError: true,
      });
    });
    return () => {};
  },
  agent: {
    subscribe: () => () => {},
  },
};

await runRpcMode({
  session,
  setRebindSession: () => {},
  dispose: async () => {},
});
