import { QUALIFIED_OPENCODE_VERSION } from '../../adapters/opencode/opencode-version';
import { defineRuntimeCases, defineRuntimeContract } from './contract';
import { openCodeContract } from './opencode-contract';
import { openCodeChildCases } from './opencode-child-contract';

const contract = openCodeContract('opencode2', 'opencode 2.x', QUALIFIED_OPENCODE_VERSION);
const { title, descriptor, plan, lifecycle } = contract;
defineRuntimeContract(title, descriptor, plan, {});
defineRuntimeCases(lifecycle.title, lifecycle.cases);
defineRuntimeCases('opencode2 background child contract', openCodeChildCases(contract));
