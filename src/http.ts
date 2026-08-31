import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { healthz, readyz } from "./health.js";
import { createServer } from "./server.js";

/**
 * Streamable HTTP entrypoint.
 *
 * One MCP session == one Server + one transport, held in memory and keyed by
 * the Mcp-Session-Id the transport issues on initialize. That makes this
 * process single-replica by construction: scaling the Deployment past one pod
 * without sticky sessions produces intermittent "session not found" errors,
 * because a follow-up request can land on a pod that never saw the
 * initialize. See the deployment notes before changing replicas.
 */

const sessions = new Map<string, StreamableHTTPServerTransport>();

function sessionIdOf(req: Request): string | undefined {
  const header = req.headers["mcp-session-id"];
  return Array.isArray(header) ? header[0] : header;
}

export function buildApp(): express.Express {
  const app = express();

  // Health endpoints are registered before the JSON body parser and carry no
  // auth: kubelet probes must not depend on either.
  app.get("/healthz", healthz);
  app.get("/readyz", readyz);

  app.use(express.json({ limit: "4mb" }));

  // ── POST /mcp: JSON-RPC in, JSON or SSE out ────────────────────────────────
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        res.status(404).json(rpcError(-32001, "Session not found", req.body?.id));
        return;
      }
      await existing.handleRequest(req, res, req.body);
      return;
    }

    // No session yet: only an initialize request may open one.
    if (!isInitializeRequest(req.body)) {
      res
        .status(400)
        .json(rpcError(-32000, "Bad Request: no session, and body is not an initialize request", req.body?.id));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        console.error(`[http] session opened: ${id} (${sessions.size} open)`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        console.error(`[http] session closed: ${id} (${sessions.size} open)`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await createServer().connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ── GET /mcp: the SSE stream the client opens after initialize ─────────────
  app.get("/mcp", async (req: Request, res: Response) => {
    const transport = requireSession(req, res);
    if (!transport) return;
    await transport.handleRequest(req, res);
  });

  // ── DELETE /mcp: explicit session teardown ─────────────────────────────────
  app.delete("/mcp", async (req: Request, res: Response) => {
    const transport = requireSession(req, res);
    if (!transport) return;
    await transport.handleRequest(req, res);
  });

  return app;
}

function requireSession(req: Request, res: Response): StreamableHTTPServerTransport | null {
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(400).json(rpcError(-32000, "Bad Request: Mcp-Session-Id header is required"));
    return null;
  }
  const transport = sessions.get(sessionId);
  if (!transport) {
    res.status(404).json(rpcError(-32001, "Session not found"));
    return null;
  }
  return transport;
}

function rpcError(code: number, message: string, id: unknown = null) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: id ?? null };
}

export function startHttpServer(): void {
  const app = buildApp();
  const { host, port } = config.server;

  const httpServer = app.listen(port, host, () => {
    console.error(`[http] MCP server listening on http://${host}:${port}/mcp`);
    console.error(`[http] FHIR ${config.fhir.version} base: ${config.fhir.baseUrl}`);
  });

  // SSE streams are long-lived; do not let Node time them out mid-stream.
  httpServer.headersTimeout = 0;
  httpServer.requestTimeout = 0;

  const shutdown = (signal: string) => {
    console.error(`[http] ${signal} received, closing ${sessions.size} session(s)`);
    for (const transport of sessions.values()) void transport.close();
    sessions.clear();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
