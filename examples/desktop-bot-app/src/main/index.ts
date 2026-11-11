import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, powerSaveBlocker, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import brand from '../../brand.config.ts';
import { BRIDGE_IPC_CHANNEL, RENDERER_METHODS, type RendererMethod } from '../bridge/protocol.ts';
import { HostProcess, spawnDevHost, type SupervisedHostState } from './host-process.ts';

const SCHEME = 'app';
const RENDERER_HOST = 'renderer';
const RENDERER_DIR = fileURLToPath(new URL('../renderer/', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
// Packaged local resources only: no remote content, no inline script or style, no network.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; "
  + "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);

let window: BrowserWindow | undefined;
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

const host = new HostProcess({
  spawnHost: spawnDevHost,
  onState: state => {
    holdPower(state);
    if (state.state === 'stopped' || state.state === 'restarting' || state.state === 'failed') console.error(`Host ${state.state}: ${state.reason}`);
    // Fail closed: no window talks to a Host that did not pass hello.
    if (state.state === 'failed') app.exit(1);
  },
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
function forward(event: IpcMainInvokeEvent, method: unknown, params: unknown): Promise<unknown> {
  const frame = event.senderFrame;
  const url = frame ? new URL(frame.url) : undefined;
  if (!window || frame !== window.webContents.mainFrame || url?.protocol !== `${SCHEME}:` || url.host !== RENDERER_HOST) {
    throw new Error('bridge_sender_refused');
  }
  if (!RENDERER_METHODS.includes(method as RendererMethod)) throw new Error('bridge_method_refused');
  return host.call(method as RendererMethod, params as undefined);
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

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(brand.productName);
  app.on('second-instance', () => {
    if (!window) return createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
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
    createWindow();
  });
}
