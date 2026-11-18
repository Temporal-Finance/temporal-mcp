// Temporal MCP tools.
//
// Design rules (mirroring https://protect.temporal.exchange/llms.txt):
//  - This server NEVER holds or asks for a key. It reads, plans, builds, dry-runs and prepares typed data; the caller's wallet signs;
//    the server only relays what the wallet signed.
//  - Every act needs: read -> build -> dry-run -> state outcome + cost -> explicit yes. `temporal_submit_intent` refuses unless `confirmed: true`.
//  - Named refusals are surfaced verbatim and never auto-retried.
//
// Descriptions are written as TRIGGERS: they describe the situation an agent is in ("opening a leveraged perp", "idle USDC"), not the product,
// because models choose tools by matching the task in front of them to these strings.
//
// Shapes are the venue's own (server/venue.mjs, server/agentBuild.mjs): `call` is the 0x-hex ledger calldata, callHash = keccak256(call bytes),
// the signed type is VenueIntent(address user, bytes32 callHash, uint256 nonce, uint256 deadline) under the domain {VenueLedger, 1, chainId, ledger}.

import { callHashOf } from "./keccak.mjs";

export const BASE = process.env.TEMPORAL_BASE || "https://protect.temporal.exchange/api/venue";
const UA = "temporal-mcp/0.2 (+https://protect.temporal.exchange/llms.txt)";

/** The venue answers a refusal with HTTP 200 and { ok: false, code, reason }, so a call succeeded only when BOTH the status and the body's `ok` say so. */
export async function api(method, path, { query, body } = {}, ctx = {}) {
  const url = new URL((ctx.base || BASE) + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { "user-agent": UA, accept: "application/json", ...(ctx.headers || {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok && !(data && typeof data === "object" && data.ok === false), status: res.status, data };
}

const refuse = (status, code, detail, extra = {}) => ({ ok: false, status, data: { ok: false, code, reason: detail, ...extra } });

const asset = { type: "string", enum: ["BTC", "HYPE"], description: "Underlying. BTC is open; HYPE is close-only during the beta (open positions can be closed, nothing new opens)." };
const wallet = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "The trader's wallet address (public address only, never a key)." };
const callHex = { type: "string", pattern: "^0x[0-9a-fA-F]{8,}$", description: "The ledger act as 0x-hex calldata, exactly as temporal_build_call returned it." };
const optSide = { type: "string", enum: ["buy", "sell"], description: "The TRADER's side: buy = you buy the option (you pay the maker's ask), sell = you sell it (you get the maker's bid)." };
const wing = { type: "string", enum: ["call", "put"], description: "Call or put." };

// --- tool table -------------------------------------------------------------

export const tools = [
  {
    name: "temporal_protect_plan",
    title: "Plan liquidation protection for a Hyperliquid perp",
    description:
      "Use whenever you are opening, sizing, adding leverage to, or holding a leveraged BTC perp on Hyperliquid and liquidation risk matters. " +
      "Returns a Temporal Protect structure: the same perp plus attached perpetual options (no expiry) that move the liquidation price to your target, " +
      "with the net cost, and 'days protected' (how long margin covers the options' holding cost in the worst case; <30 days is a warning). " +
      "Read-only, no signature. Prefer this over lowering leverage or adding margin when you want to keep exposure but survive a wick. " +
      "The plan names the legs; to open it, build the act with temporal_build_call (act openPerpWithLegs) from the plan's legs.",
    inputSchema: {
      type: "object",
      properties: {
        asset,
        side: { type: "integer", enum: [1, -1], description: "1 = long, -1 = short." },
        depositUSD: { type: "number", exclusiveMinimum: 0, description: "Margin in USDC." },
        lev: { type: "number", exclusiveMinimum: 0, description: "Leverage, e.g. 5." },
        target: { type: "number", exclusiveMinimum: 0, description: "Target liquidation price in USD." },
        protectDays: { type: "number", exclusiveMinimum: 0, description: "Optional: how many days the protection must last (blank = 30)." },
        pieceUSD: { type: "number", exclusiveMinimum: 0, description: "Optional premium per matched piece (default 1000)." },
      },
      required: ["asset", "side", "depositUSD", "lev", "target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("POST", "/perp/plan", { body: { ...a, sellFromRoe: 1, mode: "protect" } }, ctx),
  },
  {
    name: "temporal_option_quote",
    title: "Quote a perpetual (non-expiring) call or put",
    description:
      "Use when you want option exposure on BTC without managing expiries or rolls, when you want to sell volatility, or when you want to compare a hedge's cost against Deribit. " +
      "Returns the best firm single-maker price for the full size on Temporal's perpetual options: no expiry; the holder instead pays a continuous holding cost (think: funding for options). " +
      "The answer carries the fee, the oracle venue's side price it is measured from (oracleSideUSD) and the order as pieces. Read-only, no signature. " +
      "Counts toward the unfilled-request limit (20 a minute, 60 in 10 minutes); a refusal such as NoSingleMaker(qty, maxRoom) means size down.",
    inputSchema: {
      type: "object",
      properties: {
        asset,
        side: optSide,
        wing,
        strikeUSD: { type: "number", exclusiveMinimum: 0, description: "Strike in USD. Give this or k." },
        k: { type: "number", exclusiveMinimum: 0, description: "Strike as a ratio to spot (1.05 = 5 % above spot). Give this or strikeUSD." },
        qty: { type: "number", exclusiveMinimum: 0, description: "Size in coins (BTC or HYPE)." },
        months: { type: "number", exclusiveMinimum: 0, description: "Duration in months (a missing duration is refused: months_required)." },
        wallet: { ...wallet, description: "Optional; adds your own margin requirement to the answer." },
      },
      required: ["asset", "side", "wing", "qty", "months"],
      anyOf: [{ required: ["strikeUSD"] }, { required: ["k"] }],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("GET", "/chain/quote", { query: a }, ctx),
  },
  {
    name: "temporal_option_optimise",
    title: "Preview how an option order would fill",
    description:
      "Use after temporal_option_quote and before placing an order, to see how the order splits into pieces, and (Flex strike/duration) whether a nearby strike or duration fills with less slippage. " +
      "Use it to size down when a NoSingleMaker refusal appears. Read-only, no signature.",
    inputSchema: {
      type: "object",
      properties: {
        asset,
        side: optSide,
        wing,
        strikeUSD: { type: "number", exclusiveMinimum: 0, description: "Strike in USD." },
        qty: { type: "number", exclusiveMinimum: 0, description: "Size in coins." },
        months: { type: "number", exclusiveMinimum: 0, description: "Duration in months." },
        optimise: { type: "boolean", description: "Flex strike/duration: true (default) lets the venue move to a nearby strike or duration when that saves slippage; false fills your exact pick." },
        autoAt: { type: "number", minimum: 0, maximum: 100, description: "Optimise only when your pick's slippage is over this % (default 5; 0 = always)." },
        strikeRate: { type: "number", minimum: 0, maximum: 100, description: "Slippage % that must be saved to move the strike 1 % (default 1)." },
        decayRate: { type: "number", minimum: 0, maximum: 100, description: "Slippage % that must be saved to move the duration 1 % (default 1)." },
        optSlipPct: { type: "number", minimum: 0, maximum: 100, description: "Max slippage % per piece against the oracle side (default 2)." },
      },
      required: ["asset", "side", "wing", "strikeUSD", "qty", "months"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    // this route reads the venue's other coding: side 1 buy / -1 sell, wing 1 call / -1 put; `v: 2` asks for the blocks solver
    run: (a, ctx) => api("POST", "/option/optimise", { body: { ...a, side: a.side === "buy" ? 1 : -1, wing: a.wing === "call" ? 1 : -1, v: 2 } }, ctx),
  },
  {
    name: "temporal_earn_plan",
    title: "Preview earning yield by making option markets (TLP)",
    description:
      "Use when you hold idle USDC on Hyperliquid and want yield, or already hold a BTC perp and want extra income on it (covered-call style: sold calls can be covered by a long perp, sold puts by a short perp). " +
      "Previews a maker account's quoting (the Automatic / TLP split and the caps that bound its room). " +
      "Returns come from half the oracle venue's spread plus holding cost on options you write, minus the venue's 10 %; option P/L can be negative. Read-only. " +
      "It is a preview of a maker account that already exists (accountId from temporal_account_state); with none, the venue names what it needs.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "The maker (EARN) account to preview, as the venue names it in temporal_account_state." },
        asset: { ...asset, description: "The market the account quotes." },
        inventoryFrac: { type: "number", minimum: -1, maximum: 1, description: "What-if: the share of its room the account's inventory fills (the preview's stand marker)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("POST", "/earn/plan", { body: a }, ctx),
  },
  {
    name: "temporal_account_state",
    title: "Read a wallet's Temporal accounts, positions and margin",
    description:
      "Use before any act, and whenever you need a Temporal position's value, margin, or distance to liquidation. " +
      "Returns free cash, accounts (OPTIONS, PROTECT, EARN; each account's `id` is the number temporal_build_call takes as `account`), legs and perps with their valuation, and margin. Read-only.",
    inputSchema: { type: "object", properties: { wallet }, required: ["wallet"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("GET", "/chain/state", { query: { wallet: a.wallet } }, ctx),
  },
  {
    name: "temporal_access",
    title: "Check whether a wallet may trade on Temporal, and how to get access",
    description:
      "Use FIRST for any wallet that has not traded here yet. Temporal is an open beta ($100 per wallet, not offered in some countries): a wallet must accept the terms of use once (one signature, no gas) before it can deposit or trade. " +
      "Returns { inviteOnly, invited, termsAccepted, canTrade, caps, termsMessage?, how }. If canTrade is false, tell the human what `how` says; do not keep trying acts. Read-only.",
    inputSchema: { type: "object", properties: { wallet }, required: ["wallet"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("GET", "/access", { query: { wallet: a.wallet } }, ctx),
  },
  {
    name: "temporal_venue_status",
    title: "Check Temporal venue health, prices and fees",
    description:
      "Use first in a session, or when a quote looks stale or a refusal mentions prices or maintenance. Returns venue status and per-asset price freshness (/health) and chain ID, ledger address, signing settings, priced assets, fees and maintenance (/chain/health). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (_a, ctx) => {
      const [h, c] = await Promise.all([api("GET", "/health", {}, ctx), api("GET", "/chain/health", {}, ctx)]);
      const keep = (o, ks) => (o && typeof o === "object" ? Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : o);
      return {
        ok: h.ok && c.ok,
        status: h.ok ? c.status : h.status,
        data: {
          health: keep(h.data, ["ok", "ready", "phase", "oracleTier", "oracleSurfaceSource", "launchGate", "seq"]),
          chain: keep(c.data, ["ok", "reason", "chainId", "ledger", "venueVersion", "pricedAssets", "signing", "fees", "ledgerSettings", "maintenance", "oracleTier", "lag"]),
        },
      };
    },
  },
  {
    name: "temporal_fills",
    title: "List a wallet's fills",
    description: "Use to confirm an act filled, or to report P/L history. Newest first. The index trails the chain by a few seconds: if a fill is not there yet, wait and read again. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        wallet,
        account: { type: "string", default: "all", description: "'all' or one account's id." },
        page: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["wallet"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("GET", "/chain/fills", { query: { account: "all", page: 0, limit: 50, ...a } }, ctx),
  },
  {
    name: "temporal_funding_info",
    title: "Get the deposit address and HyperCore balance",
    description: "Use when a wallet needs to fund Temporal with USDC from Hyperliquid. Returns where to send USDC and what has arrived, plus the wallet's HyperCore balance. No gas coin is needed. Read-only.",
    inputSchema: { type: "object", properties: { wallet }, required: ["wallet"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a, ctx) => {
      const [d, b] = await Promise.all([api("GET", "/chain/deposits", { query: { wallet: a.wallet } }, ctx), api("GET", "/hypercore/balance", { query: { wallet: a.wallet } }, ctx)]);
      return { ok: d.ok && b.ok, status: d.ok ? b.status : d.status, data: { deposits: d.data, hypercore: b.data } };
    },
  },
  {
    name: "temporal_build_call",
    title: "Build the ledger call for an act from plain numbers",
    description:
      "Use to turn what the human wants into the exact ledger call, so nothing is hand-encoded. Give the act, the wallet and that act's arguments in plain units; get back { call (0x calldata), callHash }. Builds only: nothing is signed or sent. " +
      "Acts and their arguments: connect (none); mintAccount (kind: options | protect | earn); deposit / withdraw (account, usd); " +
      "openLegAtFront (account, asset, side buy|sell, wing, strikeUSD, months, qty, consentUSD = the most cash the open may draw, boundUSD = the price limit per coin: a buy fills at most it, a sell at least it; the venue may require it); " +
      "closeLegAtFront (account, legIndex, qty, moreLegs?); closeAccountAtFront (account); " +
      "openPerpWithLegs (account, asset, side long|short, qty, leverage, marginUSD, limitUSD?, legs: 1 to 4 of { wing, side, strikeUSD, qty, months, boundUSD, consentUSD }); requestClosePerp (account, perpId). " +
      "`account` is the ledger account id from temporal_account_state; a new wallet connects and mints first. A bad argument is refused by name (bad_arg, with the argument).",
    inputSchema: {
      type: "object",
      properties: {
        act: { type: "string", enum: ["connect", "mintAccount", "deposit", "withdraw", "openLegAtFront", "closeLegAtFront", "closeAccountAtFront", "openPerpWithLegs", "requestClosePerp"] },
        wallet,
        account: { type: "integer", minimum: 0, description: "Ledger account id (the `id` of an account in temporal_account_state)." },
        kind: { type: "string", enum: ["options", "protect", "earn"], description: "mintAccount: the account kind." },
        usd: { type: "number", exclusiveMinimum: 0, description: "deposit / withdraw: dollars." },
        asset,
        side: { type: "string", enum: ["buy", "sell", "long", "short"], description: "openLegAtFront: buy | sell (the trader's side). openPerpWithLegs: long | short. Each leg of a structure carries its own buy | sell." },
        wing,
        strikeUSD: { type: "number", exclusiveMinimum: 0 },
        months: { type: "number", exclusiveMinimum: 0, description: "Duration in months." },
        qty: { type: "number", exclusiveMinimum: 0, description: "Size in coins." },
        consentUSD: { type: "number", minimum: 0, description: "The most cash (dollars) the open may draw from the account." },
        boundUSD: { type: "number", exclusiveMinimum: 0, description: "The price limit, dollars per 1.0 coin." },
        legIndex: { type: "integer", minimum: 0 },
        moreLegs: { type: "array", items: { type: "integer", minimum: 0 }, description: "closeLegAtFront: more leg indices closed whole in the same act." },
        leverage: { type: "integer", minimum: 1, maximum: 255 },
        marginUSD: { type: "number", exclusiveMinimum: 0 },
        limitUSD: { type: "number", exclusiveMinimum: 0, description: "openPerpWithLegs: the perp's price limit (a long's highest entry, a short's lowest)." },
        legs: {
          type: "array", minItems: 1, maxItems: 4,
          items: {
            type: "object",
            properties: { wing, side: optSide, strikeUSD: { type: "number" }, qty: { type: "number" }, months: { type: "number" }, boundUSD: { type: "number" }, consentUSD: { type: "number" } },
            required: ["wing", "side", "strikeUSD", "qty", "months", "boundUSD"],
            additionalProperties: false,
          },
        },
        perpId: { type: "integer", minimum: 0 },
      },
      required: ["act", "wallet"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("POST", "/chain/build", { body: a }, ctx),
  },
  {
    name: "temporal_dryrun",
    title: "Dry-run a Temporal act",
    description:
      "Required before every act. Simulates the ledger act and returns what would happen, or the named refusal, without changing anything; also returns callHash. " +
      "After this, tell the human the outcome and cost in plain words and wait for an explicit yes before temporal_prepare_intent.",
    inputSchema: {
      type: "object",
      properties: { user: wallet, call: callHex, extraCashUSD: { type: "number", minimum: 0, default: 0, description: "Cash a HyperCore transfer would add first (0 for most acts)." } },
      required: ["user", "call"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("POST", "/chain/dryrun", { body: { extraCashUSD: 0, ...a } }, ctx),
  },
  {
    name: "temporal_prepare_intent",
    title: "Prepare EIP-712 typed data for the wallet to sign",
    description:
      "Use after a dry-run the human approved. Reads the next nonce and the chain/ledger domain and returns the exact VenueIntent EIP-712 typed data for the caller's wallet to sign (eth_signTypedData_v4). " +
      "The callHash is computed here from the call itself and checked against any callHash you pass, so the wallet never signs a hash that is not this call's. " +
      "This server never signs and never needs a key. Pass the signature and the returned `submit` fields to temporal_submit_intent.",
    inputSchema: {
      type: "object",
      properties: {
        user: wallet,
        call: callHex,
        callHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "Optional: the callHash temporal_build_call returned. It is verified, never trusted." },
        ttlSeconds: { type: "integer", default: 120, minimum: 10, maximum: 600, description: "How long the signature stays valid (the venue allows up to 600)." },
      },
      required: ["user", "call"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a, ctx) => {
      let callHash;
      try { callHash = callHashOf(a.call); } catch { return refuse(400, "bad_call", "call must be 0x-hex ledger calldata."); }
      if (a.callHash && a.callHash.toLowerCase() !== callHash) return refuse(400, "callhash_mismatch", "The callHash you passed is not the keccak256 of this call. Nothing was prepared.", { expected: callHash });
      const [n, c] = await Promise.all([api("GET", "/chain/nonce", { query: { wallet: a.user } }, ctx), api("GET", "/chain/health", {}, ctx)]);
      if (!n.ok) return n;
      if (!c.ok && c.data?.chainId == null) return c;
      const { chainId, ledger } = c.data ?? {};
      const nonce = n.data?.nonce;
      if (chainId == null || !ledger || nonce == null) return refuse(502, "domain_unknown", "The venue did not return chainId, ledger and nonce.", { chain: { chainId, ledger }, nonce });
      const deadline = Math.floor(Date.now() / 1000) + (a.ttlSeconds ?? 120);
      return {
        ok: true,
        status: 200,
        data: {
          sign: {
            domain: { name: "VenueLedger", version: "1", chainId: Number(chainId), verifyingContract: ledger },
            types: { VenueIntent: [{ name: "user", type: "address" }, { name: "callHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
            primaryType: "VenueIntent",
            message: { user: a.user, callHash, nonce: String(nonce), deadline: String(deadline) },
          },
          submit: { user: a.user, call: a.call, nonce: String(nonce), deadline: String(deadline) },
          next: "Have the wallet sign `sign` with eth_signTypedData_v4, then call temporal_submit_intent with `submit` plus sig and confirmed:true. The fresh price snapshot the act needs is fetched at submit time (it lives seconds).",
        },
      };
    },
  },
  {
    name: "temporal_submit_intent",
    title: "Submit a signed Temporal act",
    description:
      "Sends ONE wallet-signed ledger act (open/close a leg, open a protected perp, deposit, withdraw, ...). Moves real money. " +
      "Only call after temporal_dryrun, after stating outcome and cost to the human, and after they said yes; set confirmed:true to attest that. " +
      "The venue submits it and pays the gas. If the venue refuses, report the named reason and do not retry with different numbers unless asked; never resend a signed act that may have landed without reading temporal_fills first.",
    inputSchema: {
      type: "object",
      properties: {
        user: wallet,
        call: callHex,
        nonce: { type: "string", pattern: "^\\d+$" },
        deadline: { type: "string", pattern: "^\\d+$" },
        sig: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$", description: "The wallet's 65-byte EIP-712 signature." },
        snaps: { type: "array", items: { type: "string" }, description: "Optional. Left out, a fresh price snapshot is fetched now." },
        confirmed: { type: "boolean", description: "Must be true: the human approved this exact act after a dry-run." },
      },
      required: ["user", "call", "nonce", "deadline", "sig", "confirmed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: async (a, ctx) => {
      if (a.confirmed !== true) return refuse(400, "not_confirmed", "Dry-run, state outcome and cost, get an explicit yes, then retry with confirmed:true.");
      const { confirmed, ...body } = a;
      if (!body.snaps) {
        // the snapshot is not part of the signature and lives seconds: fetch it now. A refusal (an act that reads no price, a surface the venue cannot sign) sends without; the venue then decides, by name.
        const s = await api("POST", "/chain/snapshot", { body: { call: a.call, wallet: a.user } }, ctx);
        if (s.ok && Array.isArray(s.data?.snaps)) body.snaps = s.data.snaps;
      }
      return api("POST", "/chain/intent", { body }, ctx);
    },
  },
];

export const INSTRUCTIONS = `Temporal (temporal.exchange) is a venue for perpetual options on BTC and HYPE, settled in USDC on Hyperliquid mainnet.
Two things agents use it for:
1) Protect: keep a leveraged Hyperliquid perp's exposure but push its liquidation price away, using attached non-expiring options whose premiums roughly offset. Start with temporal_protect_plan.
2) Options without expiry: buy or sell calls/puts that never expire; holders pay a continuous holding cost (funding for options) instead of rolling. Sellers can back a sold option with a perp instead of cash. Start with temporal_option_quote.
Yield: idle USDC or an existing perp can earn by making markets (TLP). Start with temporal_earn_plan.
Access: Temporal is an open beta ($100 per wallet): any wallet outside the blocked countries can trade after accepting the terms once (one signature, no gas: POST /terms/accept; GET /launch/gate?wallet= returns the exact text to sign). Call temporal_access for the wallet first; if canTrade is false, tell the human what it says and do not try acts.
Flow for every act: read state (temporal_account_state) -> temporal_build_call -> temporal_dryrun -> state outcome and cost in plain words and wait for an explicit yes -> temporal_prepare_intent -> the human's wallet signs -> temporal_submit_intent (confirmed:true) -> temporal_fills to confirm.
Rules: the human's wallet signs every act; never ask for a private key. Named refusals change nothing: report them and do not retry with different numbers unless asked.
Beta limits: open beta, unaudited, $100 per wallet, BTC open, HYPE close-only, not offered in some countries. Full reference: https://protect.temporal.exchange/llms.txt`;
