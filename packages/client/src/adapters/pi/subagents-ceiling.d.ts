export interface SubagentCapabilityCeilingHandle { dispose(): void; }
export declare function registerSubagentCapabilityCeiling(input: {
  sessionId: string; source: string;
  ceiling: { allowedTools: readonly string[]; allowedAgents: readonly string[]; denyExtensions: boolean };
}): SubagentCapabilityCeilingHandle;
