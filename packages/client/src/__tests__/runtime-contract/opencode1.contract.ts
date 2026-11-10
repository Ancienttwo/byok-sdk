import { CONTRACT_OPENCODE_V1_VERSION } from '../../adapters/opencode/opencode-version';
import { defineRuntimeCases, defineRuntimeContract } from './contract';
import { openCodeContract } from './opencode-contract';

const { title, descriptor, plan, lifecycle } = openCodeContract('opencode1', 'opencode 1.x', CONTRACT_OPENCODE_V1_VERSION, [
  { phase: 'turn', target: 'registry.npmjs.org:443', reason: 'OpenCode 1.x installs the configured provider package (@ai-sdk/openai-compatible) from npm into its cache on first use; 2.x bundles it' },
  // On Windows, 1.x resolves ripgrep from PATH, then its own bin directory, and otherwise downloads ripgrep 15.1.0 from
  // github.com/BurntSushi/ripgrep/releases; a runner without `rg` on PATH reaches github.com. macOS without `rg` did not (#1593).
  ...(process.platform === 'win32' ? [{ phase: 'turn' as const, target: 'github.com:443', reason: 'OpenCode 1.x downloads ripgrep 15.1.0 from github.com/BurntSushi/ripgrep/releases when no rg is on PATH' }] : []),
]);
defineRuntimeContract(title, descriptor, plan, {});
defineRuntimeCases(lifecycle.title, lifecycle.cases);
