import { QUALIFIED_OPENCODE_VERSION } from '../../adapters/opencode/opencode-version';
import { defineRuntimeContract } from './contract';
import { openCodeContract } from './opencode-contract';

const { title, descriptor, plan } = openCodeContract('opencode2', 'opencode 2.x', QUALIFIED_OPENCODE_VERSION);
defineRuntimeContract(title, descriptor, plan, {});
