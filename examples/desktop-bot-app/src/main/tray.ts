import { app, Menu, Tray, nativeImage } from 'electron';
import type { LoginItemView } from '../bridge/domains/settings.ts';
import type { SupervisedHostState } from './host-process.ts';
import { trayMenu, type TrayActions } from './tray-menu.ts';

/**
 * The tray icon and its menu. `iconPath` is the app's own tray image; an
 * unreadable image throws instead of showing a blank tray. The app stays alive
 * in the tray when the window closes (#1499 s1.3), so the tray is the way back.
 */
export function createAppTray(iconPath: string, productName: string, actions: TrayActions) {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) throw new Error(`Tray icon ${iconPath} is missing or unreadable`);
  const tray = new Tray(image);
  tray.setToolTip(productName);
  tray.on('click', actions.showWindow);
  const render = (state: SupervisedHostState | undefined) => tray.setContextMenu(Menu.buildFromTemplate(trayMenu(state, actions, productName)));
  render(undefined);
  return { update: render, destroy: () => tray.destroy() };
}

/**
 * Opens the app at login. Electron applies the setting on macOS and Windows
 * only; on Linux it is a silent no-op, so asking for it there fails closed.
 */
export function setLoginItem(enabled: boolean): void {
  if (process.platform === 'linux') throw new Error('Login item is not supported on Linux');
  app.setLoginItemSettings({ openAtLogin: enabled });
  if (app.getLoginItemSettings().openAtLogin !== enabled) throw new Error('The OS did not apply the login item setting');
}

/** The login item as the OS reports it; Linux has none. */
export function loginItem(): LoginItemView {
  return process.platform === 'linux' ? { supported: false, enabled: false } : { supported: true, enabled: app.getLoginItemSettings().openAtLogin };
}
