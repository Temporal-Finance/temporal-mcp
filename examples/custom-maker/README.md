# Custom maker adapter (reference client)

**Custom is the port a maker's existing setup plugs into.** Temporal does not run your strategy. It gives a clean interface: requests in,
signed quotes out, and your account's state and acts for your own risk and margin systems. This folder is a small reference client for
that port. It is an adapter, not a bot to customise: the four hooks in `hooks.mjs` are where your pricing, limits, stop rules and margin
systems connect, and they are empty by default (the adapter quotes nothing until you fill `price`).

If you want to earn without bringing anything, use **TLP**: one deposit, the venue quotes and manages for you. Custom is only for a maker
who brings its own pricing.

## The port

Base: `https://protect.temporal.exchange/api/venue` (override with `VENUE_BASE`). Everything below is JSON.

**1. Session.** `POST /auth/nonce {address}` returns a message; sign it with `personal_sign` (EIP-191; it moves no funds);
`POST /auth/verify {address, signature}` returns a bearer `token`. Send `Authorization: Bearer <token>` on the maker routes. Agents using
the MCP tools get the same through `temporal_session_prepare` and `temporal_session_open`.

**2. Account.** A maker is an EARN account (one per wallet). Fund it and turn quoting on: `POST /account/quoting {on: true, mode: "custom",
ledgerAccountId}`. The wallet must own the account, or sign quotes with a key you set as the account's on-chain quote signer.

**3. Register.** `POST /rfq/maker/register {transport: "poll", accounts: ["<id>"]}` (long-poll, no inbound port) or
`{transport: "webhook", url: "https://…"}` (the venue POSTs each request). Re-registering replaces the connection. Refusals are named:
`one_earn_account`, `not_owner`, `signer_not_set`, `bad_url`, `bad_transport`, `no_accounts`.

**4. Requests in.** Poll: `POST /rfq/maker/poll {id, answers, waitMs}` returns `{requests: [...]}` at once or holds up to 20 s. A request:

```json
{ "id": "rfq_…", "asset": "0", "side": "0", "wing": "0", "strikeK": "90000000000000000000000",
  "months": "4000000000000000000", "qty": "100000000000000000", "deadlineMs": 1793000000500 }
```

`asset` 0 = BTC, 1 = HYPE. `side` is the ASKER's side: 0 = they buy (you sell at your ask), 1 = they sell. `wing` 0 call, 1 put. `strikeK` is a USD wad
(1e18). `months` is stored as a rate per year in wad (12 months = 1e18; months = 12 / (raw / 1e18)). `qty` is a coin wad. Integers are decimal strings. Nothing
names the asker. A Protect swap arrives as `{kind: "package", legs: [...]}`: answer EVERY leg with the same maker account, or answer `null`. There are no
ladders: each request is one instrument and one size.

**5. Quotes out.** One answer per request: `{quote, sig}`, a package `{quotes: [{leg, quote, sig}]}`, or `null` for no quote. The quote is EIP-712:

```
Quote(uint256 maker,uint256 taker,uint8 asset,uint8 side,uint8 wing,uint256 strikeK,uint256 months,uint256 qty,uint256 priceUSD,uint64 expiry,uint64 nonce)
domain { name: "TemporalQuote", version: "1", chainId, verifyingContract: <front address> }   (chainId and front: GET /chain/health)
```

`maker` = your account id; `taker` = 0; the cell fields echo the request; `qty` = the most you are firm for (at least the size asked; a fill is whole);
`priceUSD` = USD with 6 decimals, per coin; `expiry` = venue-clock seconds (firm until then); `nonce` = single use per account. Signature: 65 bytes r, s, v with low s.

**6. Deadline and offline rule.** Answer inside the window (default 500 ms; the request's `deadlineMs` is the clock). A late, malformed or badly signed answer is
simply not a candidate. A poll connection with no poll for 30 s is offline: it is not asked at all. The venue's clock offset is on `GET /health` (`clockOffsetMs`).

**7. Fills.** The best admitted price for the whole size wins the whole fill; ties go to the larger room, then the lower account id. You never trade with
yourself. Makers pay no trade fee.

**8. What the venue enforces (the hard limits, and only these).** Everything else is yours.
- The **price limit** around the oracle: an ask must sit in `[oracle bid, oracle ask + h]`, a bid in `[oracle bid - h, oracle ask]`, h = half the oracle's spread. Outside it, the quote can never fill.
- **Margin and liquidation** on the account's whole position, the ledger's own rule; **open-interest caps**; and your **room** (a quote must be covered by your free margin).
- **Signature, nonce and expiry** (firm for at least 2 s when it arrives; a nonce is used once).
- One Earn account per wallet; the beta's per-wallet caps and country list.
- Asker-side rate limits (unfilled requests per minute) protect the book; they do not apply to your answers.

**9. Your account.** `GET /chain/state?wallet=` returns equity, requirement and cushion per account, legs and perps. Acts: deposit, withdraw,
`exitMaker` (leave: your written options go to other makers at market, if the venue has exits on), `closeAccountAtFront`, `closeLegAtFront` through
`POST /chain/build` -> `/chain/dryrun` -> a wallet-signed `/chain/intent`; and `POST /account/makerPerp {id, asset, side: long|short|off, size}` for a covering perp
(refusals `below_min`, `deposit_short`, `too_soon`); `POST /account/quoting {on: false}` to stop.

## The adapter

`adapter.mjs` implements the port above and nothing else: session, registration, the poll and answer loop, quote signing, the deadline, reading
your account state and calling the acts. It hands your code four seams in `hooks.mjs`:

| Hook | Where your existing system connects |
|---|---|
| `price(request)` | Your real-time pricing surface. Return USD per coin, or `null` for no quote. |
| `withinLimits(request, book)` | Your exposure limits. Return `false` to decline. |
| `shouldQuote(state)` | Your stop rule. `false` stops answering, turns quoting off and exits cleanly. |
| `manageMargin(state, acts)` | Your margin system, on a timer: `acts.deposit`, `acts.withdraw`, `acts.makerPerp`, `acts.exit`, `acts.closeAccount`, `acts.send`. |

Money acts are dry runs unless you set `MAKER_LIVE=1`.

### Run

```sh
cd examples/custom-maker
npm install
export MAKER_KEY=0x…            # the account owner's key, or its quote-signer key (kept in this process, never printed)
export MAKER_ACCOUNT=123        # your ledger account id (an EARN account, quoting on, mode custom)
node selftest.mjs               # offline check against a mock venue
node adapter.mjs                # JSON log lines; Ctrl-C stops cleanly
```

Optional: `VENUE_BASE`, `EXPIRY_S` (quote life, default 10), `MARGIN_EVERY_S` (default 60), `MAKER_LIVE`.
Open beta, unaudited: start with small size and `MAKER_LIVE` off.
