import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WorkerChannelService } from "./worker-channel.ts";

type WorkerSocketMessage = { workerId?: unknown; credential?: unknown; connectionId?: unknown; hello?: unknown; frame?: unknown };

function isWorkerPath(url: string | undefined): boolean {
  return new URL(url ?? "/", "http://localhost").pathname === "/api/v1/worker/connect";
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(value));
}

export function attachWorkerWebSocket(server: HttpServer, channel: WorkerChannelService): WebSocketServer {
  const gateway = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  server.on("close", () => {
    for (const client of gateway.clients) {
      if (typeof client.terminate === "function") client.terminate(); else client.close();
    }
    gateway.close();
  });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!isWorkerPath(request.url)) { socket.destroy(); return; }
    gateway.handleUpgrade(request, socket, head, (client) => gateway.emit("connection", client, request));
  });
  gateway.on("connection", (socket: WebSocket) => {
    let identity: { workerId: string; credential: string; connectionId: string } | undefined;
    socket.on("message", (raw: Buffer) => {
      void (async () => {
        let message: WorkerSocketMessage;
        try { message = JSON.parse(raw.toString("utf8")) as WorkerSocketMessage; } catch { send(socket, { error: { code: "INVALID_WORKER_MESSAGE" } }); return; }
        const workerId = typeof message.workerId === "string" ? message.workerId : identity?.workerId;
        const credential = typeof message.credential === "string" ? message.credential : identity?.credential;
        const connectionId = typeof message.connectionId === "string" ? message.connectionId : identity?.connectionId;
        if (!workerId || !credential || !connectionId) { send(socket, { error: { code: "WORKER_AUTH_REQUIRED" } }); socket.close(1008, "worker authentication required"); return; }
        try {
          const result = message.frame
            ? (channel.receive(workerId, credential, message.frame as never), channel.poll({ workerId, credential, connectionId }))
            : channel.poll({ workerId, credential, connectionId, hello: message.hello as never });
          identity = { workerId, credential, connectionId: result.connectionId };
          send(socket, { type: "poll", ...result });
        } catch (error) {
          const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: number }).status) : 400;
          send(socket, { error: { code: error instanceof Error ? error.message : "WORKER_CHANNEL_ERROR", status } });
          if (status === 401 || status === 409) socket.close(1008, "worker channel rejected message");
        }
      })();
    });
    socket.on("close", () => { identity = undefined; });
  });
  return gateway;
}
