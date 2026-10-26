# Dexter

**A position guardian for dreamDEX perps on Somnia Tokyo testnet.**

You describe a protection rule in plain English. Dexter turns it into a strictly validated rule, watches your position, and when the rule triggers it either notifies you or places a **partial close** from a bot key you have linked to your wallet. Every action leaves a transaction hash and a record you can check.

Built for the dreamDEX Perps Builder Bounty (MVP track, bots and agents category).

> Dexter does **not** place stop-loss or take-profit orders. A linked bot key cannot place reduce-only TP/SL on dreamDEX. A Dexter guard watches the position itself and sends a normal partial-close order when its condition is met.

## What it does

- **Plain-English guards.** "Close 25% of my ETH position if price drops below 2400." A Gemini model compiles the text into a fixed rule schema. The server validates it, restates it in plain English from a template (not from the model), and lists every value you did not state as an assumption before you confirm.
- **Manual rule builder.** The same rules can be built from a form. It uses the same validation, confirmation and signature flow, so Dexter works when the AI is unavailable.
- **Two triggers.** Liquidation distance (percent) and mark price (above or below a level).
- **Two actions.** Notify only, or partial close of 25, 50, 75 or 100 percent of the live position.
- **Reactivity plus polling.** Somnia Reactivity pushes position, margin, funding and liquidation events from MarginBank and LiquidationEngine, and Dexter re-evaluates immediately. Mark price changes emit no event, so mark price and liquidation distance are also checked every 5 seconds.
- **Live positions, bot permissions and an activity log** in the web app, all read from the chain through the dreamDEX SDK.

## Who it is for

Perps traders who want a risk rule they can say out loud, a bot that is limited to placing orders for their wallet, and a record of exactly what the bot did and why.

## How it works

```
Plain English or form  ->  rule schema  ->  server validation  ->  you confirm and sign
                                                                        |
Reactivity events (MarginBank, LiquidationEngine) + 5 second poll  ->  trigger check
                                                                        |
   approval check -> size to lot size -> max size check -> simulate -> send -> verify position
```

For a partial close the executor, in this order: checks the bot is approved for your wallet on that pool (`isApprovedForPool`), reads the live position, sizes the close to the market lot size and never above the position, checks the maximum order size, builds a bounded market order with a future expiry taken from the latest block time, simulates it with `eth_call`, and only then sends it.

## Safety model

- **Dry run by default.** The server simulates only, unless `DRY_RUN` is exactly `false`.
- **The bot key can only act for wallets that linked it** with Link a Bot in the dreamDEX app. It cannot withdraw funds.
- **The guard is claimed before anything is sent.** A failed send pauses the guard for manual review. A transaction with an unconfirmed receipt is never resent automatically. A restart pauses any guard that was mid-execution.
- **Secrets stay on the server.** The bot key and Gemini keys live only in `server/.env`. Nothing secret uses a `VITE_` prefix.
- **Signed ownership.** Creating or changing a guard needs a single-use nonce, a signature, and proof that the signer controls the guarded wallet. The server accepts the wallet itself, or any signer the dreamDEX SDK reports as having authority over that smart wallet. The bot's own address is rejected as an owner.
- **No fake data.** Empty states are empty. The activity log is an append-only file written through one queue.

## Run it

Requirements: Node 20.19+ (or 22.12+) and pnpm.

```bash
pnpm install
cp .env.example .env
cp server/.env.example server/.env
```

One-time dreamDEX setup (testnet, nothing real):

1. Open app.testnet.dreamdex.io, sign in, and join the Perps Arena.
2. Claim the 1,000 paper USDso, then move it to your **Perps account** with Perps ⇆ Spot. Perp orders only use margin that is already in the Perps account.
3. Create a **separate new key** for the bot. Put it in `server/.env` as `BOT_PRIVATE_KEY`. Fund its address with a little STT for gas. Never use your main wallet's key.
4. In the dreamDEX app, use **Link a Bot** to link the bot's address to your wallet.
5. Open a small long in a market the paper credit allows (for example ETH-PERP), so there is a position to guard.
6. Add a Gemini key as `GEMINI_API_KEY` in `server/.env` (optional if you only use the manual builder).

Start both processes:

```bash
pnpm guardian   # guardian server on port 8787
pnpm dev        # web app on port 5173
```

In the app, connect a wallet, enter your **DreamDEX wallet address** as the owner, and create a guard. It stays in simulation until you set `DRY_RUN=false` in `server/.env` and restart the guardian.

Useful checks:

```bash
pnpm typecheck:server
pnpm build
```

## Evidence

Real transactions sent by the guardian are listed in [`evidence/tx-log.md`](evidence/tx-log.md) with hashes and position changes. Simulations are shown on the Activity page and are not counted as transactions.

## Feedback

Issues found while building against the dreamDEX perps API and SDK are in [`feedback/`](feedback/), one file per issue, using [`feedback/TEMPLATE.md`](feedback/TEMPLATE.md).

## X posts

Posts about Dexter that tag @DreamDEXSomnia:

1. (add link)
2. (add link)
3. (add link)

## Limits

- Testnet only. Dexter has not been tested on mainnet.
- Somnia Agents are not live on Somnia Tokyo testnet, so the rule compiler uses an off-chain Gemini call.
- A guard with a partial-close action fires once and is then marked fired. Notify-only guards can repeat after their cooldown.
- Guards and logs are stored in local files under `server/data/`. This is a single-process demo, not a hosted service.
- Whether a signer controls a smart wallet is decided by the dreamDEX SDK's account authority read.

## Stack

React, Vite, Tailwind, wagmi and ConnectKit for the app. Node and TypeScript for the guardian. `@somnia-chain/markets-sdk` 0.32.1 and `@somnia-chain/reactivity` 0.2.1 for chain access.