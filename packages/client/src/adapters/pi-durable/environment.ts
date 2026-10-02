import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { buildRuntimeEnv } from '../../daemon/environment';

/** Per-call enforcement: even a tool-provided inheritEnv:true cannot expose provider env. */
export function durableToolEnvironment(cwd: string, ambient: NodeJS.ProcessEnv): NodeExecutionEnv {
  const shellEnv = buildRuntimeEnv({ ambient, requirements: { credentialNames: [] } });
  const env = new NodeExecutionEnv({ cwd, shellEnv });
  const execute = env.exec.bind(env);
  env.exec = (command, options, context) => execute(command, { ...options, env: shellEnv, inheritEnv: false }, context);
  return env;
}
