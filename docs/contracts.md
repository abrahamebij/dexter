# Contracts

Sources: [contracts overview](https://app.dreamdex.io/docs/developers/contracts/README.md),
[addresses](https://app.dreamdex.io/docs/developers/contracts/contract-addresses.md),
[functions](https://app.dreamdex.io/docs/developers/contracts/functions.md),
[events](https://app.dreamdex.io/docs/developers/contracts/events.md).

Each spot pair has a `SpotPool` order-book contract and a corresponding
`SpotStopOrderRegistry`. The `SpotRouter` composes pool legs for swaps.

## Mainnet: Somnia, chain ID `5031`

| Item | Address |
|---|---|
| USDso | `0x00000022dA000002656c64D9eA6011ea952D008A` |
| SOMI/USDso SpotPool | `0x035De7403eac6872787779CCA7CCF1b4CDb61379` |
| USDC.e/USDso SpotPool | `0x47fD2f18426f67106DBaC82F6d21D446c5F2120b` |
| WBTC/USDso SpotPool | `0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA` |
| WETH/USDso SpotPool | `0xa936da11B57b50A344e1293AAaE5232885ea2bDE` |
| SpotRouter | `0x780672aDA90Ed7cf2C3E8B70DBa87A19d584c8B0` |
| SpotPoolRegistry | `0xB601bc1099B040E4882089D94690F7C38AF4CCD2` |
| OperatorPermissionsRegistry | `0xE7a190736B6024a4DbafadC04E283075877005ce` |

## Testnet: Somnia Shannon, chain ID `50312`

| Item | Address |
|---|---|
| USDso | `0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171` |
| SOMI/USDso SpotPool | `0x259fD6559214dd5aD3752322426eA9F9fABEFff4` |
| WBTC/USDso SpotPool | `0x3605f28aA7C50e7441211e77Cb0762d49539326C` |
| WETH/USDso SpotPool | `0xD180195da5459C7a0DEA188ed61216ec43682b50` |
| SpotRouter | `0x0aA7c584074d2EA5B623772F97928baD23915ba8` |
| SpotPoolRegistry | `0x07A29A0A086Bc8262a9320db93E603eE13D57962` |
| OperatorPermissionsRegistry | `0x15C7e8CE38F021c5b45d098AaD788f63090bF20A` |

For stop-registry addresses and token decimals, use the canonical address page.

## Integration reminders

- Read types, function signatures, and event payloads from the linked reference before
  encoding calls.
- SpotPool supports placing, cancelling, reducing, querying, vault operations, and
  builder approvals.
- Stop registries handle stop-loss, take-profit, and stop-buy orders.
- The router is an orchestrator and does not custody funds between legs.
- Native SOMI vault reads use the documented `NATIVE_TOKEN` sentinel, not `address(0)`.

