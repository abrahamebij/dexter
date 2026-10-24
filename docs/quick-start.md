# Quick start

Source: <https://app.dreamdex.io/docs/welcome/quick-start.md>

## Environments

| Environment | Chain ID | REST base |
|---|---:|---|
| Somnia mainnet | `5031` | `https://api.dreamdex.io/v0` |
| Somnia Shannon testnet | `50312` | `https://stg.api.dreamdex.io/v0` |

The `/v0` path is required. Discover live markets first:

```bash
BASE_URL=https://api.dreamdex.io/v0
curl "$BASE_URL/markets"
curl "$BASE_URL/currencies"
curl "$BASE_URL/orderbooks?symbols=SOMI:USDso"
```

Use exact symbols such as `SOMI:USDso`; symbols are case-sensitive. Array query parameters
are repeated keys, not comma-separated values.

## Order lifecycle

1. Obtain a nonce with `GET /auth/nonce`.
2. Sign a SIWE message for the target chain.
3. Exchange the signed message with `POST /auth/login`.
4. Call `POST /markets/{symbol}/orders`.
5. Sign and broadcast the returned unsigned transaction using an EVM client.
6. Track the transaction receipt and order state using REST or the WebSocket order channel.

The API never takes custody of the signing key and does not broadcast for the client.
Taker IOC/FOK orders need a crossing limit price; a zero price does not cross the book.

## Direct contract path

Foundry `cast`, viem, ethers, or another EVM client can call the SpotPool contracts
directly. Resolve the current market contract from `/markets` or the contract-address
reference; do not hard-code a market discovered in an old example.

## Useful operational rules

- Treat timeouts, `5xx`, `rpc_unavailable`, and connection errors as retryable.
- Treat `4xx` validation errors as terminal.
- Use exponential backoff with jitter and cap in-flight requests.
- Before rebroadcasting a possibly-submitted transaction, check its receipt.
- Configure a primary and backup Somnia RPC.

