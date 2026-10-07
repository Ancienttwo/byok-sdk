import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { durableShell } from './shell';
import { buildAllowlistedEnv } from '../../daemon/environment';

/** Per-call enforcement: even a tool-provided inheritEnv:true cannot expose provider env. */
export function durableToolEnvironment(cwd: string, ambient: NodeJS.ProcessEnv, shellOwnership?: { own(pid:number):Promise<void>; released(pid:number):void }): NodeExecutionEnv {
  const shellEnv = buildAllowlistedEnv({ ambient });
  const env = new NodeExecutionEnv({ cwd, shellEnv });
  const execute = env.exec.bind(env);
  env.exec = (command, options, context) => execute(command, { ...options, env: shellEnv, inheritEnv: false }, context);
  if (shellOwnership) {
    const shell = durableShell(env, shellEnv, shellOwnership.own, shellOwnership.released);
    const cleanup = env.cleanup.bind(env);
    env.exec = shell.exec;
    env.cleanup = async context => { await shell.cleanup(); await cleanup(context); };
  }
  return env;
}
