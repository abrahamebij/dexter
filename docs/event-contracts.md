# Event contracts and perps

## Event contracts

Source: <https://app.dreamdex.io/docs/developers/event-contracts/README.md>

Install:

```bash
npm install @somnia-chain/markets-sdk viem
```

The SDK can discover markets, stream books/fills/candles, place and cancel orders in
human units, mint/merge complete sets, and redeem winning positions. Gate writes on
live on-chain status, because the indexer can lag. Event-contract prices represent
Up probabilities in `(0, 1)`.

Important mechanics:

- Up and Down trade on one book; Down price is `1 - Up price`.
- Two opposite-side buyers can be matched by minting a fresh pair.
- Markets expire on schedule and successor markets appear automatically.
- Snapshot once, then use on-chain events or SDK watches; do not build a tight poll loop.

## Perps testnet

Source: <https://app.dreamdex.io/docs/developers/perps-testnet/README.md>

Perps run on Hideki testnet (chain ID `50383`), not the spot testnet:

| Service | Endpoint |
|---|---|
| RPC | `https://api.hideki2.infra.testnet.somnia.network` |
| WebSocket | `wss://api.hideki2.infra.testnet.somnia.network/ws` |
| Indexer | `https://hideki-dev.smk.somnia.host/v1/graphql` |
| Gas coin | `STT` |

Use the SDK's market row for `poolAddress`, `marginBank`, `stopRegistry`, and decimals.
Prices and quantities are raw units, with quantity scaled by each base asset's decimals.
Call `getMaxPerpOrderSize` before submitting and provide generous gas for complex
matching. Do not assume spot chain IDs or spot addresses apply to perps.

