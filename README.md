# Temporal MCP

MCP server for [Temporal](https://temporal.exchange): protect Hyperliquid perps from liquidation and trade perpetual (non-expiring) options on BTC and HYPE. Keyless: the server reads, plans, builds and dry-runs; your wallet signs every act.

## Connect

- Remote (no install): `https://protect.temporal.exchange/mcp` (Streamable HTTP)
- Local: `node mcp/src/server.mjs --stdio` (Node 20+, no dependencies)
- Official MCP Registry: `exchange.temporal/temporal`
- Server card: `https://protect.temporal.exchange/.well-known/mcp.json`
- Docs for agents: https://protect.temporal.exchange/llms.txt

## Tools

| Tool | Use when |
|---|---|
| `temporal_protect_plan` | Opening or holding a leveraged perp and liquidation risk matters |
| `temporal_option_quote` / `temporal_option_optimise` | You want a call or put with no expiry to manage |
| `temporal_earn_plan` | Idle USDC, or a perp to earn on, by making option markets |
| `temporal_session_*` / `temporal_maker_*` | Maker controls: sign in, quoting on/off, TLP settings, covering perp, custom bot register/unregister |
| `temporal_access` / `temporal_account_state` / `temporal_venue_status` / `temporal_fills` / `temporal_funding_info` | Reads |
| `temporal_build_call` → `temporal_dryrun` → `temporal_prepare_intent` → `temporal_submit_intent` | Acting: the venue builds the call, you see the outcome and cost, the human says yes, the wallet signs |

## Safety

- The server never holds or asks for a key.
- `temporal_submit_intent` refuses without `confirmed: true` (the human approved this exact act after a dry run).
- Named refusals pass through unchanged and are never retried.
- The call hash is recomputed locally and checked against the call.

## Makers

TLP is the default way to earn: one deposit, the venue quotes and manages for you. Custom is the port a maker's existing pricing, limits and margin systems plug into: `examples/custom-maker` is a reference client with four empty hooks (`price`, `withinLimits`, `shouldQuote`, `manageMargin`). Maker controls (session, quoting on/off, settings, covering perp, register/unregister, exit) are tools too: see `skills/temporal-earn`.

## Skills

`skills/temporal-protect` (traders) and `skills/temporal-earn` (market makers), in the AgentSkills `SKILL.md` format.

## Beta limits

Mainnet beta, unaudited, real money: $100 per wallet, accept the terms once (one signature), BTC open, HYPE close-only, not offered in some countries (including the US). Read the [risks](https://docs.temporal.exchange/docs/risks) first.

## Test

`cd mcp && npm test` (protocol tests against a mock venue).

## License

MIT
