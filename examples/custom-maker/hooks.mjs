// hooks.mjs: WHERE YOUR EXISTING SETUP PLUGS IN. Four functions, all empty by default: out of the box this adapter quotes nothing,
// stops nothing and moves no money. Temporal does not run your strategy and gives no advice about it; each hook is a seam to your own
// pricing surface, exposure limits, stop rules and margin system. The venue enforces only its hard limits (see README).
//
// A `request` is ONE option leg someone asked a price on (a Protect swap arrives as several legs that must ALL be priced, or none):
//   { id, asset: "BTC" | "HYPE", takerSide: "buy" | "sell", wing: "call" | "put", strikeUSD, months, qty, deadlineMs }
//   takerSide "buy"  = the asker buys, so you SELL at your ask; "sell" = the asker sells, so you BUY at your bid. Nothing names the asker.
// `state` is what the venue says about your account right now, read from GET /chain/state:
//   { account: { id, equityUSD, requirementUSD, cushion, ... }, legs, perps, raw }
//   (equityUSD / requirementUSD / cushion are the ledger's own margin numbers; cushion = equity / requirement, null with no requirement.)
// `acts` are the venue acts a hook may choose (each is signed by this adapter's key; money acts are DRY RUNS unless MAKER_LIVE=1):
//   acts.deposit(usd) · acts.withdraw(usd) · acts.makerPerp({ asset, side: "long" | "short" | "off", size }) · acts.quotingOff()
//   acts.exit()  (leave: your written options are handed to other makers at market)  · acts.closeAccount()  · acts.send(act, args) (any /chain/build act)

/** Your real-time pricing surface. Return USD PER COIN for this request, or null to give no quote. Called once per leg, inside the deadline. */
export async function price(request) {
  return null;
}

/** Your exposure limits. `book` = your current account state (see `state`). Return false to decline this request. */
export async function withinLimits(request, book) {
  return true;
}

/** Your stop rule, checked before every request and on the margin timer. Return false and the adapter stops answering, turns quoting off and exits. */
export async function shouldQuote(state) {
  return true;
}

/** Your margin management, called on a timer (MARGIN_EVERY_S, default 60). Top up, withdraw, set a covering perp, or leave: call `acts`. */
export async function manageMargin(state, acts) {}
