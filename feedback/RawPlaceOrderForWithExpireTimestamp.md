# Raw placeOrderFor with expireTimestampNs = 0 reverts with OrderAlreadyExpired, and the developer page never says the expiry must be in the future
Severity: normal
Area: docs

## Steps to reproduce
1. Read "Perps on testnet for developers", section "Raw and operator calls". It shows the `placeOrderFor` signature and lists three traps (decimals scale, gas limit, IOC with no fill). It says nothing about `expireTimestampNs`.
2. Make sure the operator (bot) is approved for the owner on the pool: `client.isApprovedForPool({ pool, owner, operator, selector })` with selector `0x80054449` returns `true`.
3. Simulate (`eth_call`) from the operator against the ETH perp pool `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`:
   `placeOrderFor(owner, true, 0, 2385020000000000000000, 4000000000000000, 0, 2, 0, 0x0000000000000000000000000000000000000000, 0)`
   where `expireTimestampNs = 0`, `orderType = 2` (SDK `ORDER_TYPE.MARKET`) and `selfMatchingOption = 0` (SDK `SELF_MATCHING_OPTION.CANCEL_TAKER`).

## Expected
The page states which values are valid for `expireTimestampNs` (for example that it must be a future timestamp in nanoseconds), or that `0` means no expiry.

## Actual
The simulation reverts with the custom error selector `0x3154078e`, which matches `OrderAlreadyExpired()` among the custom errors in the SDK's ABI exports (selector computed as keccak256 of the signature, first 4 bytes). The revert gives no hint in the docs, and the SDK hides it because it fills in a future expiry itself. Anyone calling the pool directly, as the page suggests for bot keys, hits this.

## Evidence
- Simulation call arguments: owner `0xd706f3587a8360503878C7962cFD5279F96c07C3`, isBid `true`, userData `0`, price `2385020000000000000000`, quantity `4000000000000000`, expireTimestampNs `0`, orderType `2`, selfMatchingOption `0`, builder `0x0000000000000000000000000000000000000000`, builderFeeBpsTimes1k `0`, sender (operator) `0x5b76dc56eB97ff35c68D94D2208e032a8987fa01`.
- Result: `execution reverted`, revert selector `0x3154078e`.

## Environment
@somnia-chain/markets-sdk 0.32.1, Somnia Tokyo testnet (Hideki, chain ID 50383), owner wallet `0xd706f3587a8360503878C7962cFD5279F96c07C3`.