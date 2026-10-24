# WebSocket API

Sources: [overview](https://app.dreamdex.io/docs/developers/websocket-api/README.md),
[real-time feed](https://app.dreamdex.io/docs/developers/websocket-api/real-time-feed.md),
[operations](https://app.dreamdex.io/docs/developers/websocket-api/operations.md).

Public feed URLs:

- Mainnet: `wss://api.dreamdex.io/v0/ws/public`
- Testnet: `wss://stg.api.dreamdex.io/v0/ws/public`

## Operations

Messages are JSON objects. `id` is client-supplied and responses may arrive out of order.

```json
{
  "id": 1,
  "operation": "getMarkets",
  "params": {},
  "bearerToken": "optional-jwt",
  "payload": {}
}
```

Responses echo the ID and include an HTTP-like status:

```json
{"id": 1, "status": 200, "payload": {}}
```

The WebSocket can invoke HTTP operations such as `getMarkets`, `prepareOrder`, and
authenticated order queries without opening separate connections.

## Subscriptions

```json
{"operation":"subscribe","channel":"orderbook","params":{"symbols":["SOMI:USDso"]}}
{"operation":"subscribe","channel":"trades","params":{"symbols":["SOMI:USDso"]}}
{"operation":"subscribe","channel":"order","params":{"symbol":"SOMI:USDso","orderId":"0x..."}}
```

The server sends an initial snapshot followed by deltas. The public feed is market-wide
and does not attribute fills to an account. Track a specific resting order with its
per-order `order` channel; there is no account-wide fills channel.

## Heartbeat and recovery

Send `{"operation":"ping"}` and expect `{"operation":"pong"}`. Connections close after
60 seconds of inactivity. On reconnect, resubscribe and reconcile open orders and
balances over REST because missed messages cannot be replayed.

Protocol errors use `type: "error"` and machine-readable names such as
`unknown_operation`, `invalid_request`, `invalid_parameters`, `too_many_requests`, and
`internal_error`.

