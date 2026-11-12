import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHostLayout } from '@byok-sdk/client';
import { app, BrowserWindow, ipcMain, net, powerSaveBlocker, protocol, session, shell, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import brand from '../../brand.config.ts';
import { BRIDGE_IPC_CHANNEL, RENDERER_METHODS, STATE_HINT_CHANNEL, type BridgeMethods, type BridgeOutcome, type MainMethod } from '../bridge/protocol.ts';
import { createRendererRouter, isAppRefusal, settleCall } from '../bridge/route.ts';
import { createMainHandlers } from './domains.ts';
import { HostProcess, spawnDevHost, spawnDevHostCommand, type SupervisedHostState } from './host-process.ts';
import { spawnPackagedHost, spawnPackagedHostCommand } from './packaged-host.ts';
import { coalesceStateHints } from './state-hint.ts';
import { createAppTray } from './tray.ts';
import { startUpdater } from './updater.ts';

const SCHEME = 'app';
const RENDERER_HOST = 'renderer';
const RENDERER_DIR = fileURLToPath(new URL('../renderer/', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
// assets/ at the app root, in dev and in the asar (scripts/package/build.mjs); macOS picks the @2x template itself.
const TRAY_ICON = fileURLToPath(new URL(`../../../assets/tray/${process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'}`, import.meta.url));
// Packaged local resources only: no remote content, no inline script or style, no network.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; "
  + "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);

let window: BrowserWindow | undefined;
let tray: ReturnType<typeof createAppTray> | undefined;
let lastState: SupervisedHostState | undefined;
let powerBlocker: number | undefined;

/** Keeps the app from suspending while the Host has work; the display may still sleep (docs/host-execution-core.md "Device sleep"). */
function holdPower(state: SupervisedHostState): void {
  const busy = state.state === 'running' && state.activeWork > 0;
  if (busy && powerBlocker === undefined) powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && powerBlocker !== undefined) {
    powerSaveBlocker.stop(powerBlocker);
    powerBlocker = undefined;
  }
}

/** Our own window's main frame, on our own origin: the only frame that may call the bridge or get its hints. */
function isOwnRenderer(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  // A main frame that has not committed its first navigation has an empty url: not ours yet.
  const url = frame && URL.canParse(frame.url) ? new URL(frame.url) : undefined;
  return !!window && frame === window.webContents.mainFrame && url?.protocol === `${SCHEME}:` && url.host === RENDERER_HOST;
}

// No window, or one not showing the renderer yet, has nobody to hint: it reads `status` when it loads.
const hintState = coalesceStateHints(() => {
  const frame = window?.webContents.mainFrame;
  if (isOwnRenderer(frame)) frame.send(STATE_HINT_CHANNEL);
});

const host = new HostProcess({
  spawnHost: app.isPackaged ? spawnPackagedHost : spawnDevHost,
  onState: state => {
    lastState = state;
    holdPower(state);
    hintState();
    tray?.update(state);
    if (state.state === 'stopped' || state.state === 'restarting' || state.state === 'failed') console.error(`Host ${state.state}: ${state.reason}`);
    // Fail closed: no window talks to a Host that did not pass hello.
    if (state.state === 'failed') app.exit(1);
  },
});

const route = createRendererRouter<BridgeMethods, MainMethod>({
  allowed: RENDERER_METHODS,
  main: createMainHandlers({ callHost: (method, params) => host.call(method, params), spawnHostCommand: app.isPackaged ? spawnPackagedHostCommand : spawnDevHostCommand }),
  host: (method, params) => host.call(method, params as never),
});

/** Serves the renderer directory on app://renderer/ with the CSP header; anything outside it is 404. */
function serveRenderer(request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  const file = resolve(RENDERER_DIR, `.${decodeURIComponent(url.pathname)}`);
  if (url.host !== RENDERER_HOST || !file.startsWith(RENDERER_DIR.endsWith(sep) ? RENDERER_DIR : RENDERER_DIR + sep)) {
    return new Response(null, { status: 404 });
  }
  return net.fetch(pathToFileURL(file).href).then(response => {
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(response.body, { status: response.status, headers });
  });
}

/** Only the main frame of our own window, on our own origin, may call the bridge, and only allowlisted methods. */
async function forward(event: IpcMainInvokeEvent, method: unknown, params: unknown): Promise<BridgeOutcome> {
  if (!isOwnRenderer(event.senderFrame)) throw new Error('bridge_sender_refused');
  const outcome = await settleCall(() => route(method, params), isAppRefusal);
  // A refusal no longer rejects the IPC handler, so Electron logs nothing: name the method (one line, whatever the renderer
  // sent) and the message, never the params.
  if (!outcome.ok && outcome.code === 'method_failed') console.error(`Bridge call ${String(method).replace(/[\r\n]/g, ' ')} failed: ${outcome.message}`);
  return outcome;
}

function openExternal(target: string): void {
  const url = URL.canParse(target) ? new URL(target) : undefined;
  if (url?.protocol === 'https:' && brand.externalOrigins.includes(url.origin)) void shell.openExternal(url.href);
}

function createWindow(): void {
  window = new BrowserWindow({
    title: brand.productName,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = undefined; });
  void window.loadURL(`${SCHEME}://${RENDERER_HOST}/index.html`);
}

function showWindow(): void {
  if (!window) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
});

// Chromium's own state moves under the host storage root, apart from the Host's stores in `<root>/host`.
// It is set before the single-instance lock and before 'ready', which fix the userData directory.
app.setPath('userData', join(resolveHostLayout({ productId: brand.productId, productName: brand.productName }).hostStorageRoot, 'shell'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(brand.productName);
  app.on('second-instance', showWindow);
  // The app stays in the tray when its last window closes (#1499 s1.3); the tray's Quit ends it.
  app.on('window-all-closed', () => {});
  app.on('activate', () => { if (!window) createWindow(); });

  let stopping = false;
  app.on('before-quit', event => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    host.stop().then(() => app.exit(0), (error: Error) => {
      console.error(`Host shutdown failed: ${error.message}`);
      app.exit(1);
    });
  });

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    protocol.handle(SCHEME, serveRenderer);
    ipcMain.handle(BRIDGE_IPC_CHANNEL, forward);
    host.start();
    startUpdater({ beforeInstall: () => host.stop() });
    createWindow();
    tray = createAppTray(TRAY_ICON, brand.productName, { showWindow, quit: () => app.quit() });
    tray.update(lastState);
  }).catch((error: Error) => {
    // A missing tray icon or another startup failure leaves no way back to the app. The Host closes with its pipe.
    console.error(`Startup failed: ${error.message}`);
    app.exit(1);
  });
}
