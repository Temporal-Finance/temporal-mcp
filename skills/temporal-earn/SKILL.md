---
name: temporal-earn
description: Use when holding idle USDC on Hyperliquid and looking for yield, when already holding a BTC perp and wanting extra income on it (covered-call style), or when building a market-making bot for options. Previews and runs Temporal's maker program, TLP (venue quotes for you) or Custom (your own RFQ quoting program).
license: MIT
metadata:
  homepage: https://temporal.exchange
  docs: https://protect.temporal.exchange/docs/earn
  tags: [hyperliquid, yield, market-making, options, lp, defi]
---

# Earning on Temporal (making option markets)

Makers answer traders' option requests with firm signed quotes. They earn **half the oracle venue's at-the-money spread** plus **holding cost on options they've written**, minus the venue's 10%, and pay **no trading fee**. Flow is anonymous: requests never name the trader.

## Pick a mode

- **TLP (passive).** One deposit, spread across the largest markets (min $10 each). The venue quotes for you at the oracle venue's bid/ask. Preview with `temporal_earn_plan` (`POST /earn/plan`).
- **Custom (your model).** Run a quoting program by webhook or long-poll. Use it if you already price options or run a funding/basis book.

## Why perp holders fit

If you already hold a long BTC perp (e.g. for funding or basis), selling calls on Temporal can be **covered by that perp**: long perp covers sold calls, short perp covers sold puts (`POST /account/makerPerp`, capped at coins sold on that side, one change per 15 minutes). You keep the perp's funding and add holding cost income.

## Custom maker loop (summary)

1. Sign `connect`, `mintAccount` (kind 3, EARN), `deposit` via `POST /chain/intent`.
2. Session: `POST /auth/nonce {address}` → sign → `POST /auth/verify` → bearer token.
3. `POST /account/asset {id, asset, primary:true}` (only while not quoting, no position).
4. `POST /rfq/maker/register {transport:"poll"|"webhook", url?, accounts, signer?}`.
5. `POST /account/quoting {id, on:true, mode:"custom"}` (or `mode:"auto"`).
6. Loop `POST /rfq/maker/poll {id, answers, waitMs}`. Each request: `{id, asset, side, wing, strikeK, months, qty, deadlineMs}`. Answer within ~500 ms with an EIP-712 `Quote` (domain `TemporalQuote` v1, front contract) or `null`. Quote `qty` covers the full size, `expiry` at least 2 s ahead, `nonce` single-use. Protect packages: answer every leg or none.
7. Silence for 30 s marks you offline. Stop: `quoting on:false`, then `/rfq/maker/unregister`.

An LLM should not sit in the 500 ms quote path. Use the model to set parameters (spread, caps, covering perp), and let a deterministic bot quote.

## Risks to state before depositing

Option P/L can be negative, and the displayed Return excludes it. Sold options are margined; below maintenance plus a 3% penalty you're liquidated. There's no breaker for crossed quotes. Closes return to the maker who wrote the position. Caps limit size, not loss. Open beta: unaudited, $100 per wallet.
