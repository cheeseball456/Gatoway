import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "../logging/logger.js";
import { tokensMatch } from "../auth/token.js";
import { encodeMessage, type GatowayMessage } from "../protocol/envelope.js";
import type { RegisterPayload } from "../protocol/messages.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../protocol/tcpFraming.js";
import type { AuthenticateFn } from "./messageHandler.js";
import { handleRawMessage } from "./messageHandler.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { ProtocolRouter } from "./protocolRouter.js";

/**
 * The loopback address the TCP listener binds to (design.md D2, connection-management
 * spec's "Loopback-Only Network Binding"). IPv4 loopback only, per AD-4 v1.1 — IPv6
 * loopback (`::1`) is not required and is not bound (amended after QA-002: requiring
 * both addresses failed startup entirely on hosts without IPv6 loopback available).
 */
const LOOPBACK_ADDRESS = "127.0.0.1";

export interface TcpListenerOptions {
  port: number;
  manager: ConnectionManager;
  logger: Logger;
  /** The current auth token, read once at startup (design.md D5: regenerated per process start). */
  currentToken: string;
  /** Handles `focus`/`input_event` messages and registration notifications (focus-tracking/profile-routing). Optional: omitted in tests that don't exercise those message types. */
  router?: ProtocolRouter;
}

export interface TcpListenerHandle {
  /** The loopback address/port actually bound, once the server has started listening. */
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
  router: ProtocolRouter | undefined,
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
      handleRawMessage(line, connection, manager, authenticate, logger, router);
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
 * Starts the TCP listener bound only to IPv4 loopback (connection-management spec:
 * "Loopback-Only Network Binding"). Resolves only once the server has actually started
 * listening, so callers (and tests) can rely on `addresses` reflecting the real bound
 * state rather than racing an in-flight `listen()` call.
 */
export function startTcpListener(options: TcpListenerOptions): Promise<TcpListenerHandle> {
  const authenticate = authenticateWithToken(options.currentToken);

  const bound = new Promise<{ server: Server; address: string; port: number }>(
    (resolve, reject) => {
      const server = createServer((socket) => {
        handleSocket(socket, options.manager, options.logger, authenticate, options.router);
      });
      server.on("error", (err) => {
        options.logger.error(
          { event: "tcp_listener_error", address: LOOPBACK_ADDRESS, error: err.message },
          "TCP listener error",
        );
        reject(err);
      });
      server.listen(options.port, LOOPBACK_ADDRESS, () => {
        const boundAddress = server.address();
        if (boundAddress === null || typeof boundAddress === "string") {
          reject(new Error(`unexpected TCP listener address for ${LOOPBACK_ADDRESS}`));
          return;
        }
        resolve({ server, address: boundAddress.address, port: boundAddress.port });
      });
    },
  );

  return bound.then(({ server, address, port }) => ({
    addresses: [{ address, port }],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  }));
}
