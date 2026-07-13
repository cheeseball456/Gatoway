import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "../logging/logger.js";
import { isOriginAllowed } from "../auth/originAllowlist.js";
import { encodeWsFrame } from "../protocol/wsFraming.js";
import { handleRawMessage, type AuthenticateFn } from "./messageHandler.js";
import type { ConnectionManager } from "./connectionManager.js";

/**
 * The loopback address the WebSocket listener binds to (design.md D2,
 * connection-management spec's "Loopback-Only Network Binding"). IPv4 loopback only,
 * per AD-4 v1.1 — IPv6 loopback (`::1`) is not required and is not bound (amended
 * after QA-002: requiring both addresses failed startup entirely on hosts without
 * IPv6 loopback available).
 */
const LOOPBACK_ADDRESS = "127.0.0.1";

export interface WsListenerOptions {
  port: number;
  manager: ConnectionManager;
  logger: Logger;
  /** Allowlisted Origin header values (design.md D5). */
  allowedOrigins: readonly string[];
}

export interface WsListenerHandle {
  /** The loopback address/port actually bound, once the server has started listening. */
  addresses: { address: string; port: number }[];
  close: () => Promise<void>;
}

// The WebSocket path authenticates via the Origin header at HTTP-upgrade time, before
// a connection record exists (see the "upgrade" handler below and ConnectionManager's
// `preAuthenticated`). By the time a message reaches handleRawMessage, the connection
// is already `authenticated`, so this is never actually invoked — it exists only to
// satisfy messageHandler's shared, transport-agnostic signature (design.md D2/D3).
const alreadyAuthenticated: AuthenticateFn = () => ({ ok: true });

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
  socket.destroy();
}

/**
 * Starts the WebSocket listener bound only to IPv4 loopback. Resolves only once the
 * server has actually started listening, so callers (and tests) can rely on
 * `addresses` reflecting the real bound state rather than racing an in-flight
 * `listen()` call.
 */
export function startWsListener(options: WsListenerOptions): Promise<WsListenerHandle> {
  const wss = new WebSocketServer({ noServer: true });

  const handleConnection = (ws: WebSocket) => {
    const connection = options.manager.accept({
      transport: "websocket",
      preAuthenticated: true,
      send: (message) => {
        ws.send(encodeWsFrame(message));
      },
      close: () => {
        ws.close();
      },
    });

    options.logger.info(
      {
        event: "authentication_succeeded",
        connectionId: connection.id,
        transport: "websocket",
      },
      "authentication succeeded",
    );

    ws.on("message", (data, isBinary) => {
      const raw = isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString();
      handleRawMessage(raw, connection, options.manager, alreadyAuthenticated, options.logger);
    });

    ws.on("close", () => {
      options.manager.disconnect(connection.id, "socket_closed");
    });

    ws.on("error", (err) => {
      options.logger.warn(
        { event: "ws_socket_error", connectionId: connection.id, error: err.message },
        "WebSocket error",
      );
    });
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = request.headers.origin;
    if (!isOriginAllowed(origin, options.allowedOrigins)) {
      options.logger.warn(
        {
          event: "authentication_failed",
          transport: "websocket",
          origin: origin ?? null,
        },
        "authentication failed",
      );
      rejectUpgrade(socket, "403 Forbidden");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws);
    });
  };

  const bound = new Promise<{ server: Server; address: string; port: number }>(
    (resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      });
      server.on("upgrade", handleUpgrade);
      server.on("error", (err) => {
        options.logger.error(
          { event: "ws_listener_error", address: LOOPBACK_ADDRESS, error: err.message },
          "WebSocket listener error",
        );
        reject(err);
      });
      server.listen(options.port, LOOPBACK_ADDRESS, () => {
        const boundAddress = server.address();
        if (boundAddress === null || typeof boundAddress === "string") {
          reject(new Error(`unexpected WebSocket listener address for ${LOOPBACK_ADDRESS}`));
          return;
        }
        resolve({ server, address: boundAddress.address, port: boundAddress.port });
      });
    },
  );

  return bound.then(({ server, address, port }) => ({
    addresses: [{ address, port }],
    close: () =>
      Promise.all([
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
      ]).then(() => undefined),
  }));
}
