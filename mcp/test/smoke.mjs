// Smoke test: a mock venue that answers with the REAL response shapes (server/venue.mjs: refusals are HTTP 200 { ok:false, code, reason }; /chain/nonce -> { ok, nonce };
// /chain/health -> { chainId, ledger, ... }; /chain/snapshot -> { ok, snaps }; /chain/build -> { ok, call, callHash }), then drives the MCP over HTTP like a client. Run: node test/smoke.mjs
import http from "node:http";
import assert from "node:assert/strict";
import { callHashOf } from "../src/keccak.mjs";

const U = "0x" + "cd".repeat(20);
const CALL = "0x061f8fe3" + "00".repeat(64); // any ledger calldata: the hash is of its bytes
const seen = [];
const mock = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const u = new URL(req.url, "http://x");
  seen.push({ method: req.method, path: u.pathname.replace("/api/venue", ""), query: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null, headers: req.headers });
  const j = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const p = u.pathname.replace("/api/venue", "");
  if (p === "/health") return j(200, { ok: true, ready: true, phase: "mainnet" });
  if (p === "/chain/health") return j(200, { ok: true, chainId: 99901, ledger: "0x" + "ab".repeat(20), signing: { openLimit: true } });
  if (p === "/chain/nonce") return j(200, { ok: true, source: "x", nonce: 7 });
  if (p === "/chain/snapshot") return j(200, { ok: true, act: "openLegAtFront", snaps: ["0xs1"] });
  if (p === "/access") return j(200, { ok: true, wallet: u.searchParams.get("wallet"), inviteOnly: false, invited: true, termsAccepted: false, canTrade: false });
  if (p === "/perp/plan") return j(200, { ok: true, plan: { floorAfterUSD: 64000, daysProtected: 51 } });
  if (p === "/chain/quote") return j(200, { ok: false, code: "no_single_maker", qty: 2, maxRoom: 0.5, reason: "no single maker" }); // a refusal is HTTP 200
  if (p === "/chain/build") return j(200, { ok: true, act: "connect", call: CALL, callHash: callHashOf(CALL) });
  if (p === "/chain/intent") return j(200, { ok: true, hash: "0xtx" });
  j(404, { error: "nope" });
}).listen(0);
await new Promise((r) => mock.once("listening", r));
process.env.TEMPORAL_BASE = `http://127.0.0.1:${mock.address().port}/api/venue`;

const { serveHttp } = await import("../src/server.mjs");
const srv = serveHttp(0);
await new Promise((r) => srv.once("listening", r));
const MCP = `http://127.0.0.1:${srv.address().port}/mcp`;
let n = 0;
const rpc = async (method, params) => (await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) })).json();
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
assert.equal(init.result.protocolVersion, "2025-06-18");
assert.match(init.result.instructions, /never ask for a private key/);
assert.doesNotMatch(init.result.instructions, /invite-only/i);
assert.equal((await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);

const list = (await rpc("tools/list", {})).result.tools;
assert.ok(list.length >= 13);
for (const t of ["temporal_build_call", "temporal_access"]) assert.ok(list.some((x) => x.name === t), t);
assert.ok(list.every((x) => x.description.length > 60 && x.inputSchema.type === "object" && !("run" in x)));

// plan -> correct upstream body
const plan = await call("temporal_protect_plan", { asset: "BTC", side: 1, depositUSD: 80, lev: 5, target: 64000 });
assert.equal(plan.isError, false);
assert.deepEqual(seen.find((s) => s.path === "/perp/plan").body, { asset: "BTC", side: 1, depositUSD: 80, lev: 5, target: 64000, sellFromRoe: 1, mode: "protect" });

// a refusal arrives as HTTP 200 { ok:false }: it is still an error result, passed through unchanged
const q = await call("temporal_option_quote", { asset: "BTC", side: "buy", wing: "call", strikeUSD: 90000, qty: 2, months: 1 });
assert.equal(q.isError, true);
assert.equal(q.structuredContent.code, "no_single_maker");
assert.equal(q.structuredContent.maxRoom, 0.5);
assert.equal((await call("temporal_option_quote", { asset: "BTC", side: "buy", wing: "call", qty: 2, months: 1 })).isError, true, "needs strikeUSD or k");
assert.equal((await call("temporal_account_state", {})).isError, true);

// access + build
assert.equal((await call("temporal_access", { wallet: U })).structuredContent.canTrade, false);
const built = await call("temporal_build_call", { act: "connect", wallet: U });
assert.equal(built.structuredContent.callHash, callHashOf(CALL));

// prepare: real shapes; the hash is computed here and a wrong one is refused
const prep = await call("temporal_prepare_intent", { user: U, call: CALL, callHash: callHashOf(CALL) });
assert.equal(prep.isError, false, JSON.stringify(prep));
const td = prep.structuredContent.sign;
assert.deepEqual(td.domain, { name: "VenueLedger", version: "1", chainId: 99901, verifyingContract: "0x" + "ab".repeat(20) });
assert.equal(td.message.nonce, "7");
assert.equal(td.message.callHash, callHashOf(CALL));
const bad = await call("temporal_prepare_intent", { user: U, call: CALL, callHash: "0x" + "11".repeat(32) });
assert.equal(bad.isError, true);
assert.equal(bad.structuredContent.code, "callhash_mismatch");

// submit guarded by confirmed:true; a fresh snapshot is attached; the flag is not forwarded
const SIG = "0x" + "01".repeat(65);
const intents = () => seen.filter((s) => s.path === "/chain/intent").length;
const before = intents();
assert.equal((await call("temporal_submit_intent", { user: U, call: CALL, nonce: "7", deadline: "9", sig: SIG, confirmed: false })).isError, true);
assert.equal(intents(), before, "must not hit the venue unconfirmed");
const sub = await call("temporal_submit_intent", { user: U, call: CALL, nonce: "7", deadline: "9", sig: SIG, confirmed: true });
assert.equal(sub.isError, false);
const sent = seen.filter((s) => s.path === "/chain/intent").at(-1).body;
assert.equal("confirmed" in sent, false);
assert.deepEqual(sent.snaps, ["0xs1"]);

assert.equal((await rpc("nope/nope", {})).error.code, -32601);
assert.equal((await fetch(MCP)).status, 405);
assert.equal((await (await fetch(MCP.replace("/mcp", "/.well-known/mcp.json"))).json()).remotes[0].type, "streamable-http");
console.log("all smoke tests passed");
srv.close(); mock.close();
