# HTTP API

Sources: [HTTP overview](https://app.dreamdex.io/docs/developers/http-api/README.md),
[market data](https://app.dreamdex.io/docs/developers/http-api/market-data.md),
[trading](https://app.dreamdex.io/docs/developers/http-api/trading.md),
[authentication](https://app.dreamdex.io/docs/developers/http-api/authentication.md).

## Base URLs

| Environment | Chain ID | REST | Public WebSocket |
|---|---:|---|---|
| Mainnet | `5031` | `https://api.dreamdex.io/v0` | `wss://api.dreamdex.io/v0/ws/public` |
| Testnet | `50312` | `https://stg.api.dreamdex.io/v0` | `wss://stg.api.dreamdex.io/v0/ws/public` |

## Public endpoints

- `GET /markets` and `GET /currencies` are the runtime source of truth.
- `GET /orderbooks?symbols=SOMI:USDso&symbols=WETH:USDso` returns depth.
- `GET /markets/{symbol}/trades` returns market trades.
- `GET /markets/{symbol}/tickers` returns ticker data.
- `GET /markets/{symbol}/candles` returns OHLCV data.
- `GET /markets/{symbol}/volume` returns aggregate volume.

Unknown symbols in array parameters may be silently skipped, producing an empty result.

## Authentication

Private endpoints use Sign-In with Ethereum (ERC-4361):

1. `GET /auth/nonce`
2. Sign a SIWE message whose chain ID is `5031` or `50312`.
3. `POST /auth/login`
4. Send `Authorization: Bearer <jwt>`.

The JWT lifetime is one hour. There is no refresh endpoint; track `expiresAt` and repeat
nonce/sign/login before expiry.

## Order management

- `POST /markets/{symbol}/orders` prepares an unsigned order transaction.
- `GET /markets/{symbol}/orders/{id}` reads an order.
- `PATCH /markets/{symbol}/orders/{id}/reduce` reduces remaining quantity.
- `DELETE /markets/{symbol}/orders/{id}` prepares cancellation.
- `GET /markets/{symbol}/orders` lists market orders.
- `GET /orders` lists orders across markets.
- `GET /markets/{symbol}/trades/mine` and `GET /trades` read authenticated fills.

The client signs and broadcasts every transaction returned by the API. REST is therefore
an order-preparation and query layer, not a custodial execution service.

## Vault and builders

Vault flow: approve the pool, deposit tokens, then use `fundingSource: "vault"` when
preparing orders. Wallet funding is the default and pulls tokens at order placement.

Builder flow: read the protocol max fee, approve the builder, tag orders with `builder`,
then withdraw earned fees from the builder's pool/token vault balance. Builder fees are
denominated in `BPS_TIMES_1K` units and routed once for a multi-hop swap on leg zero.

## Error handling

Errors have stable machine-readable `name` values:

```json
{
  "status": 400,
  "name": "invalid_amount",
  "description": "human-readable debugging detail"
}
```

Common names include `missing_field`, `invalid_amount`, `invalid_price`,
`invalid_order_type`, `unauthorized`, `invalid_signature`, `market_not_found`,
`order_not_found`, `rpc_unavailable`, and `not_implemented`. Use `name` for program
logic; treat `description` as debugging text. The `Error-Name` header repeats the name.

