---
name: polymarket
description: Query Polymarket markets and place CLOB orders (with resumable approvals).
homepage: https://docs.polymarket.com/quickstart/overview
metadata: {"moltbot":{"emoji":"📈","requires":{"env":["POLYMARKET_PRIVATE_KEY"]}}}
---

# Polymarket

This skill enables the `polymarket` tool (Gamma + CLOB). It supports:

- **Read-only**: search markets, fetch market details, get orderbook depth.
- **Account state** (requires private key): collateral balance, conditional token balances ("positions"), open orders, order lookup.
- **Trading**: place limit orders via the CLOB API **with a required approval step**.

## Safety rules (must follow)

- Never paste or request a private key in chat.
- Never place an order immediately. Always call `polymarket` with `action: "place_order"` first to obtain a `resumeToken`, show a clear order summary, and only proceed after the user explicitly approves.
- Respect configured safety limits:
  - `tradeEnabled` must be true
  - `maxNotionalUsd` (approx \(price \times size\))
  - `allowedMarketSlugs` allowlist (if configured)

## Setup (admin)

1) Enable the plugin:

- `plugins.entries.polymarket.enabled = true`

2) Configure plugin safety defaults (recommended):

- `plugins.entries.polymarket.config.tradeEnabled = false` (default)
- `plugins.entries.polymarket.config.maxNotionalUsd = 25`
- Optionally set `plugins.entries.polymarket.config.allowedMarketSlugs = ["..."]`

3) Provide your trading private key **as an environment variable** in the Gateway process:

- `POLYMARKET_PRIVATE_KEY=0x...`

Then restart the gateway.

Docs: https://docs.polymarket.com/quickstart/first-order

## Typical workflow

### 0) Check account state (optional)

Collateral balance (USDC):

```json
{ "action": "balances" }
```

Positions (conditional token balances) for a market:

```json
{ "action": "positions", "marketSlug": "btc-updown-15m-1769655600" }
```

Open orders (all):

```json
{ "action": "open_orders" }
```

Open orders for a specific outcome in a market:

```json
{ "action": "open_orders", "marketSlug": "btc-updown-15m-1769655600", "outcome": "Up" }
```

Recent trades (fills) for a market:

```json
{ "action": "trades", "marketSlug": "btc-updown-15m-1769655600" }
```

Cancel an order (requires private key):

```json
{ "action": "cancel_order", "orderId": "..." }
```

Cancel all open orders (requires explicit confirmation):

```json
{ "action": "cancel_all", "confirm": true }
```

### 1) Find a market

Use Gamma public search:

```json
{ "action": "search", "query": "US election", "limit": 5 }
```

Or fetch a specific market:

```json
{ "action": "market", "marketSlug": "will-..." }
```

### 2) Inspect orderbook

```json
{ "action": "orderbook", "tokenId": "..." }
```

### 3) Prepare an order (requires approval)

```json
{
  "action": "place_order",
  "marketSlug": "will-...",
  "outcome": "Yes",
  "side": "buy",
  "price": 0.62,
  "size": 10
}
```

If the tool returns `status: "needs_approval"`, present the summary and ask for explicit approval.

### 4) Resume (approve or cancel)

```json
{ "action": "resume", "token": "<resumeToken>", "approve": true }
```

Or cancel:

```json
{ "action": "resume", "token": "<resumeToken>", "approve": false }
```

