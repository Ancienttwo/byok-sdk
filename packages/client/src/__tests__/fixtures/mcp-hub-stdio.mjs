import { readFileSync } from 'node:fs';
import { serveMcpHub } from '../../mcp/hub/index.ts';

const { binding, proofPath, denyServer, toolCallTimeoutMs } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
serveMcpHub({
  binding,
  toolCallTimeoutMs,
  isActive: proofPath === undefined ? undefined : () => readFileSync(proofPath, 'utf8') === 'active',
  authorizeCall: ({ server }) => server !== denyServer,
});
