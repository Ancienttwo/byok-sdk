import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { PiRpcClient, type PiRpcMessage } from '../adapters/pi/rpc-client';
import { resolvePiBin } from '../adapters/pi/resolve-bin';
import { codexTeamNotification } from './team-codex-relay';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIALOGS = new Set(['confirm', 'select', 'input', 'editor']);
export interface PiInteractionResponse { sessionId: string; requestId: string; response: { cancelled: true } | { confirmed: boolean } | { value: string }; }
export interface PiTeamSessionOptions {
  workspaceId: string; cwd: string; sessionDir: string; provider: string; model: string;
  systemPrompt: string; mcpConfig: Record<string, unknown>; extensionPaths?: readonly string[];
  onEvent: (event: Record<string, unknown>) => void;
}

/** One owned RPC child; GUI replies never share a model-controlled tool channel. */
export class PiTeamSession {
  private client!: PiRpcClient;
  private sessionId: string | undefined;
  private revision = 0;
  private phase: 'starting' | 'open' | 'waiting' | 'failed' | 'closed' = 'starting';
  private readonly interactions = new Map<string, PiRpcMessage>();
  private readonly replying = new Set<string>();
  private stopping = false;
  private active = false;
  private pendingInputs = 0;
  private readonly privateFiles: string[] = [];
  private constructor(private readonly options: PiTeamSessionOptions) {}
  static async start(options: PiTeamSessionOptions): Promise<PiTeamSession> {
    for (const value of [options.cwd, options.sessionDir, ...(options.extensionPaths ?? [])]) if (!path.isAbsolute(value)) throw new Error('Pi relay paths must be absolute');
    if (!options.provider || !options.model || !options.systemPrompt) throw new Error('Pi relay requires explicit provider, model and system prompt');
    const bin = resolvePiBin();
    const version = await new Promise<string>((resolve, reject) => execFile(bin.command, ['--version'], { timeout: 10_000, maxBuffer: 1024 }, (error, stdout) => error ? reject(new Error('Pi version preflight failed')) : resolve(stdout.trim())));
    if (version !== '0.85.1') throw new Error('Pi relay requires exactly 0.85.1');
    const host = new PiTeamSession(options);
    await fs.mkdir(options.sessionDir, { mode: 0o700 }); // Explicit fresh session; never adopt.
    const mcpPath = path.join(options.sessionDir, 'team-mcp.json');
    const promptPath = path.join(options.sessionDir, 'system-prompt.txt');
    try {
      for (const [file, text] of [[mcpPath, JSON.stringify(options.mcpConfig)], [promptPath, options.systemPrompt]] as const) {
        host.privateFiles.push(file); await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
      }
      const packageDir = path.dirname(fileURLToPath(import.meta.resolve('@byok-sdk/client/package.json')));
      const args = ['--mode', 'rpc', '--session-dir', options.sessionDir, '--provider', options.provider, '--model', options.model,
        '--system-prompt', promptPath, '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-builtin-tools', '--exclude-tools', 'mcp,mcpScript',
        '--extension', path.join(packageDir, 'dist/adapters/pi/team-interaction-extension.js'),
        '--extension', path.join(packageDir, 'dist/adapters/pi/mcp-extension.js')];
      for (const extension of options.extensionPaths ?? []) args.push('--extension', extension);
      host.client = new PiRpcClient({ command: bin.command, args, cwd: options.cwd,
        env: { ...process.env, BYOK_PI_MCP_CONFIG_PATH: mcpPath },
        extensionUi: { mode: 'hold', onRequest: frame => host.onInteraction(frame) },
        onFrame: frame => host.onFrame(frame),
      });
      // Consume the existing event transport so a GUI relay never grows a second backlog.
      void (async () => { for await (const _frame of host.client.events) { /* synchronous onFrame is the consumer */ } if (!host.stopping) host.fail(); })();
      await host.state();
      if (!host.sessionId || host.revision < 1 || host.phase === 'failed') throw new Error('Pi gate startup did not establish an exact session');
      options.onEvent({ event: 'pi_ready', sessionId: host.sessionId, version, provider: options.provider, model: options.model });
      return host;
    } catch (error) { await host.stop(); throw error; }
  }
  status() { return { sessionId: this.sessionId, phase: this.phase, revision: this.revision, pendingUi: [...this.interactions.values()].map(r => ({ id: r.id, method: r.method, responding: this.replying.has(r.id!) })) }; }
  private fail(): void {
    if (this.stopping || this.phase === 'failed') return;
    this.phase = 'failed'; this.options.onEvent({ event: 'pi_failed', reason: 'native_authority_or_transport_failure' }); this.client?.kill();
  }
  private onFrame(frame: PiRpcMessage): void {
    if (this.stopping || this.phase === 'failed') return;
    if (frame.type === 'extension_ui_request' && frame.method === 'setStatus' && frame.statusKey === 'byok_team_gate') {
      try { frame = JSON.parse(String(frame.statusText)) as PiRpcMessage; } catch { this.fail(); return; }
      if (!frame || frame.type !== 'byok_team_gate') { this.fail(); return; }
      if (typeof frame.sessionId !== 'string' || !UUID.test(frame.sessionId) || (this.sessionId && frame.sessionId !== this.sessionId) || frame.revision !== this.revision + 1 || !['open', 'waiting', 'failed', 'closed'].includes(String(frame.phase))) { this.fail(); return; }
      this.sessionId = frame.sessionId; this.revision = frame.revision as number;
      if (frame.phase === 'failed' || frame.phase === 'closed') { this.fail(); return; }
      this.phase = frame.phase as 'open' | 'waiting';
      this.options.onEvent({ event: 'pi_gate', ...this.status() });
    } else if (frame.type === 'agent_start') {
      this.active = true;
    } else if (frame.type === 'agent_settled') {
      this.active = false;
      this.options.onEvent({ event: 'pi_settled', sessionId: this.sessionId });
    } else if (frame.type === 'extension_error') this.fail();
  }
  private onInteraction(frame: PiRpcMessage): void {
    if (this.stopping || this.phase === 'failed') return;
    if (!DIALOGS.has(String(frame.method))) return;
    if (typeof frame.id !== 'string' || !UUID.test(frame.id) || this.interactions.has(frame.id) || this.interactions.size >= 32 || typeof frame.title !== 'string' || JSON.stringify(frame).length > 65_536) { this.fail(); return; }
    this.interactions.set(frame.id, frame);
    this.options.onEvent({ event: 'ui_request', sessionId: this.sessionId, request: frame });
  }
  private async request(command: PiRpcMessage): Promise<PiRpcMessage> {
    if (this.stopping || this.phase === 'failed') throw new Error('Pi relay is not available');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([this.client.send(command), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error('Pi RPC delivery deadline')), 30_000); })]);
      if (!result.success || result.command !== command.type) throw new Error('Pi RPC rejected the operation');
      return result;
    } catch { this.fail(); throw new Error('Pi RPC delivery is unknown; no automatic retry'); }
    finally { clearTimeout(timer); }
  }
  private async state(): Promise<Record<string, unknown>> {
    const result = await this.request({ type: 'get_state' }); const state = result.data;
    if (!state || typeof state !== 'object' || Array.isArray(state) || (state as Record<string, unknown>).sessionId !== this.sessionId || (typeof (state as Record<string, unknown>).isStreaming !== 'boolean' || typeof (state as Record<string, unknown>).isCompacting !== 'boolean')) { this.fail(); throw new Error('Pi session identity or state is invalid'); }
    const model = (state as Record<string, unknown>).model;
    if (!model || typeof model !== 'object' || (model as Record<string, unknown>).provider !== this.options.provider || (model as Record<string, unknown>).id !== this.options.model) {
      this.fail(); throw new Error('Pi provider/model differs from the explicit binding');
    }
    return state as Record<string, unknown>;
  }
  async ready(): Promise<boolean> {
    const state = await this.state();
    return !this.active && this.phase === 'open' && this.interactions.size === 0 && state.isStreaming === false && state.isCompacting === false;
  }
  async notify(throughSeq: number, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('relay stopped');
    const stop = () => this.client.kill(); signal.addEventListener('abort', stop, { once: true });
    this.active = true; // Preflight receipt precedes agent_start on native RPC.
    try { return await this.sendInput(codexTeamNotification(this.options.workspaceId, throughSeq)); }
    finally { signal.removeEventListener('abort', stop); }
  }
  async sendInput(message: string): Promise<string> {
    if (!message || Buffer.byteLength(message) > 16_384) throw new Error('Pi input must contain 1–16384 bytes');
    if (this.phase !== 'open' || this.interactions.size) throw new Error('Pi interaction is pending');
    this.pendingInputs++;
    try {
      const id = randomUUID(); await this.request({ type: 'prompt', id, message, streamingBehavior: 'followUp' });
      // Native preflight precedes run start. A following state receipt fences
      // that transition, including GUI inputs and immediately handled commands.
      if ((await this.state()).isStreaming === true) this.active = true;
      return id;
    } finally { this.pendingInputs--; }
  }
  async respond(input: PiInteractionResponse): Promise<void> {
    if (input.sessionId !== this.sessionId || this.phase === 'failed' || this.stopping) throw new Error('Pi interaction session is stale');
    const request = this.interactions.get(input.requestId);
    if (!request || this.replying.has(input.requestId)) throw new Error('Pi interaction request is stale or already answered');
    const response = input.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid UI response');
    const keys = Object.keys(response);
    const cancel = keys.length === 1 && 'cancelled' in response && response.cancelled === true;
    const confirm = keys.length === 1 && request.method === 'confirm' && 'confirmed' in response && typeof response.confirmed === 'boolean';
    const value = keys.length === 1 && ['select', 'input', 'editor'].includes(String(request.method)) && 'value' in response && typeof response.value === 'string' && Buffer.byteLength(response.value) <= 16_384 && (request.method !== 'select' || (Array.isArray(request.options) && request.options.includes(response.value)));
    if (!cancel && !confirm && !value) throw new Error('Pi interaction response does not match the request');
    this.replying.add(input.requestId);
    try {
      await this.client.respondExtensionUi({ id: input.requestId, ...response });
      this.interactions.delete(input.requestId);
      this.options.onEvent({ event: 'ui_response_sent', sessionId: this.sessionId, requestId: input.requestId });
    } catch { this.fail(); throw new Error('Pi UI response delivery is unknown'); }
    finally { this.replying.delete(input.requestId); }
  }
  async drain(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 120_000;
    while ((this.active || this.pendingInputs > 0) && !signal.aborted) {
      if (this.phase === 'failed' || Date.now() >= deadline) throw new Error('Pi settlement deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    try { await this.client?.dispose(); }
    finally {
      this.phase = 'closed';
      for (const file of this.privateFiles) await fs.rm(file, { force: true });
    }
  }
}
