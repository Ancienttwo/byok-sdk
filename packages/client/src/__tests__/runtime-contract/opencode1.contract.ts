import { CONTRACT_OPENCODE_V1_VERSION } from '../../adapters/opencode/opencode-version';
import { defineRuntimeCases, defineRuntimeContract } from './contract';
import { openCodeContract } from './opencode-contract';

const { title, descriptor, plan, lifecycle } = openCodeContract('opencode1', 'opencode 1.x', CONTRACT_OPENCODE_V1_VERSION, [
  { phase: 'turn', target: 'registry.npmjs.org:443', reason: 'OpenCode 1.x installs the configured provider package (@ai-sdk/openai-compatible) from npm into its cache on first use; 2.x bundles it' },
  { phase: 'turn', target: 'github.com:443', reason: 'OpenCode 1.x contacted github.com during the turn in the windows-latest leg (#1593); not seen on macOS or Linux' },
]);
defineRuntimeContract(title, descriptor, plan, {});
defineRuntimeCases(lifecycle.title, lifecycle.cases);
