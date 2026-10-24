# dreamDEX developer notes

This folder contains a local, integration-oriented digest of the dreamDEX developer documentation.

- **Documentation checked:** 2026-10-24
- **Canonical source:** <https://docs.dreamdex.io/developers/>
- **Resolved source:** <https://app.dreamdex.io/docs/developers/>

## Files

- [quick-start.md](quick-start.md) - onboarding and the unsigned-transaction model
- [http-api.md](http-api.md) - REST environments, auth, market data, trading, vaults, and errors
- [websocket-api.md](websocket-api.md) - streaming subscriptions and request/response operations
- [contracts.md](contracts.md) - networks, deployed addresses, and contract integration notes
- [libraries.md](libraries.md) - CCXT and the Markets SDK
- [event-contracts.md](event-contracts.md) - event-contract integration via `@somnia-chain/markets-sdk`
- [source-map.md](source-map.md) - complete developer-section page map for follow-up reading

## Important integration model

dreamDEX is a fully on-chain order-book exchange on Somnia. The HTTP API prepares data and
unsigned transactions; the integrator signs and broadcasts those transactions through a
Somnia RPC endpoint. Public market data does not require authentication, while order
preparation and vault operations use SIWE/JWT authentication.

Always query markets and currencies at runtime. Symbols, contract addresses, tick sizes,
lot sizes, and supported assets can change.

