import type { SupervisedHostState } from '../bridge/protocol.ts';

export interface TrayActions { readonly showWindow: () => void; readonly quit: () => void }

export interface TrayMenuItem {
  readonly label: string;
  readonly enabled?: boolean;
  readonly click?: () => void;
}

/** The tray menu for the Host's last state: show window, active tasks, quit. A Host that is not running has no task count to show. */
export function trayMenu(state: SupervisedHostState | undefined, actions: TrayActions, productName: string): TrayMenuItem[] {
  const tasks = state?.state === 'running' ? `Active tasks: ${state.activeWork}`
    : state?.state === 'stopped' ? `Host stopped: ${state.reason}`
      : state?.state === 'restarting' ? `Host restarting: ${state.reason}`
        : state?.state === 'failed' ? `Host failed: ${state.reason}` : 'Host starting';
  return [
    { label: `Show ${productName}`, click: actions.showWindow },
    { label: tasks, enabled: false },
    { label: 'Quit', click: actions.quit },
  ];
}
