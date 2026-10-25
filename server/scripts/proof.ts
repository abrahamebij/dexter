import { appendFile, mkdir } from 'node:fs/promises'
import {
  createWalletClient,
  formatUnits,
  getAddress,
  keccak256,
  parseEther,
  parseAbi,
  publicActions,
  toBytes,
  webSocket,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config as loadEnv } from 'dotenv'
import {
  contractErrorsAbi,
  ORDER_TYPE,
  SELF_MATCHING_OPTION,
  type PerpMarket,
  type SomniaMarketsClient,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
} from '@somnia-chain/markets-sdk'
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains'

loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const RPC_URL = 'https://api.hideki2.infra.testnet.somnia.network'
const WS_RPC_URL = 'wss://api.hideki2.infra.testnet.somnia.network/ws'
const INDEXER_URL = 'https://hideki-dev.smk.somnia.host/v1/graphql'
const EXPLORER_URL = 'https://explorer.testnet.somnia.network/tokyo'
const OPERATOR_PERMISSIONS_REGISTRY = '0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a' as Address
const PROOF_MODE = process.env.PROOF_MODE ?? 'read'
const SEND = process.env.SEND === 'true'
const GAS_LIMIT = 10_000_000n
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
  return `${EXPLORER_URL} (hash: ${hash})`
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

function isRetryableReadError(error: unknown): boolean {
  const text = errorText(error).toLowerCase()
  if (/revert|validation|invalid|argument|unsupported|not configured|execution reverted/.test(text)) return false
  return /timeout|timed out|connection|econn|socket|network unavailable|temporarily unavailable/.test(text)
}

async function retryRead<T>(callName: string, operation: () => Promise<T>): Promise<T> {
  const waits = [0, 2_000, 5_000]
  for (let attempt = 0; attempt < waits.length; attempt += 1) {
    if (waits[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, waits[attempt]))
    try {
      return await operation()
    } catch (error) {
      if (attempt === waits.length - 1 || !isRetryableReadError(error)) throw error
      console.log(`Retrying ${callName} after attempt ${attempt + 1}: ${errorText(error)}`)
    }
  }
  throw new Error(`Read retry loop exhausted: ${callName}`)
}

function errorSelector(name: string, inputs: readonly { type: string }[]): string {
  return keccak256(toBytes(`${name}(${inputs.map((input) => input.type).join(',')})`)).slice(0, 10)
}

function printErrorSelectorAudit(): void {
  const target = '0x3fb0ba2e'
  const matches = contractErrorsAbi
    .filter((entry) => errorSelector(entry.name, entry.inputs) === target)
    .map((entry) => `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`)
  const docsErrors = ['BuilderFeeExceedsApproval', 'NoOpenPosition', 'NothingToClaim', 'WithdrawalFailed']
    .map((name) => contractErrorsAbi.find((entry) => entry.name === name))
    .filter((entry): entry is (typeof contractErrorsAbi)[number] => entry !== undefined)
    .map((entry) => `${entry.name}(${entry.inputs.map((input) => input.type).join(',')}) = ${errorSelector(entry.name, entry.inputs)}`)
  console.log(`Custom errors checked in SDK ABI exports: ${contractErrorsAbi.length}`)
  console.log(`Custom errors listed in docs/PERPS.md checked: ${docsErrors.join('; ')}`)
  console.log(`Selector ${target} match: ${matches.length === 0 ? 'none' : matches.join('; ')}`)
}

async function logTransaction(entry: {
  market: string
  side: string
  quantity: bigint
  baseDecimals: number
  hash: Hex
  positionBefore: string
  positionAfter: string
}): Promise<void> {
  await mkdir('evidence', { recursive: true })
  await appendFile(
    'evidence/tx-log.md',
    `\n- Timestamp: ${new Date().toISOString()}\n  Market: ${entry.market}\n  Side: ${entry.side}\n  Quantity: ${formatUnits(entry.quantity, entry.baseDecimals)}\n  Position before: ${entry.positionBefore}\n  Position after: ${entry.positionAfter}\n  Tx hash: ${entry.hash}\n  Explorer: ${explorerLink(entry.hash)}\n`,
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
    addresses: {
      ...SOMNIA_HIDEKI_TESTNET_ADDRESSES,
      operatorPermissionsRegistry: OPERATOR_PERMISSIONS_REGISTRY,
    },
  })

  let botTransport: ReturnType<typeof webSocket> | undefined
  try {
    console.log(`Read-only SDK client connected to chain ${hidekiTestnet.id}`)
    printErrorSelectorAudit()
    console.log('SDK methods used for market/system reads: client.listPerpMarkets(), client.getPerpSystemConfig(marginBank)')
  console.log('SDK call client.listPerpMarkets(): no owner/account address')
  const markets = (await retryRead('client.listPerpMarkets()', () => client.listPerpMarkets())).filter((market): market is ProofMarket => market.marketType === 'PERP')
  if (markets.length === 0) throw new Error('SDK returned no perp markets')

  for (const market of markets) {
    printMarket(market)
    console.log(`SDK call client.getPerpSystemConfig(marginBank): marginBank=${market.marginBank}`)
    const config = await retryRead(`client.getPerpSystemConfig(${market.marginBank})`, () => client.getPerpSystemConfig(market.marginBank))
    console.log('System config:', JSON.stringify(config, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
  }

  console.log('SDK methods used for account reads: client.listPerpPositions(owner), client.getPerpPosition({ marginBank, account, pool }), client.getMarginAccount(marginBank, owner), client.getLiquidationPrice({ marginBank, account, pool })')
  console.log(`SDK call client.listPerpPositions(owner): owner=${owner}`)
  const indexedPositions = await retryRead(`client.listPerpPositions(${owner})`, () => client.listPerpPositions(owner))
  const livePositions = []
  for (const market of markets) {
    console.log(`SDK call client.getPerpPosition({ marginBank, account, pool }): account=${owner}, marginBank=${market.marginBank}, pool=${market.poolAddress}`)
    const position = await retryRead(`client.getPerpPosition(${market.poolAddress})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
    let liquidationPrice: bigint | null = null
    if (position.size !== 0n) {
      console.log(`SDK call client.getLiquidationPrice({ marginBank, account, pool }): account=${owner}, marginBank=${market.marginBank}, pool=${market.poolAddress}`)
      liquidationPrice = await retryRead(`client.getLiquidationPrice(${market.poolAddress})`, () => client.getLiquidationPrice({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
    }
    console.log(`SDK call client.getMarginAccount(marginBank, account): account=${owner}, marginBank=${market.marginBank}`)
    const margin = await retryRead(`client.getMarginAccount(${market.marginBank}, ${owner})`, () => client.getMarginAccount(market.marginBank, owner))
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
  const placeOrderForSelector = '0x80054449' as Hex
  console.log(`OperatorPermissionsRegistry from AGENTS.md: ${OPERATOR_PERMISSIONS_REGISTRY}`)
  for (const market of markets) {
    console.log(`SDK call client.isApprovedForPool({ pool, owner, operator, selector }): pool=${market.poolAddress}, owner=${owner}, operator=${botAccount.address}, selector=${placeOrderForSelector}`)
    const approved = await retryRead(`client.isApprovedForPool(${market.poolAddress})`, () => client.isApprovedForPool({
      pool: market.poolAddress,
      owner,
      operator: botAccount.address,
      selector: placeOrderForSelector,
    }))
    console.log(`Bot approved for owner on ${market.poolAddress}: ${approved}`)
  }

  botTransport = webSocket(WS_RPC_URL)
  const bot = createWalletClient({
    account: botAccount,
    chain: hidekiTestnet,
    transport: botTransport,
  }).extend(publicActions)
  console.log(`Bot signer address: ${botAccount.address}`)

  const proofMarketSymbol = requiredEnv('PROOF_MARKET')
  const market = markets.find((candidate) => `${candidate.baseSymbol ?? candidate.baseToken}/${candidate.quoteSymbol ?? candidate.quoteToken}` === proofMarketSymbol || candidate.baseSymbol === proofMarketSymbol)
  if (!market) throw new Error(`PROOF_MARKET did not match a perp market: ${proofMarketSymbol}`)
  const isBid = true
  const book = await retryRead(`client.getSpotOrderBook(${market.poolAddress})`, () => client.getSpotOrderBook(market.poolAddress, { depth: 1 }))
  const top = book.asks[0]
  if (!top) throw new Error(`No opposing book liquidity for ${proofMarketSymbol}`)
  const tickSize = raw(market.tickSize)
  const topPrice = raw(top.price)
  const slippageBps = BigInt(process.env.PROOF_SLIPPAGE_BPS ?? '100')
  const crossedPrice = alignUp(topPrice * (10_000n + slippageBps) / 10_000n, tickSize)
  const latestBlock = await retryRead('bot.getBlock()', () => bot.getBlock())
  const expiryTimestampNs = (latestBlock.timestamp + 50n * 365n * 24n * 3600n) * 1_000_000_000n
  console.log(`Latest RPC block timestamp: ${latestBlock.timestamp}`)
  console.log(`expireTimestampNs used: ${expiryTimestampNs}`)
  const balance = await retryRead(`bot.getBalance(${botAccount.address})`, () => bot.getBalance({ address: botAccount.address }))
  console.log(`Bot STT balance: ${formatUnits(balance, 18)} STT`)
  if (balance < parseEther('0.02')) throw new Error('Bot needs at least 0.02 STT for gas')
  console.log(`SDK call client.getMaxPerpOrderSize({ pool, marginBank, account, isBid, price }): account=${owner}, marginBank=${market.marginBank}, pool=${market.poolAddress}`)
  const max = await retryRead(`client.getMaxPerpOrderSize(${market.poolAddress})`, () => client.getMaxPerpOrderSize({ pool: market.poolAddress, marginBank: market.marginBank, account: owner, isBid, price: crossedPrice }))
  console.log('Owner max order size:', JSON.stringify(max, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
  if (!max.priceable || !max.placeable) throw new Error('Owner max order size is not placeable')
  console.log(`SDK ORDER_TYPE: ${JSON.stringify(ORDER_TYPE)}`)
  console.log(`SDK SELF_MATCHING_OPTION: ${JSON.stringify(SELF_MATCHING_OPTION)}`)
  console.log('Order type decision: use SDK ORDER_TYPE.MARKET=2, which is the IOC type. Evidence: SDK trade.ts documents 2 as ImmediateOrCancel/market, and its perp order parameter documents MARKET as slippage-bounded; SDK SPOT.md documents using the best opposite level plus slippage as the crossing price.')
  if (PROOF_MODE === 'read') return

  const minimum = raw(market.minQuantity)
  const lotSize = raw(market.lotSize)
  const quantity = alignUp(minimum * 4n, lotSize)
  if (quantity < minimum || quantity % lotSize !== 0n || (quantity / 2n) % lotSize !== 0n || quantity / 2n < minimum) {
    throw new Error('Computed open quantity does not satisfy the required lot/minimum constraints')
  }
  console.log(`Open quantity computation: alignUp(4 * minQuantity=${minimum}, lotSize=${lotSize}) = ${quantity}; baseDecimals=${market.baseDecimals}; quoteDecimals=${market.quoteDecimals}`)
  const beforeOpen = await retryRead(`client.getPerpPosition(${market.poolAddress})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
  console.log(`Position before open: size=${beforeOpen.size}, side=${beforeOpen.size > 0n ? 'long' : beforeOpen.size < 0n ? 'short' : 'flat'}, entryPrice=${formatUnits(beforeOpen.avgEntryPrice, 18)}`)
  if (beforeOpen.size !== 0n) throw new Error('Owner position is not flat before authorized open')
  const openResult = await submitDelegatedOrder({ bot, market, owner, isBid, quantity, price: crossedPrice, expiryTimestampNs, send: SEND })
  if (!SEND) return
  console.log(`Open tx hash: ${openResult.hash}; receipt status: ${openResult.status}`)
  const afterOpen = await retryRead(`client.getPerpPosition(${market.poolAddress})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
  const openLiquidation = await retryRead(`client.getLiquidationPrice(${market.poolAddress})`, () => client.getLiquidationPrice({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
  console.log(`Position after open: size=${afterOpen.size}, side=${afterOpen.size > 0n ? 'long' : afterOpen.size < 0n ? 'short' : 'flat'}, entryPrice=${formatUnits(afterOpen.avgEntryPrice, 18)}, liquidationPrice=${openLiquidation === null ? 'null' : formatUnits(openLiquidation, 18)}`)
  if (afterOpen.size !== quantity) throw new Error('Open position size did not equal the authorized quantity')

  const closeQuantity = alignDown(afterOpen.size / 2n, lotSize)
  if (closeQuantity < minimum || closeQuantity > afterOpen.size || closeQuantity % lotSize !== 0n) throw new Error('Computed close quantity violates the required constraints')
  const closeBook = await retryRead(`client.getSpotOrderBook(${market.poolAddress})`, () => client.getSpotOrderBook(market.poolAddress, { depth: 1 }))
  const closeTop = closeBook.bids[0]
  if (!closeTop) throw new Error('No opposing book liquidity for close')
  const closePrice = alignDown(raw(closeTop.price) * (10_000n - slippageBps) / 10_000n, tickSize)
  console.log(`Close quantity computation: alignDown(50% of live size=${afterOpen.size}, lotSize=${lotSize}) = ${closeQuantity}`)
  const closeResult = await submitDelegatedOrder({ bot, market, owner, isBid: false, quantity: closeQuantity, price: closePrice, expiryTimestampNs, send: true })
  console.log(`Close tx hash: ${closeResult.hash}; receipt status: ${closeResult.status}`)
  const afterClose = await retryRead(`client.getPerpPosition(${market.poolAddress})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
  console.log(`Position after close: size=${afterClose.size}, side=${afterClose.size > 0n ? 'long' : afterClose.size < 0n ? 'short' : 'flat'}, entryPrice=${formatUnits(afterClose.avgEntryPrice, 18)}`)
  if (afterClose.size !== afterOpen.size - closeQuantity) throw new Error('Close position size was unexpected')
  await logTransaction({ market: proofMarketSymbol, side: 'buy/long', quantity, baseDecimals: market.baseDecimals, hash: openResult.hash, positionBefore: beforeOpen.size.toString(), positionAfter: afterOpen.size.toString() })
  await logTransaction({ market: proofMarketSymbol, side: 'sell/short', quantity: closeQuantity, baseDecimals: market.baseDecimals, hash: closeResult.hash, positionBefore: afterOpen.size.toString(), positionAfter: afterClose.size.toString() })
  } finally {
    client.stopLive()
    if (botTransport) {
      const botRpcClient = await botTransport({ chain: hidekiTestnet }).value?.getRpcClient()
      botRpcClient?.close()
      console.log('Bot signer shutdown: WebSocket RPC client close()')
    }
    console.log('SDK client shutdown: client.stopLive()')
  }
}

async function submitDelegatedOrder(args: {
  bot: ReturnType<typeof createWalletClient> & ReturnType<typeof publicActions>
  market: ProofMarket
  owner: Address
  isBid: boolean
  quantity: bigint
  price: bigint
  expiryTimestampNs: bigint
  send: boolean
}): Promise<{ hash: Hex; status: string }> {
  const request = {
    address: args.market.poolAddress,
    abi: delegatedOrderAbi,
    functionName: 'placeOrderFor' as const,
    args: [args.owner, args.isBid, 0n, args.price, args.quantity, args.expiryTimestampNs, ORDER_TYPE.MARKET, SELF_MATCHING_OPTION.CANCEL_TAKER, '0x0000000000000000000000000000000000000000' as Address, 0n] as const,
    gas: GAS_LIMIT,
    account: args.bot.account,
  }
  console.log('Delegated execution path: raw PerpPool placeOrderFor ABI; the SDK exposes no delegated perp order wrapper.')
  console.log(`placeOrderFor args: owner=${args.owner}, isBid=${args.isBid}, userData=0, price=${args.price}, quantity=${args.quantity}, expireTimestampNs=${args.expiryTimestampNs}, orderType=${ORDER_TYPE.MARKET} (SDK ORDER_TYPE.MARKET), selfMatchingOption=${SELF_MATCHING_OPTION.CANCEL_TAKER} (SDK SELF_MATCHING_OPTION.CANCEL_TAKER), builder=0x0000000000000000000000000000000000000000, builderFeeBpsTimes1k=0`)
  console.log('Simulation: eth_call via bot.simulateContract(request)')
  const simulation = await args.bot.simulateContract(request)
  console.log('Simulation result:', simulation.result ?? 'successful')
  if (!args.send) return { hash: '0x' as Hex, status: 'simulation-only' }
  const hash = await args.bot.writeContract(simulation.request)
  console.log(`Transaction hash: ${hash}`)
  console.log(`Explorer: ${explorerLink(hash)}`)
  const receipt = await args.bot.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction receipt status was ${receipt.status}`)
  return { hash, status: receipt.status }
}

main().catch((error: unknown) => {
  console.error('Proof stopped:', errorText(error))
  process.exitCode = 1
})
