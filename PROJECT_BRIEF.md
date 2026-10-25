# Dexter project brief

**Status:** Active development  
**Updated:** 2026-10-25  
**Network:** Somnia Tokyo/Hideki testnet  
**Repository:** Vite + React frontend with a separate Node guardian worker

## 1. Product summary

Dexter is a safety-focused position guardian for dreamDEX perpetual positions. Users define a guard in plain language or through a manual rule builder. Dexter validates the rule, watches the owner’s live position, and can notify the user or partially close the position when the configured condition is met.

Dexter is not a general trading bot and does not implement stop-loss or take-profit orders. A partial-close action is the only automated trading action.

The worker defaults to `DRY_RUN=true`. In dry-run mode it performs the read and simulation stages and records what would happen, but never broadcasts a transaction.

## 2. Primary user flow

1. Connect a wallet in the frontend.
2. Enter the DreamDEX smart-wallet address that owns the perps account.
3. Compile a natural-language request with Gemini, or build a rule manually.
4. Review the validated rule, deterministic restatement, warnings, and assumptions.
5. Sign the Dexter authentication message with the connected wallet.
6. Save the guard.
7. Monitor positions, guard state, permissions, and activity in the dashboard.
8. Pause or resume the guard through an authenticated request.

The owner of a guard must be the checksummed DreamDEX wallet that holds the perps account, not necessarily the connected EOA signer. The server authenticates the request against that owner and stores the verified owner returned by the auth flow.

## 3. Supported rule model

Only the following rule shapes are valid:

```ts
trigger:
  | { type: "liquidation_distance_pct"; thresholdPct: number }
  | { type: "mark_price"; direction: "below" | "above"; price: number }

action:
  | { type: "notify_only" }
  | { type: "partial_close"; closePct: 25 | 50 | 75 | 100 }

cooldownSeconds: number
```

Each stored guard also contains:

- `id`
- `owner`
- `market`
- `status`: `active`, `paused`, or `fired`
- `createdAt`
- `lastTriggeredAt`
- `source`: manual or AI-generated
- the original source text when applicable

Unsupported or ambiguous requests fail safely. Dexter does not guess at unsupported actions or silently convert them into another rule.

## 4. System architecture

### Frontend

The Vite/React application in [`src/`](C:/Users/Abraham/Desktop/Projects/dexter/src) provides:

- Home and product explanation
- Dashboard and live positions
- New Guard creation
- Guard details and pause/resume controls
- Activity and simulation history
- Permissions and bot-link status
- Security and dry-run status

The UI uses the existing minimalist visual system: off-white background, charcoal text, and a restrained primary green. It uses live API data and empty states rather than mock data.

### Guardian worker

The long-running Node process in [`server/`](C:/Users/Abraham/Desktop/Projects/dexter/server) is responsible for:

- live SDK and RPC reads
- Reactivity event subscriptions
- five-second mark-price polling
- reconnects and cold starts
- guard evaluation
- approval checks
- transaction preparation and simulation
- optional transaction submission when dry run is disabled
- JSON storage and event logging
- the HTTP API on port `8787`

The worker is intentionally separate from the frontend because Reactivity requires a persistent WebSocket connection.

### Main server modules

- [`server/runtime.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/runtime.ts): startup, polling, subscriptions, reconnects, and evaluations
- [`server/executor.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/executor.ts): hardened partial-close sequence
- [`server/http.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/http.ts): API routes
- [`server/auth.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/auth.ts): nonce and wallet authentication
- [`server/compiler.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/compiler.ts): Gemini compilation, caching, and manual validation
- [`server/rules.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/rules.ts): rule schema validation and deterministic restatements
- [`server/storage.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/storage.ts): JSON persistence
- [`server/shared.ts`](C:/Users/Abraham/Desktop/Projects/dexter/server/shared.ts): shared types, ABIs, retry logic, and chain helpers

## 5. Monitoring and execution behavior

The worker subscribes through the Reactivity SDK to the configured MarginBank and LiquidationEngine events. Events are decoded with the SDK ABIs, filtered to owners with active guards, and followed by a fresh position read.

Because mark-price changes do not emit a suitable event, the worker also polls every five seconds. Reconnects use backoff, resubscribe to the event stream, and trigger a cold start that re-reads active guard positions.

For a partial close, the executor:

1. Checks `isApprovedForPool` for the guard owner, bot operator, market pool, and ABI-derived `placeOrderFor` selector.
2. Reads the live position.
3. Computes a lot-size-aligned close quantity bounded by the minimum quantity and live position.
4. Calls `getMaxPerpOrderSize`.
5. Builds a market `placeOrderFor` call using the current book, slippage, and an expiry derived from the latest block timestamp.
6. Simulates with `eth_call`.
7. Sends only when `DRY_RUN=false`.
8. Waits for the receipt and re-reads the position.

A failed read is not treated as an approval failure. Read-only calls use bounded retries for timeout and connection errors; sends are never retried.

## 6. Authentication and secrets

Mutating routes require an `x-dexter-auth` header containing the signed message, signature, and owner. The server issues single-use nonces valid for five minutes and verifies signatures on chain 50383, including smart-wallet verification where supported.

Secrets remain in `server/.env`:

- `BOT_PRIVATE_KEY`
- `GEMINI_API_KEY`
- optional `GEMINI_API_KEY_FALLBACK`
- Gemini model configuration

Secrets are never included in the client bundle or printed in logs.

## 7. HTTP API

The guardian exposes:

- `GET /api/health`
- `GET /api/markets`
- `GET /api/positions?owner=...`
- `GET /api/permissions?owner=...`
- `GET /api/guards?owner=...`
- `POST /api/auth/nonce?owner=...`
- `POST /api/guards/compile`
- `POST /api/guards/validate`
- `POST /api/guards`
- `PATCH /api/guards/:id`
- `GET /api/events?owner=...`

Compile results are cached only after successful validation. Cache entries are keyed by normalized input, the sorted live market list, and the rule schema version. Live warnings and assumptions are recomputed after a cache hit.

## 8. Persistence

Runtime JSON data is kept under [`server/data/`](C:/Users/Abraham/Desktop/Projects/dexter/server/data) and is gitignored:

- `guards.json`: saved guard definitions
- `events.json`: evaluations, simulations, failures, and confirmed transactions
- `compile-cache.json`: successful validated compiler results

Event records distinguish local evaluations and simulations from confirmed on-chain transactions. A transaction is considered real only when a transaction hash and receipt-confirmed event are present.

## 9. Chain integration

Dexter uses `@somnia-chain/markets-sdk` 0.32.1 and `@somnia-chain/reactivity` 0.2.1 against Somnia Tokyo/Hideki testnet:

- Chain ID: `50383`
- WebSocket RPC: `wss://api.hideki2.infra.testnet.somnia.network/ws`
- Indexer: `https://hideki-dev.smk.somnia.host/v1/graphql`
- Explorer: `https://explorer.testnet.somnia.network/tokyo`

Market pools, decimals, lot sizes, tick sizes, and related addresses are read from `client.listPerpMarkets()` at runtime. They must not be hardcoded.

## 10. Safety principles

- Dry run is enabled by default.
- No transaction is sent while dry run is enabled.
- No private key is exposed to the frontend.
- No order is prepared for a different owner or market than the guard specifies.
- Approval is checked immediately before execution.
- The close quantity cannot exceed the live position.
- Liquidation price is read from the SDK; Dexter does not calculate it with a local formula.
- Unknown, malformed, ambiguous, or unsupported rules are rejected.
- The worker records meaningful failures instead of silently falling back to success.

## 11. Current verified state

- The guardian starts on port `8787` with `DRY_RUN=true`.
- Reactivity subscription and cold-start behavior have been observed successfully.
- The bot address is derived from `BOT_PRIVATE_KEY`; the key itself is never logged.
- Approval checks return `true` for the known DreamDEX owner `0xd706f3587a8360503878C7962cFD5279F96c07C3` and the configured bot on the live pools.
- A stale guard saved with a different owner was removed.
- No active guard is currently seeded or fabricated.
- No transaction has been sent as part of the dry-run verification.

## 12. Development constraints

Before changing chain-facing behavior:

1. Read [`AGENTS.md`](C:/Users/Abraham/Desktop/Projects/dexter/AGENTS.md).
2. Reuse SDK types, ABIs, and runtime market data.
3. Do not invent contract values or protocol semantics.
4. Do not install packages without approval.
5. Do not commit or push unless explicitly requested.
6. Do not create feedback files unless a documented/API mismatch is actually observed and the task authorizes or requires it.
