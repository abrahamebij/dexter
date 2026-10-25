import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  createWalletClient,
  formatUnits,
  getAddress,
  parseAbi,
  publicActions,
  webSocket,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { type PerpMarket, type SomniaMarketsClient, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk'
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains'

loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const RPC_URL = 'https://api.hideki2.infra.testnet.somnia.network'
const WS_RPC_URL = 'wss://api.hideki2.infra.testnet.somnia.network/ws'
const INDEXER_URL = 'https://hideki-dev.smk.somnia.host/v1/graphql'
const EXPLORER_URL = 'https://explorer.testnet.somnia.network/tokyo'
const PROOF_MODE = process.env.PROOF_MODE ?? 'read'
const SEND = process.env.SEND === 'true'
const GAS_LIMIT = 10_000_000n
const ORDER_TYPE_IOC = 2
const SELF_MATCHING_CANCEL_TAKER = 0

const delegatedOrderAbi = parseAbi([
  'function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)',
])

type ProofMarket = PerpMarket
type ProofClient = SomniaMarketsClient & {
  listPerpMarkets: (options?: { baseSymbol?: string; quoteSymbol?: string; limit?: number }) => Promise<PerpMarket[]>
}

async function loadClientFactory(): Promise<(config: unknown) => ProofClient> {
  const require = createRequire(import.meta.url)
  const packageEntry = require.resolve('@somnia-chain/markets-sdk')
  const moduleUrl = pathToFileURL(`${packageEntry.slice(0, packageEntry.lastIndexOf('\\'))}\\createClient.js`).href
  const module = await import(moduleUrl) as { createClient: (config: unknown) => ProofClient }
  return module.createClient as (config: unknown) => ProofClient
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function raw(value: string | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function formatRaw(value: bigint, decimals: number): string {
  return `${formatUnits(value < 0n ? -value : value, decimals)}${value < 0n ? ' (short)' : ''}`
}

function explorerLink(hash: Hex): string {
  return `${EXPLORER_URL}/tx/${hash}`
}

function alignDown(value: bigint, step: bigint): bigint {
  return (value / step) * step
}

function alignUp(value: bigint, step: bigint): bigint {
  return ((value + step - 1n) / step) * step
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function writeFeedback(error: unknown): Promise<string> {
  const path = `feedback/proof-${Date.now()}.md`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `# Perps proof run stopped\n\nSeverity: major\nArea: SDK\n\n## Steps to reproduce\n1. Run \`pnpm exec tsx server/scripts/proof.ts\` with the same environment variables.\n2. PROOF_MODE=${PROOF_MODE}\n3. SEND=${SEND}\n\n## Expected\nThe SDK read or delegated order simulation should complete without a revert.\n\n## Actual\n${errorText(error)}\n\n## Evidence\nNo transaction was sent by this run.\n\n## Environment\nSDK version: 0.32.1\nNetwork: Somnia Tokyo testnet (Hideki, chain 50383)\nWallet address: ${process.env.OWNER_ADDRESS ?? 'not supplied'}\n`,
    'utf8',
  )
  return path
}

async function logTransaction(entry: {
  market: string
  side: string
  quantity: bigint
  baseDecimals: number
  hash: Hex
}): Promise<void> {
  await mkdir('evidence', { recursive: true })
  await appendFile(
    'evidence/tx-log.md',
    `\n- Timestamp: ${new Date().toISOString()}\n  Market: ${entry.market}\n  Side: ${entry.side}\n  Quantity: ${formatUnits(entry.quantity, entry.baseDecimals)}\n  Tx hash: ${entry.hash}\n  Explorer: ${explorerLink(entry.hash)}\n`,
    'utf8',
  )
}

function printMarket(market: ProofMarket): void {
  console.log(JSON.stringify({
    symbol: `${market.baseSymbol ?? market.baseToken}/${market.quoteSymbol ?? market.quoteToken}`,
    baseDecimals: market.baseDecimals,
    quoteDecimals: market.quoteDecimals,
    tickSize: market.tickSize,
    lotSize: market.lotSize,
    minQuantity: market.minQuantity,
    poolAddress: market.poolAddress,
    marginBank: market.marginBank,
  }, null, 2))
}

async function main(): Promise<void> {
  if (!['read', 'open', 'close'].includes(PROOF_MODE)) {
    throw new Error(`PROOF_MODE must be read, open, or close; received ${PROOF_MODE}`)
  }

  const owner = getAddress(requiredEnv('OWNER_ADDRESS'))
  console.log(`OWNER_ADDRESS from server/.env: ${owner}`)
  const createClient = await loadClientFactory()
  const client = createClient({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  })

  console.log(`Read-only SDK client connected to chain ${hidekiTestnet.id}`)
  console.log('SDK methods used for market/system reads: client.listPerpMarkets(), client.getPerpSystemConfig(marginBank)')
  console.log('SDK call client.listPerpMarkets(): no owner/account address')
  const markets = (await client.listPerpMarkets()).filter((market): market is ProofMarket => market.marketType === 'PERP')
  if (markets.length === 0) throw new Error('SDK returned no perp markets')

  for (const market of markets) {
    printMarket(market)
    console.log(`SDK call client.getPerpSystemConfig(marginBank): marginBank=${market.marginBank}`)
    const config = await client.getPerpSystemConfig(market.marginBank)
    console.log('System config:', JSON.stringify(config, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
  }

  console.log('SDK methods used for account reads: client.listPerpPositions(owner), client.getPerpPosition({ marginBank, account, pool }), client.getMarginAccount(marginBank, owner), client.getLiquidationPrice({ marginBank, account, pool })')
  console.log(`SDK call client.listPerpPositions(owner): owner=${owner}`)
  const indexedPositions = await client.listPerpPositions(owner)
  const livePositions = []
  for (const market of markets) {
    console.log(`SDK call client.getPerpPosition({ marginBank, account, pool }): account=${owner}, marginBank=${market.marginBank}, pool=${market.poolAddress}`)
    const position = await client.getPerpPosition({ marginBank: market.marginBank, account: owner, pool: market.poolAddress })
    let liquidationPrice: bigint | null = null
    if (position.size !== 0n) {
      console.log(`SDK call client.getLiquidationPrice({ marginBank, account, pool }): account=${owner}, marginBank=${market.marginBank}, pool=${market.poolAddress}`)
      liquidationPrice = await client.getLiquidationPrice({ marginBank: market.marginBank, account: owner, pool: market.poolAddress })
    }
    console.log(`SDK call client.getMarginAccount(marginBank, account): account=${owner}, marginBank=${market.marginBank}`)
    const margin = await client.getMarginAccount(market.marginBank, owner)
    if (position.size !== 0n || indexedPositions.some((row) => row.pool.toLowerCase() === market.poolAddress.toLowerCase())) {
      const entry = {
        market: `${market.baseSymbol ?? market.baseToken}/${market.quoteSymbol ?? market.quoteToken}`,
        pool: market.poolAddress,
        size: position.size,
        side: position.size > 0n ? 'long' : position.size < 0n ? 'short' : 'flat',
        entryPrice: position.avgEntryPrice,
        margin: margin.equity,
        liquidationPrice,
      }
      livePositions.push({ market, position, liquidationPrice })
      console.log(JSON.stringify({
        ...entry,
        size: formatRaw(position.size, market.baseDecimals),
        entryPrice: formatUnits(position.avgEntryPrice, 18),
        margin: formatUnits(margin.equity, market.quoteDecimals),
        liquidationPrice: liquidationPrice === null ? null : formatUnits(liquidationPrice, 18),
      }, null, 2))
    }
  }
  console.log(`Indexer rows returned: ${indexedPositions.length}`)

  const configuredBotKey = requiredEnv('BOT_PRIVATE_KEY')
  const botKey = (configuredBotKey.startsWith('0x') ? configuredBotKey : `0x${configuredBotKey}`) as Hex
  const botAccount = privateKeyToAccount(botKey)
  console.log(`Bot address derived from BOT_PRIVATE_KEY: ${botAccount.address}`)
  console.log(`Owner and bot addresses are different: ${owner !== botAccount.address}; owner is OWNER_ADDRESS from server/.env: ${owner === getAddress(requiredEnv('OWNER_ADDRESS'))}`)

  if (PROOF_MODE === 'read') return

  const bot = createWalletClient({
    account: botAccount,
    chain: hidekiTestnet,
    transport: webSocket(WS_RPC_URL),
  }).extend(publicActions)
  console.log(`Bot signer address: ${botAccount.address}`)

  let market: ProofMarket
  let isBid: boolean
  let quantity: bigint
  const proofMarketSymbol = requiredEnv('PROOF_MARKET')

  if (PROOF_MODE === 'open') {
    const match = markets.find((candidate) => `${candidate.baseSymbol ?? candidate.baseToken}/${candidate.quoteSymbol ?? candidate.quoteToken}` === proofMarketSymbol || candidate.baseSymbol === proofMarketSymbol)
    if (!match) throw new Error(`PROOF_MARKET did not match a perp market: ${proofMarketSymbol}`)
    market = match
    isBid = (process.env.PROOF_SIDE ?? 'buy') === 'buy'
    const book = await client.getSpotOrderBook(market.poolAddress, { depth: 1 })
    const top = isBid ? book.asks[0] : book.bids[0]
    if (!top) throw new Error(`No opposing book liquidity for ${proofMarketSymbol}`)
    const tickSize = raw(market.tickSize)
    const topPrice = raw(top.price)
    const slippageBps = BigInt(process.env.PROOF_SLIPPAGE_BPS ?? '100')
    const crossedPrice = isBid ? alignUp(topPrice * (10_000n + slippageBps) / 10_000n, tickSize) : alignDown(topPrice * (10_000n - slippageBps) / 10_000n, tickSize)
    console.log(`SDK call client.getMaxPerpOrderSize({ pool, marginBank, account, isBid, price }): account=${owner}, marginBank=${market.marginBank}, pool=${market.poolAddress}`)
    const max = await client.getMaxPerpOrderSize({ pool: market.poolAddress, marginBank: market.marginBank, account: owner, isBid, price: crossedPrice })
    console.log('SDK method used for sizing: client.getMaxPerpOrderSize({ pool, marginBank, account, isBid, price })')
    console.log('Max order size:', JSON.stringify(max, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
    if (!max.priceable || !max.placeable || max.maxQuantity < raw(market.minQuantity)) throw new Error('Max order response is not placeable at the selected price')
    quantity = alignDown(raw(market.minQuantity), raw(market.lotSize))
    if (quantity === 0n || quantity > max.maxQuantity) throw new Error('Market minimum quantity is not placeable')
    await submitDelegatedOrder({ bot, market, owner, isBid, quantity, price: crossedPrice })
    return
  }

  const target = livePositions.find(({ market: candidate }) => `${candidate.baseSymbol ?? candidate.baseToken}/${candidate.quoteSymbol ?? candidate.quoteToken}` === proofMarketSymbol || candidate.baseSymbol === proofMarketSymbol)
  if (!target || target.position.size === 0n) throw new Error(`No open position found for PROOF_MARKET=${proofMarketSymbol}`)
  market = target.market
  isBid = target.position.size < 0n
  quantity = alignDown((target.position.size < 0n ? -target.position.size : target.position.size) / 2n, raw(market.lotSize))
  if (quantity < raw(market.minQuantity)) throw new Error('50% close is below the market minimum quantity')
  const book = await client.getSpotOrderBook(market.poolAddress, { depth: 1 })
  const top = isBid ? book.asks[0] : book.bids[0]
  if (!top) throw new Error(`No opposing book liquidity for ${proofMarketSymbol}`)
  const tickSize = raw(market.tickSize)
  const topPrice = raw(top.price)
  const slippageBps = BigInt(process.env.PROOF_SLIPPAGE_BPS ?? '100')
  const price = isBid ? alignUp(topPrice * (10_000n + slippageBps) / 10_000n, tickSize) : alignDown(topPrice * (10_000n - slippageBps) / 10_000n, tickSize)
  await submitDelegatedOrder({ bot, market, owner, isBid, quantity, price })
}

async function submitDelegatedOrder(args: {
  bot: ReturnType<typeof createWalletClient> & ReturnType<typeof publicActions>
  market: ProofMarket
  owner: Address
  isBid: boolean
  quantity: bigint
  price: bigint
}): Promise<void> {
  const request = {
    address: args.market.poolAddress,
    abi: delegatedOrderAbi,
    functionName: 'placeOrderFor' as const,
    args: [args.owner, args.isBid, 0n, args.price, args.quantity, 0n, ORDER_TYPE_IOC, SELF_MATCHING_CANCEL_TAKER, '0x0000000000000000000000000000000000000000' as Address, 0n] as const,
    gas: GAS_LIMIT,
    account: args.bot.account,
  }
  console.log('Delegated execution path: raw PerpPool placeOrderFor ABI; the SDK exposes no delegated perp order wrapper.')
  console.log('Simulation: eth_call via bot.simulateContract(request)')
  const simulation = await args.bot.simulateContract(request)
  console.log('Simulation result:', simulation.result ?? 'successful')
  if (!SEND) {
    console.log('SEND is not true; simulation only, no transaction sent.')
    return
  }
  const hash = await args.bot.writeContract(simulation.request)
  console.log(`Transaction hash: ${hash}`)
  console.log(`Explorer: ${explorerLink(hash)}`)
  await args.bot.waitForTransactionReceipt({ hash })
  await logTransaction({
    market: `${args.market.baseSymbol ?? args.market.baseToken}/${args.market.quoteSymbol ?? args.market.quoteToken}`,
    side: args.isBid ? 'buy/long' : 'sell/short',
    quantity: args.quantity,
    baseDecimals: args.market.baseDecimals,
    hash,
  })
}

main().catch(async (error: unknown) => {
  console.error('Proof stopped:', errorText(error))
  const feedbackPath = await writeFeedback(error)
  console.error(`Feedback written: ${feedbackPath}`)
  process.exitCode = 1
})
