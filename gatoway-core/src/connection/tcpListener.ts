import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "../logging/logger.js";
import { tokensMatch } from "../auth/token.js";
import { encodeMessage, type GatowayMessage } from "../protocol/envelope.js";
import type { RegisterPayload } from "../protocol/messages.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../protocol/tcpFraming.js";
import type { AuthenticateFn } from "./messageHandler.js";
import { handleRawMessage } from "./messageHandler.js";
import type { ConnectionManager } from "./connectionManager.js";

/** Loopback addresses the TCP listener binds to (design.md D2, connection-management spec). */
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;

export interface TcpListenerOptions {
  port: number;
  manager: ConnectionManager;
  logger: Logger;
  /** The current auth token, read once at startup (design.md D5: regenerated per process start). */
  currentToken: string;
}

export interface TcpListenerHandle {
  /** The loopback addresses/ports actually bound, once each server has started listening. */
  addresses: { address: string; port: number }[];
  close: () => Promise<void>;
}

function authenticateWithToken(currentToken: string): AuthenticateFn {
  return (_connection, payload: RegisterPayload) => {
    if (tokensMatch(currentToken, payload.token)) {
      return { ok: true };
    }
    return { ok: false, reason: "invalid_token" };
  };
}

function handleSocket(
  socket: Socket,
  manager: ConnectionManager,
  logger: Logger,
  authenticate: AuthenticateFn,
): void {
  const decoder = new NdjsonDecoder();
  socket.setEncoding("utf8");

  const connection = manager.accept({
    transport: "tcp",
    send: (message: GatowayMessage) => {
      socket.write(encodeNdjsonLine(encodeMessage(message)));
    },
    close: () => {
      socket.end();
    },
  });

  socket.on("data", (chunk: string) => {
    const lines = decoder.push(chunk);
    for (const line of lines) {
      handleRawMessage(line, connection, manager, authenticate, logger);
    }
  });

  const onClose = () => {
    manager.disconnect(connection.id, "socket_closed");
  };
  socket.on("close", onClose);
  socket.on("error", (err) => {
    logger.warn(
      { event: "tcp_socket_error", connectionId: connection.id, error: err.message },
      "TCP socket error",
    );
  });
}

/**
 * Starts the TCP listener bound only to loopback addresses (connection-management
 * spec: "Loopback-Only Network Binding"). Binds two separate `net.Server` instances —
 * one per loopback address — since a single Node `net.Server` binds one address at a
 * time. Resolves only once every server has actually started listening, so callers
 * (and tests) can rely on `addresses` reflecting the real bound state rather than
 * racing an in-flight `listen()` call.
 */
export function startTcpListener(options: TcpListenerOptions): Promise<TcpListenerHandle> {
  const authenticate = authenticateWithToken(options.currentToken);

  const listening = LOOPBACK_ADDRESSES.map(
    (address) =>
      new Promise<{ server: Server; address: string; port: number }>((resolve, reject) => {
        const server = createServer((socket) => {
          handleSocket(socket, options.manager, options.logger, authenticate);
        });
        server.on("error", (err) => {
          options.logger.error(
            { event: "tcp_listener_error", address, error: err.message },
            "TCP listener error",
          );
          reject(err);
        });
        server.listen(options.port, address, () => {
          const boundAddress = server.address();
          if (boundAddress === null || typeof boundAddress === "string") {
            reject(new Error(`unexpected TCP listener address for ${address}`));
            return;
          }
          resolve({ server, address: boundAddress.address, port: boundAddress.port });
        });
      }),
  );

  return Promise.all(listening).then((bound) => ({
    addresses: bound.map(({ address, port }) => ({ address, port })),
    close: () =>
      Promise.all(
        bound.map(
          ({ server }) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      ).then(() => undefined),
  }));
}
