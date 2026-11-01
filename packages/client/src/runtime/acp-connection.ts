/**
 * Newline-delimited JSON-RPC 2.0 peer for an ACP protocol version 1 agent the
 * SDK drives over stdio: client requests such as `initialize`,
 * `session/new` and `session/prompt`, agent notifications such as
 * `session/update`, and agent requests such as `session/request_permission`.
 *
 * Every line on the agent's stdout must be one JSON-RPC message. A line that
 * is not throws to the owned line transport, which fails and disposes the
 * process tree.
 */

export interface AcpLineTransport {
  write(text: string): void;
  onLine(handler: (line: string) => void): void;
}

export interface AcpPeerHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  /** Answers one agent-to-client request; an unknown method throws {@link AcpMethodNotFound}. */
  request(method: string, params: Record<string, unknown>): unknown;
}

/** A JSON-RPC error answer. `details` is the agent's `data.details` reason code when present (Hermes sets one). */
export class AcpRpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly details?: string) {
    super(`ACP ${method} failed (${code}): ${details ?? message}`);
    this.name = 'AcpRpcError';
  }
}

export class AcpMethodNotFound extends Error {
  constructor(method: string) {
    super(`client does not implement ${method}`);
    this.name = 'AcpMethodNotFound';
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: Error): void }>();
  private closed?: Error;

  /** `peer` names the agent in protocol-violation errors, for example `Hermes`. */
  constructor(private readonly transport: AcpLineTransport, private readonly handlers: AcpPeerHandlers, private readonly peer: string) {
    transport.onLine((line) => this.receive(line));
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) throw this.closed;
    this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Rejects every pending request; later requests reject at once. */
  close(error: Error): void {
    this.closed ??= error;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(this.closed);
    }
  }

  private receive(line: string): void {
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      message = undefined;
    }
    if (message === undefined || message.jsonrpc !== '2.0') throw new Error(`${this.peer} ACP stdout carried a line that is not a JSON-RPC 2.0 message`);
    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = message.id;
    if (method === undefined) {
      if (typeof id !== 'number') throw new Error(`${this.peer} ACP response had no numeric request id`);
      const waiter = this.pending.get(id);
      if (waiter === undefined) throw new Error(`${this.peer} ACP answered unknown request id ${id}`);
      this.pending.delete(id);
      const error = record(message.error);
      if (error === undefined) {
        waiter.resolve(message.result);
        return;
      }
      const data = record(error.data);
      waiter.reject(new AcpRpcError(
        waiter.method,
        typeof error.code === 'number' ? error.code : -32603,
        typeof error.message === 'string' ? error.message : 'unknown error',
        typeof data?.details === 'string' ? data.details : undefined,
      ));
      return;
    }
    const params = record(message.params) ?? {};
    if (id === undefined) {
      this.handlers.notification(method, params);
      return;
    }
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error(`${this.peer} ACP request had an invalid id`);
    let reply: Record<string, unknown>;
    try {
      reply = { result: this.handlers.request(method, params) ?? null };
    } catch (error) {
      if (!(error instanceof AcpMethodNotFound)) throw error;
      reply = { error: { code: -32601, message: error.message } };
    }
    this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...reply })}\n`);
  }
}
