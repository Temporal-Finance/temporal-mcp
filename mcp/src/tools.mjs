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
export async function api(method, path, { query, body, token } = {}, ctx = {}) {
  const url = new URL((ctx.base || BASE) + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { "user-agent": UA, accept: "application/json", ...(ctx.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok && !(data && typeof data === "object" && data.ok === false), status: res.status, data };
}

const refuse = (status, code, detail, extra = {}) => ({ ok: false, status, data: { ok: false, code, reason: detail, ...extra } });

// ---- maker routes: a venue session token is passed PER CALL (Authorization: Bearer), never stored, never logged, never echoed back ----
const token = { type: "string", minLength: 16, maxLength: 256, description: "The venue session token from temporal_session_open. Sent on this call only; never store or print it." };
const confirmed = { type: "boolean", description: "Must be true: the human approved this exact change after you described it." };
const notConfirmed = () => refuse(400, "not_confirmed", "Describe the change in plain words, get an explicit yes, then retry with confirmed:true. Nothing was changed.");
/** A maker WRITE: refused without confirmed:true; sent once, never retried; the venue's refusal is passed through by name. */
async function makerWrite(a, path, body, ctx) {
  if (a.confirmed !== true) return notConfirmed();
  return api("POST", path, { body, token: a.token }, ctx);
}
/** temporal_maker_settings without a patch: the account's dials, from the session's own view. */
async function makerRead(a, ctx) {
  const s = await api("GET", "/state", { token: a.token }, ctx);
  if (!s.ok) return s;
  const accts = Object.entries(s.data?.view?.wallet?.accounts ?? {}).filter(([, x]) => x?.kind === "earn");
  const pick = accts.filter(([k, x]) => (a.accountKey == null || k === a.accountKey || x.id === a.accountKey) && (a.account == null || String(x.ledgerAccountId) === String(a.account)));
  return { ok: true, status: 200, data: { accounts: pick.map(([k, x]) => ({ id: x.id ?? k, ledgerAccountId: x.ledgerAccountId, asset: x.asset, quoting: x.quoting, mode: x.mode, curve: x.curve, curves: x.curves })) } };
}


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
      "openPerpWithLegs (account, asset, side long|short, qty, leverage, marginUSD, limitUSD?, legs: 1 to 4 of { wing, side, strikeUSD, qty, months, boundUSD, consentUSD }); requestClosePerp (account, perpId); exitMaker (account: an EARN maker leaves: its written options are handed to the other makers at market; refused by name ExitOff while the venue has it off, Underwater below margin). " +
      "`account` is the ledger account id from temporal_account_state; a new wallet connects and mints first. A bad argument is refused by name (bad_arg, with the argument).",
    inputSchema: {
      type: "object",
      properties: {
        act: { type: "string", enum: ["connect", "mintAccount", "deposit", "withdraw", "openLegAtFront", "closeLegAtFront", "closeAccountAtFront", "openPerpWithLegs", "requestClosePerp", "exitMaker"] },
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
  // ---- MAKERS: the bearer-session controls. TLP is the default way to earn; Custom is only for a maker who brings its own pricing. ----
  {
    name: "temporal_session_prepare",
    title: "Get the message a maker wallet signs to open a venue session",
    description:
      "Use FIRST when an agent must change maker settings (quoting on or off, caps, a covering perp, a custom bot's registration): those routes need a venue session, not a ledger signature. " +
      "Returns { address, nonce, message }: have the wallet sign `message` with personal_sign (EIP-191; it authorises nothing, moves no funds, costs no gas; the nonce expires in 10 minutes), then call temporal_session_open. Nothing is stored on this server.",
    inputSchema: { type: "object", properties: { wallet }, required: ["wallet"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("POST", "/auth/nonce", { body: { address: a.wallet } }, ctx),
  },
  {
    name: "temporal_session_open",
    title: "Turn the wallet's signature into a venue session token",
    description:
      "Use after the wallet signed the message from temporal_session_prepare. Returns { token, wallet }: the caller keeps the token and passes it as `token` to the maker tools (it is sent as Authorization: Bearer on that one call). " +
      "This server keeps nothing and logs nothing; never paste the token into chat or a log. The session carries no spending power: money still moves only by wallet-signed acts (temporal_build_call). A bad or expired signature is refused by name.",
    inputSchema: {
      type: "object",
      properties: { wallet, signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$", description: "The wallet's personal_sign signature over the exact message temporal_session_prepare returned." } },
      required: ["wallet", "signature"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (a, ctx) => {
      const r = await api("POST", "/auth/verify", { body: { address: a.wallet, signature: a.signature } }, ctx);
      if (!r.ok) return r;
      return { ok: true, status: r.status, data: { token: r.data?.token, wallet: r.data?.wallet, next: "Pass `token` to the temporal_maker_* tools. Close it with temporal_session_close when done." } };
    },
  },
  {
    name: "temporal_session_close",
    title: "End a venue session",
    description: "Use when the maker work is finished, or the token may have leaked: revokes that session token at the venue. Changes nothing else.",
    inputSchema: { type: "object", properties: { token }, required: ["token"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (a, ctx) => api("POST", "/auth/logout", { token: a.token, body: {} }, ctx),
  },
  {
    name: "temporal_maker_state",
    title: "Read a maker's accounts: quoting state, caps, margin, liquidation distance",
    description:
      "Use before any maker change, and on a timer by a custom maker's bot. Returns the signed-in wallet's EARN (maker) accounts as the venue records them (`id` = the record key the other maker tools take as accountKey, `ledgerAccountId`, quoting on or off, mode, curve dials) " +
      "plus the ledger's own numbers for the wallet from temporal_account_state (equity, margin requirement, distance to liquidation, positions) when you also pass `wallet`. Read-only; the session token is sent on this call only.",
    inputSchema: { type: "object", properties: { token, wallet: { ...wallet, description: "Optional: also reads the ledger accounts (equity, requirement, liquidation distance, legs, perps)." } }, required: ["token"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a, ctx) => {
      const [s, c] = await Promise.all([api("GET", "/state", { token: a.token }, ctx), a.wallet ? api("GET", "/chain/state", { query: { wallet: a.wallet } }, ctx) : Promise.resolve(null)]);
      if (!s.ok) return s;
      const accts = s.data?.view?.wallet?.accounts ?? {};
      const KEEP = ["id", "name", "kind", "asset", "quoting", "mode", "tlp", "closed", "ledgerAccountId", "depositUSD", "withdrawableUSD", "curve", "curves"];
      const earn = Object.entries(accts).filter(([, x]) => x?.kind === "earn").map(([key, x]) => Object.fromEntries([["id", x.id ?? key], ...KEEP.filter((k) => k !== "id" && x[k] !== undefined).map((k) => [k, x[k]])]));
      return { ok: true, status: 200, data: { earnAccounts: earn, ledger: c ? (c.ok ? c.data : { refused: true, ...c.data }) : undefined } };
    },
  },
  {
    name: "temporal_maker_connections",
    title: "List a maker wallet's registered custom-bot connections",
    description: "Use to check whether a custom maker's bot is registered and online (poll transport) or to find the connection `id` that temporal_maker_unregister takes. Read-only. Not needed for TLP: the venue runs that program.",
    inputSchema: { type: "object", properties: { token }, required: ["token"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => api("GET", "/rfq/makers", { token: a.token }, ctx),
  },
  {
    name: "temporal_maker_quoting",
    title: "Turn a maker account's quoting on or off",
    description:
      "Use to start or stop making markets on an EARN account. TLP is the default way to earn (one deposit, the venue quotes for you): quoting on with mode auto and tlp:true. " +
      "Custom (mode custom) is only for a maker that brings its own pricing and runs its own bot; the venue enforces only the hard limits. Quoting needs a deposit on the account (refused by name: no_deposit) and a mode when the curve is untouched (mode_unconfirmed). " +
      "Quoting off is always allowed. A maker that leaves must also close its positions (see temporal_build_call: closeLegAtFront, exitMaker, closeAccountAtFront). Moves no money but changes who can trade against the account's margin: describe it to the human and wait for a yes; set confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        token,
        on: { type: "boolean", description: "true = start quoting, false = stop." },
        account: { type: "integer", minimum: 0, description: "The ledger account id of the EARN account (temporal_account_state `id`)." },
        accountKey: { type: "string", description: "Optional: the venue record key from temporal_maker_state `id`." },
        mode: { type: "string", enum: ["auto", "custom"], description: "auto = the venue quotes the oracle's own bid and ask for you (TLP is auto). custom = your bot quotes (register it with temporal_maker_register)." },
        tlp: { type: "boolean", description: "true marks the account as a TLP (the one-click market maker across listed assets). Use with mode auto." },
        asset: { type: "string", enum: ["BTC", "HYPE"], description: "The market the account quotes (default BTC)." },
        confirmed,
      },
      required: ["token", "on", "confirmed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (a, ctx) => makerWrite(a, "/account/quoting", { id: a.accountKey ?? null, on: a.on, ...(a.mode ? { mode: a.mode } : {}), ...(a.tlp != null ? { tlp: a.tlp } : {}), ...(a.asset ? { asset: a.asset } : {}), ...(a.account != null ? { ledgerAccountId: a.account } : {}) }, ctx),
  },
  {
    name: "temporal_maker_settings",
    title: "Read or set a TLP / AUTO maker account's caps and spread dials",
    description:
      "For TLP and AUTO accounts, where the venue prices for you: use to read or change the caps that bound the account's room and its spread. A CUSTOM maker prices in its own bot and owns its limits there; it normally never needs this (it does need temporal_maker_state). " +
      "Without `patch` this reads the account's dials. With `patch` it sets them (confirmed:true required): Eplus = the most net long exposure the account may take, in coins, 0 or more; Eminus = the most net short exposure, 0 or less (a patch that breaks these bounds is refused by name and nothing is applied); " +
      "hBps = half-spread in basis points (0 to 150); preset = track (quote the oracle's own bid and ask, TLP / AUTO) or own (the page-typed custom curve). `raw` (custom curves only) posts a grid; the venue may have it switched off (404).",
    inputSchema: {
      type: "object",
      properties: {
        token,
        account: { type: "integer", minimum: 0, description: "Ledger account id of the EARN account." },
        accountKey: { type: "string", description: "The venue record key (temporal_maker_state `id`); needed to patch an existing account." },
        asset: { type: "string", enum: ["BTC", "HYPE"] },
        patch: {
          type: "object",
          properties: {
            Eplus: { type: "number", minimum: 0, description: "Cap on net long exposure, coins." },
            Eminus: { type: "number", maximum: 0, description: "Cap on net short exposure, coins (negative or 0)." },
            hBps: { type: "number", minimum: 0, maximum: 150, description: "Half-spread, basis points." },
            preset: { type: "string", enum: ["track", "own"] },
          },
          additionalProperties: false,
        },
        raw: { type: "object", description: "Custom curves only: the grid body for /account/curve/raw (slices[]). Optional." },
        confirmed,
      },
      required: ["token"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (a, ctx) => {
      if (!a.patch && !a.raw) return makerRead(a, ctx);
      if (a.raw) return makerWrite(a, "/account/curve/raw", { id: a.accountKey ?? null, ...a.raw }, ctx);
      const body = a.accountKey != null ? { id: a.accountKey, patch: a.patch } : { id: null, patch: a.patch, ...(a.asset ? { asset: a.asset } : {}), ...(a.account != null ? { ledgerAccountId: a.account } : {}) };
      return makerWrite(a, "/account/curve", body, ctx);
    },
  },
  {
    name: "temporal_maker_asset",
    title: "Quote a second asset on a TLP / AUTO maker account",
    description:
      "For TLP and AUTO accounts: use to add BTC or HYPE to the markets one EARN account quotes, with that asset's own Eplus (net long cap, coins, 0 or more) and Eminus (net short cap, 0 or less), or to remove one (remove:true). " +
      "primary:true moves the account's own asset (refused while it has open legs). Needs the venue record key (temporal_maker_state `id`). Changes what the account's margin stands behind: describe it to the human; set confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        token,
        accountKey: { type: "string", description: "The venue record key (temporal_maker_state `id`)." },
        account: { type: "integer", minimum: 0, description: "Ledger account id (optional, resolves the record)." },
        asset: { type: "string", enum: ["BTC", "HYPE"] },
        Eplus: { type: "number", minimum: 0 },
        Eminus: { type: "number", maximum: 0 },
        remove: { type: "boolean" },
        primary: { type: "boolean" },
        confirmed,
      },
      required: ["token", "accountKey", "asset", "confirmed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (a, ctx) => makerWrite(a, "/account/asset", { id: a.accountKey, asset: a.asset, ...(a.Eplus != null ? { Eplus: a.Eplus } : {}), ...(a.Eminus != null ? { Eminus: a.Eminus } : {}), ...(a.remove ? { remove: true } : {}), ...(a.primary ? { primary: true } : {}), ...(a.account != null ? { ledgerAccountId: a.account } : {}) }, ctx),
  },
  {
    name: "temporal_maker_perp",
    title: "Read or set a maker account's covering perp",
    description:
      "Use when a maker's sold options leave it exposed and it wants a Hyperliquid perp to cover them (a long covers sold calls, a short sold puts), or to read what it has asked for. A TLP does this automatically; a CUSTOM maker opts in here and manages it itself. " +
      "Without `side` this reads the account's asks and covering perps. With `side` it sets the ask: long | short | off, size in coins (capped at the coins sold on that side; 'off' withdraws it). The venue places it on the keeper's next pass; it changes at most once per 15 minutes per account. " +
      "Refusals by name: below_min (smaller than the venue's minimum notional), deposit_short (the margin to reserve is not free), too_soon. The perp's margin is reserved from the account's deposit. Describe the change and wait for a yes; confirmed:true on a set.",
    inputSchema: {
      type: "object",
      properties: {
        token,
        account: { type: "integer", minimum: 0, description: "Ledger account id of the EARN account." },
        asset,
        side: { type: "string", enum: ["long", "short", "off"], description: "Omit to read." },
        size: { type: "number", minimum: 0, description: "Coins. 0 withdraws the ask." },
        confirmed,
      },
      required: ["token", "account"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (a, ctx) => {
      if (a.side == null) return api("GET", "/account/makerPerp", { query: { id: a.account }, token: a.token }, ctx);
      if (!a.asset) return refuse(400, "bad_arg", "asset is required to set a covering perp.");
      return makerWrite(a, "/account/makerPerp", { id: a.account, asset: a.asset, side: a.side, size: a.side === "off" ? 0 : a.size ?? 0 }, ctx);
    },
  },
  {
    name: "temporal_maker_rename",
    title: "Rename a maker account",
    description: "Use when a human asks to label an EARN account (up to 40 characters). Cosmetic; no money, no quoting change. Set confirmed:true after the human asked for the name.",
    inputSchema: { type: "object", properties: { token, accountKey: { type: "string", description: "The venue record key (temporal_maker_state `id`)." }, name: { type: "string", minLength: 1, maxLength: 40 }, confirmed }, required: ["token", "accountKey", "name", "confirmed"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (a, ctx) => makerWrite(a, "/account/rename", { id: a.accountKey, name: a.name }, ctx),
  },
  {
    name: "temporal_maker_register",
    title: "Register a custom maker's quoting bot with the venue",
    description:
      "ONLY for a CUSTOM maker that brings its own pricing (TLP needs no bot: use temporal_maker_quoting). Registers the bot that answers the venue's broadcast requests with signed firm quotes. " +
      "transport poll (default; the bot long-polls, no inbound port) or webhook (an https url the venue POSTs each request to). One EARN account per wallet. The wallet must own the account, or the bot's signing key must be set as the account's quote signer on chain (signer_not_set otherwise). " +
      "Re-registering replaces the connection. A reference bot: examples/custom-maker. Describe it to the human; set confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        token,
        account: { type: "integer", minimum: 0, description: "The ledger account id of the maker's single EARN account." },
        transport: { type: "string", enum: ["poll", "webhook"], default: "poll" },
        url: { type: "string", description: "webhook only: the https:// URL the venue POSTs each request to." },
        signer: { ...wallet, description: "Optional: the bot's quote-signing address when it is not the owner wallet." },
        confirmed,
      },
      required: ["token", "account", "confirmed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (a, ctx) => makerWrite(a, "/rfq/maker/register", { accounts: [String(a.account)], transport: a.transport ?? "poll", ...(a.url ? { url: a.url } : {}), ...(a.signer ? { signer: a.signer } : {}) }, ctx),
  },
  {
    name: "temporal_maker_unregister",
    title: "Remove a custom maker bot's registration",
    description: "Use when a custom maker's bot should stop being asked for quotes (a stop rule fired, or the maker is leaving). The id is from temporal_maker_connections. The account keeps its positions and margin: turn quoting off and close or exit separately. Set confirmed:true.",
    inputSchema: { type: "object", properties: { token, id: { type: "string", description: "The connection id from temporal_maker_connections." }, confirmed }, required: ["token", "id", "confirmed"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (a, ctx) => makerWrite(a, "/rfq/maker/unregister", { id: a.id }, ctx),
  },
];

export const INSTRUCTIONS = `Temporal (temporal.exchange) is a venue for perpetual options on BTC and HYPE, settled in USDC on Hyperliquid mainnet.
Two things agents use it for:
1) Protect: keep a leveraged Hyperliquid perp's exposure but push its liquidation price away, using attached non-expiring options whose premiums roughly offset. Start with temporal_protect_plan.
2) Options without expiry: buy or sell calls/puts that never expire; holders pay a continuous holding cost (funding for options) instead of rolling. Sellers can back a sold option with a perp instead of cash. Start with temporal_option_quote.
Yield: idle USDC or an existing perp can earn by making markets. TLP is THE DEFAULT way: one deposit, the venue quotes and manages for you (temporal_earn_plan, then temporal_maker_quoting with mode auto and tlp:true). Custom is only for a maker who brings its own pricing: it is the PORT a maker's existing setup plugs into (requests in, signed quotes out; account state and acts for its own risk and margin systems). The venue enforces only the hard limits: the price limit around the oracle, margin and liquidation, open-interest caps, and the maker's room. Maker settings need a venue session: temporal_session_prepare, the wallet signs, temporal_session_open; pass the token per call and never print it. Every maker write needs confirmed:true after the human said yes. Reference adapter: examples/custom-maker.
Access: Temporal is an open beta ($100 per wallet): any wallet outside the blocked countries can trade after accepting the terms once (one signature, no gas: POST /terms/accept; GET /launch/gate?wallet= returns the exact text to sign). Call temporal_access for the wallet first; if canTrade is false, tell the human what it says and do not try acts.
Flow for every act: read state (temporal_account_state) -> temporal_build_call -> temporal_dryrun -> state outcome and cost in plain words and wait for an explicit yes -> temporal_prepare_intent -> the human's wallet signs -> temporal_submit_intent (confirmed:true) -> temporal_fills to confirm.
Rules: the human's wallet signs every act; never ask for a private key. Named refusals change nothing: report them and do not retry with different numbers unless asked.
Beta limits: open beta, unaudited, $100 per wallet, BTC open, HYPE close-only, not offered in some countries. Full reference: https://protect.temporal.exchange/llms.txt`;
