/**
 * The file-scope extension of a native Pi subagent child (#1061 D11).
 *
 * A scoped parent requires this file in every native child beside the tool
 * authorization gate. It reads the same serialized grant from the child gate
 * config, re-resolves every root and verifies the digest before registering
 * the SDK scoped file tools. Any failure leaves the six file tools blocked;
 * the gate extension refuses the native fallback.
 */
import { createPiSubagentFileScopeExtension } from '../adapters/pi/subagent-file-scope';
import { readToolAuthorizationGateEnv } from '../tool-authorization-ipc';

const gate = readToolAuthorizationGateEnv();
if (gate === undefined) throw new Error('file_scope_unavailable: a Pi subagent child has no tool authorization gate');

export default createPiSubagentFileScopeExtension(gate);
