#!/usr/bin/env node
// Zero-dependency MCP server for Temporal.
//   Remote:  node src/server.mjs            -> Streamable HTTP at POST /mcp (stateless, JSON responses)
//   Local:   node src/server.mjs --stdio    -> stdio transport for Claude Desktop / Cursor / OpenClaw
// No keys, no sessions, no state: safe to host publicly.

import http from "node:http";
import readline from "node:readline";
import { tools, INSTRUCTIONS } from "./tools.mjs";

export { tools, INSTRUCTIONS };

export const VERSION = "0.2.0";
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const byName = new Map(tools.map((t) => [t.name, t]));

const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });

function missingRequired(schema, args) {
  const has = (k) => args[k] !== undefined && args[k] !== null;
  const miss = (schema.required || []).filter((k) => !has(k));
  // anyOf: [{required:[a]},{required:[b]}] = at least one of a, b
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((o) => (o.required || []).every(has))) miss.push(`one of ${schema.anyOf.map((o) => o.required.join("+")).join(" | ")}`);
  return miss;
}

/** @param ctx { base?: venue API base URL, headers?: forwarded to the venue (hosted mode: the caller's address, so the venue's per-address limits see the caller) } */
export async function handle(msg, ctx = {}) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;

  switch (method) {
    case "initialize": {
      const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return ok(id, {
        protocolVersion: v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "temporal", title: "Temporal: perp liquidation protection and perpetual options on Hyperliquid", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: tools.map(({ run, ...t }) => t),
      });
    case "tools/call": {
      const tool = byName.get(params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      const args = params.arguments || {};
      const miss = missingRequired(tool.inputSchema, args);
      if (miss.length)
        return ok(id, { isError: true, content: [{ type: "text", text: `Missing required: ${miss.join(", ")}` }] });
      try {
        const r = await tool.run(args, ctx);
        const payload = r.ok ? r.data : { refused: true, status: r.status, ...(typeof r.data === "object" ? r.data : { detail: r.data }) };
        return ok(id, {
          isError: !r.ok,
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        });
      } catch (e) {
        return ok(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e.message, detail: e.detail }) }] });
      }
    }
    default:
      if (isNotification || method.startsWith("notifications/")) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---- Streamable HTTP (stateless) -------------------------------------------

function serveHttp(port) {
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const origin = req.headers.origin;
    if (origin && allowed.length && !allowed.includes(origin)) return send(res, 403, { error: "origin_not_allowed" });

    if (url.pathname === "/" || url.pathname === "/healthz") return send(res, 200, { name: "temporal-mcp", version: VERSION, mcp: "/mcp", docs: "https://protect.temporal.exchange/llms.txt" });
    if (url.pathname === "/.well-known/mcp.json" || url.pathname === "/.well-known/mcp/server.json") return send(res, 200, card(req.headers["x-forwarded-host"] || req.headers.host));
    if (url.pathname !== "/mcp") return send(res, 404, { error: "not_found" });
    if (req.method === "GET") { res.writeHead(405, { allow: "POST" }); return res.end(); } // no server-initiated stream
    if (req.method === "DELETE") { res.writeHead(405); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }

    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 256_000) return send(res, 413, rpcError(null, -32600, "Too large")); }
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(res, 400, rpcError(null, -32700, "Parse error")); }
    if (Array.isArray(msg)) return send(res, 400, rpcError(null, -32600, "Batching not supported"));
    const out = await handle(msg);
    if (out === null) { res.writeHead(202); return res.end(); }
    send(res, 200, out);
  });
  server.listen(port, () => console.error(`temporal-mcp listening on :${port}/mcp`));
  return server;
}

export function card(host) {
  return {
    name: "exchange.temporal/temporal",
    title: "Temporal",
    description: "Protect Hyperliquid perps from liquidation; trade and sell perpetual (non-expiring) options backed by perps; earn by making option markets. Open beta, keyless: your wallet signs.",
    version: VERSION,
    remotes: [{ type: "streamable-http", url: `https://${host}/mcp` }],
    tools: tools.map((t) => t.name),
    docs: "https://protect.temporal.exchange/llms.txt",
  };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

// ---- stdio -------------------------------------------------------------------

function serveStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return process.stdout.write(JSON.stringify(rpcError(null, -32700, "Parse error")) + "\n"); }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--stdio")) serveStdio();
  else serveHttp(Number(process.env.PORT || 8787));
}
export { serveHttp };
