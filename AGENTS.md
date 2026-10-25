Create or replace AGENTS.md in the repo root with exactly the content below, then stop and confirm. Do not touch any other file.

# Dexter: agent rules

## Product
Dexter is a position guardian for dreamDEX perps on Somnia Tokyo testnet. A guard is a rule (trigger + action) compiled from natural language, watched through Reactivity, and executed as a partial close through a linked bot key. Frontend: existing Vite + React app in src/ (pages: Home, HowItWorks, Dashboard, Positions, NewGuard, GuardDetails, Activity, Permissions, Security). Wallet connection and AuthShield are already set up, reuse them. Backend: a separate long-running Node server in server/ (a WebSocket subscriber cannot live in serverless functions).

## Standing rules
- Do NOT run npm/pnpm lint or build unless I explicitly say so.
- Do NOT install any package without asking first. When you need one, name it, say why, and wait.
- Do NOT invent blockchain values: chain IDs, RPC URLs, contract addresses, ABIs, function names, enum values, event names. Use only the constants below or values you read from @somnia-chain/markets-sdk (version 0.32.1) types, ABIs and docs/PERPS.md. If something is not there, stop and tell me.
- Do NOT redeploy or change contracts.
- Secrets (bot private key, Gemini API key) live only in server/.env. Never use a VITE_ prefix for a secret. Never log secrets.
- Never use mock or hardcoded data in the final app. Empty states are fine, fake data is not.
- Whenever the API, SDK or docs behave differently from what is documented, stop and write a file in feedback/ using the template in feedback/TEMPLATE.md (real evidence only: tx hash, request/response, wallet address, SDK version 0.32.1, network Somnia Tokyo testnet). Never put a security vulnerability in the repo.

## Verified constants (Somnia Tokyo testnet, Hideki chain) read more in docs/ folder
- Chain ID: 50383
- RPC: https://api.hideki2.infra.testnet.somnia.network
- WebSocket: wss://api.hideki2.infra.testnet.somnia.network/ws
- Indexer (GraphQL): https://hideki-dev.smk.somnia.host/v1/graphql
- Explorer: explorer.testnet.somnia.network/tokyo
- Gas coin: STT
- MarginBank: 0x478769E1177C0773c43A593DCCc4Ad15F15F1394
- Collateral (USDso): 0xed7993A74dAe1e6656B704A424DcD8711aAf4F72
- PerpPoolFactory: 0xE631fAEE547baeE07353E290f0562ea67d856560
- LiquidationEngine: 0xA66d3C24Ad4a389d863846905D8173e1017e9F4D
- InsuranceFund: 0x50826894D47C6D4f3BeA38BFDC7Dc5c5be171b80
- VoucherDistributor: 0x2ACD9EFdA721450906bfE1bef3edE269636E42C4
- OperatorPermissionsRegistry: 0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a
- SDK: @somnia-chain/markets-sdk 0.32.1. Connect with SomniaMarkets using chain hidekiTestnet (from "@somnia-chain/markets-sdk/chains"), the indexer URL above, and SOMNIA_HIDEKI_TESTNET_ADDRESSES.
- Per-market addresses (poolAddress, marginBank, stopRegistry) come from the market row returned by client.listPerpMarkets(). Never hardcode them. Run client.getPerpSystemConfig(marginBank) as a sanity check before trusting a market list.
- Known traps from the docs: prices have 18 decimals; quantity uses the market's own baseDecimals (read it, never assume 18); the perps collateral is NOT SOMNIA_HIDEKI_TESTNET_ADDRESSES.collateral (read quoteToken from the market row); the SDK reads the chain over WebSocket (an HTTP-only proxy fails with "genesis check failed"); send perp orders with a gas limit of 10,000,000; an IOC that fills nothing reverts with ImmediateOrCancelNoFill, so price IOCs through the book with slippage room; call getMaxPerpOrderSize before every order and respect priceable, placeable, maxQuantity and limitedBy.
- Delegated order call (raw): placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k). Take orderType and selfMatchingOption values from the SDK ABIs or docs/PERPS.md, never guess them.
- Session-key limits (confirmed by dreamDEX admins): the bot can place orders and partially close for the owner after the owner has deposited margin. Reduce-only TP/SL does NOT work with a session key.
- Reactivity is available on this chain. Somnia Agents are NOT live here, do not use them.