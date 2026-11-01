/**
 * The `auto` tool authorization gate inside a native Pi subagent child.
 * pi-subagents loads this file into every native child that the parent
 * session requires it for (`adapters/pi/subagents.ts`); the parent host puts
 * the gate in the environment (`setToolAuthorizationGateEnv`). A child with no
 * gate fails to bind its extensions, and pi-subagents rejects the launch.
 *
 * A file-scoped parent also marks this gate config with `fileScopeRequired`
 * and the serialized grant, so the gate itself refuses the six file tools
 * unless the child's scope extension registered the SDK scoped tools.
 */
import { createPiSubagentGateExtension } from '../adapters/pi/subagent-gate';
import { readToolAuthorizationGateEnv } from '../tool-authorization-ipc';

const gate = readToolAuthorizationGateEnv();
if (gate === undefined) throw new Error('tool_authorization_unavailable: a Pi subagent child has no tool authorization gate');

export default createPiSubagentGateExtension(gate);
