# Libraries

Sources: [libraries overview](https://app.dreamdex.io/docs/developers/libraries/README.md),
[CCXT](https://app.dreamdex.io/docs/developers/libraries/ccxt.md).

## CCXT

The dreamDEX CCXT adapter is alpha and is installed from Somnia's branch:

```bash
npm install github:somnia-chain/ccxt#add-dreamdex-exchange
```

```ts
import ccxt from "ccxt";

const exchange = new ccxt.dreamdex({
  walletAddress: "0xYourAddress",
  privateKey: "0xYourPrivateKey",
});

const markets = await exchange.fetchMarkets();
const book = await exchange.fetchOrderBook("SOMI/USDC");
const order = await exchange.createOrder("SOMI/USDC", "limit", "buy", 100, 1.5);
```

`createOrder` returns an unsigned EVM transaction, not a confirmed order. Sign and
broadcast it yourself. CCXT Pro supports `watchOrderBook`, `watchTrades`, and
`watchOHLCV`. Vault helpers include `vaultApprove`, `vaultDeposit`, and `vaultWithdraw`.

## Markets SDK

Event contracts and testnet perps use `@somnia-chain/markets-sdk`. It provides typed
market discovery, order placement, order-book watches, settlement helpers, and raw
client/trader layers. See [event-contracts.md](event-contracts.md) for the event-contract
integration path.

