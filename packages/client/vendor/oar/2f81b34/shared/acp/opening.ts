// BYOK change: Modified from OAR 2f81b34 to observe, beside the opening boundary, which notifications were read while a prompt awaited its answer (Apache-2.0).
/* oxlint-disable typescript/promise-function-async -- Stream callbacks forward the original writer promises. */
import { methods, type AnyMessage, type JsonRpcId, type Stream } from "@agentclientprotocol/sdk";

export interface AcpOpening {
  outgoing(message: AnyMessage): void;
  incoming(message: AnyMessage): void;
  afterOpen(params: object): boolean;
}

/** Preserve the wire's opening boundary across the SDK's asynchronous notification routing. */
export function createAcpOpening(): AcpOpening {
  const requests = new Set<JsonRpcId>();
  const live = new WeakSet<object>();
  let opened = false;
  return {
    outgoing(message: AnyMessage): void {
      if ("id" in message && "method" in message
        && (message.method === methods.agent.session.new || message.method === methods.agent.session.resume || message.method === methods.agent.session.load)) {
        requests.add(message.id);
      }
    },
    incoming(message: AnyMessage): void {
      if ("id" in message && !("method" in message) && requests.delete(message.id) && "result" in message) { opened = true; }
      if (!("id" in message) && "method" in message && opened) {
        const { params } = message;
        if (params !== null && typeof params === "object") { live.add(params); }
      }
    },
    afterOpen(params: object): boolean { return live.has(params); },
  };
}

/** Observe decoded messages without changing them or delaying dispatch. */
export function observeAcpOpening(stream: Stream, opening: AcpOpening): Stream {
  const writer = stream.writable.getWriter();
  return {
    readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        opening.incoming(message);
        controller.enqueue(message);
      },
    })),
    writable: new WritableStream<AnyMessage>({
      write(message) { opening.outgoing(message); return writer.write(message); },
      close() { return writer.close(); },
      abort(reason: unknown) { return writer.abort(reason); },
    }),
  };
}

// BYOK change: the prompt-answer boundary, observed the same way as the opening boundary above.
/**
 * Which decoded notifications arrived, in wire order, while a `session/prompt`
 * request still awaited its answer. The SDK routes notifications
 * asynchronously, so neither the prompt promise nor a notification handler
 * knows on which side of the answer line a notification was read.
 */
export interface AcpPromptAnswers {
  outgoing(message: AnyMessage): void;
  incoming(message: AnyMessage): void;
  whilePromptAwaited(params: object): boolean;
}

export function createAcpPromptAnswers(): AcpPromptAnswers {
  const requests = new Set<JsonRpcId>();
  const awaited = new WeakSet<object>();
  return {
    outgoing(message: AnyMessage): void {
      if ("id" in message && "method" in message && message.method === methods.agent.session.prompt) { requests.add(message.id); }
    },
    incoming(message: AnyMessage): void {
      if ("id" in message && !("method" in message)) { requests.delete(message.id); return; }
      if (!("id" in message) && "method" in message && requests.size > 0) {
        const { params } = message;
        if (params !== null && typeof params === "object") { awaited.add(params); }
      }
    },
    whilePromptAwaited(params: object): boolean { return awaited.has(params); },
  };
}

/** One stream observer for the opening boundary and the prompt answers, in that order. */
export function withAcpPromptAnswers(opening: AcpOpening, answers: AcpPromptAnswers): AcpOpening {
  return {
    outgoing(message: AnyMessage): void { opening.outgoing(message); answers.outgoing(message); },
    incoming(message: AnyMessage): void { opening.incoming(message); answers.incoming(message); },
    afterOpen: (params: object): boolean => opening.afterOpen(params),
  };
}
