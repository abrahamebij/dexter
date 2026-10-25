import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config as loadEnv } from 'dotenv'
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  publicActions,
  toBytes,
  webSocket,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SDK as ReactivitySDK } from '@somnia-chain/reactivity'
import {
  marginBankEventsAbi,
  liquidationEngineEventsAbi,
  ORDER_TYPE,
  SELF_MATCHING_OPTION,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  type PerpMarket,
  type SomniaMarketsClient,
} from '@somnia-chain/markets-sdk'
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains'

loadEnv({ path: fileURLToPath(new URL('./.env', import.meta.url)) })

const WS_RPC_URL = 'wss://api.hideki2.infra.testnet.somnia.network/ws'
const INDEXER_URL = 'https://hideki-dev.smk.somnia.host/v1/graphql'
const MARGIN_BANK = '0x478769E1177C0773c43A593DCCc4Ad15F15F1394' as Address
const LIQUIDATION_ENGINE = '0xA66d3C24Ad4a389d863846905D8173e1017e9F4D' as Address
const GAS_LIMIT = 10_000_000n
const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))
const GUARDS_FILE = `${DATA_DIR}guards.json`
const EVENTS_FILE = `${DATA_DIR}events.json`
const DRY_RUN = process.env.DRY_RUN !== 'false'
const POLL_MS = 5_000
const delegatedOrderAbi = parseAbi([
  'function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)',
])

type Trigger =
  | { type: 'liquidation_distance_pct'; thresholdPct: number }
  | { type: 'mark_price'; direction: 'below' | 'above'; price: number }
type Action = { type: 'notify_only' } | { type: 'partial_close'; closePct: 25 | 50 | 75 | 100 }
type Guard = {
  id: string
  owner: Address
  market: string
  trigger: Trigger
  action: Action
  cooldownSeconds: number
  status: 'active' | 'paused' | 'fired'
  createdAt: string
  lastTriggeredAt: string | null
  source: string
}
type EventRecord = {
  timestamp: string
  kind: string
  owner?: Address
  guardId?: string
  market?: string
  reason?: string
  txHash?: Hex
  explorer?: string
  before?: PositionSnapshot
  after?: PositionSnapshot
}
type PositionSnapshot = { size: string; side: string; entryPrice: string; liquidationPrice: string | null }
type ProofClient = SomniaMarketsClient & {
  listPerpMarkets: (options?: { baseSymbol?: string; quoteSymbol?: string; limit?: number }) => Promise<PerpMarket[]>
}

const watchedNames = new Set([
  'PositionUpdated', 'FundingSettled', 'Deposited', 'DepositedFor', 'Withdrawn',
  'CollateralLocked', 'CollateralUnlocked', 'AutoDeleveraged', 'PositionTransferred',
  'LiquidationOrderPanicked', 'AccountLiquidated', 'PositionLiquidated',
  'PositionTakenOver', 'LiquidationThrottled',
])
const marginAbi = marginBankEventsAbi.filter((entry) => entry.type === 'event' && watchedNames.has(entry.name))
const liquidationAbi = liquidationEngineEventsAbi.filter((entry) => entry.type === 'event' && watchedNames.has(entry.name))

function text(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function retryable(error: unknown): boolean {
  const value = text(error).toLowerCase()
  if (/revert|validation|invalid|argument|unsupported|execution reverted/.test(value)) return false
  return /timeout|timed out|connection|econn|socket|network unavailable|temporarily unavailable|took too long to respond/.test(value)
}

async function readRetry<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const waits = [0, 2_000, 5_000]
  for (let attempt = 0; attempt < waits.length; attempt += 1) {
    if (waits[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, waits[attempt]))
    try {
      return await operation()
    } catch (error) {
      if (attempt === waits.length - 1 || !retryable(error)) throw error
      console.log(`Retrying ${name} after attempt ${attempt + 1}: ${text(error)}`)
    }
  }
  throw new Error(`Read retry loop exhausted: ${name}`)
}

function topic0(entry: { name: string; inputs: readonly { type: string }[] }): Hex {
  return keccak256(toBytes(`${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`))
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2)
}

async function ensureData(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  try {
    await readFile(GUARDS_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const owner = process.env.OWNER_ADDRESS
    const market = process.env.PROOF_MARKET
    if (!owner || !market) {
      await writeFile(GUARDS_FILE, '[]\n', 'utf8')
      return
    }
    const seed: Guard = {
      id: 'default-test-position',
      owner: getAddress(owner),
      market,
      trigger: { type: 'liquidation_distance_pct', thresholdPct: 10 },
      action: { type: 'notify_only' },
      cooldownSeconds: 300,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastTriggeredAt: null,
      source: 'Seeded from OWNER_ADDRESS and PROOF_MARKET in server/.env for the dry-run worker.',
    }
    await writeFile(GUARDS_FILE, `${JSON.stringify([seed], null, 2)}\n`, 'utf8')
    console.log(`Seeded one dry-run guard for ${seed.owner} on ${seed.market}`)
  }
  try {
    await readFile(EVENTS_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(EVENTS_FILE, '[]\n', 'utf8')
  }
}

async function guards(): Promise<Guard[]> {
  const parsed: unknown = JSON.parse(await readFile(GUARDS_FILE, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('server/data/guards.json must contain an array')
  return parsed as Guard[]
}

async function saveGuards(value: Guard[]): Promise<void> {
  await writeFile(GUARDS_FILE, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function eventLog(record: EventRecord): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(EVENTS_FILE, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('server/data/events.json must contain an array')
  parsed.push(record)
  await writeFile(EVENTS_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  console.log(`EVENT ${record.kind}: ${json(record)}`)
}

async function loadClientFactory(): Promise<(config: unknown) => ProofClient> {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@somnia-chain/markets-sdk')
  const path = `${entry.slice(0, entry.lastIndexOf('\\'))}\\createClient.js`
  const module = await import(pathToFileURL(path).href) as { createClient: (config: unknown) => ProofClient }
  return module.createClient
}

function marketName(market: PerpMarket): string {
  return `${market.baseSymbol ?? market.baseToken}/${market.quoteSymbol ?? market.quoteToken}`
}

function positionSnapshot(position: { size: bigint; avgEntryPrice: bigint }, liquidationPrice: bigint | null, market: PerpMarket): PositionSnapshot {
  return {
    size: position.size.toString(),
    side: position.size > 0n ? 'long' : position.size < 0n ? 'short' : 'flat',
    entryPrice: formatUnits(position.avgEntryPrice, 18),
    liquidationPrice: liquidationPrice === null ? null : formatUnits(liquidationPrice, 18),
  }
}

function ownerInDecoded(args: Record<string, unknown>): Address | null {
  for (const key of ['account', 'from', 'to', 'counterparty', 'bankrupt']) {
    const value = args[key]
    if (typeof value === 'string' && value.startsWith('0x')) return getAddress(value)
  }
  return null
}

function triggered(guard: Guard, mark: number, liquidation: number | null): boolean {
  if (guard.trigger.type === 'mark_price') {
    return guard.trigger.direction === 'below' ? mark <= guard.trigger.price : mark >= guard.trigger.price
  }
  if (liquidation === null || mark <= 0) return false
  return ((Math.abs(mark - liquidation) / mark) * 100) <= guard.trigger.thresholdPct
}

function inCooldown(guard: Guard): boolean {
  if (!guard.lastTriggeredAt) return false
  return Date.now() - Date.parse(guard.lastTriggeredAt) < guard.cooldownSeconds * 1_000
}

async function main(): Promise<void> {
  await ensureData()
  const createClient = await loadClientFactory()
  const client = createClient({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: { ...SOMNIA_HIDEKI_TESTNET_ADDRESSES },
  })
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: webSocket(WS_RPC_URL) })
  const reactivity = new ReactivitySDK({ public: publicClient })
  const active = () => guards().then((items) => items.filter((guard) => guard.status === 'active'))
  const markets = await readRetry('client.listPerpMarkets()', () => client.listPerpMarkets())
  const perpMarkets = markets.filter((market) => market.marketType === 'PERP')
  const byName = new Map<string, PerpMarket>()
  for (const market of perpMarkets) {
    byName.set(marketName(market), market)
    if (market.baseSymbol) byName.set(market.baseSymbol, market)
  }
  const allEvents = [...marginAbi, ...liquidationAbi]
  const topics = allEvents.map(topic0)
  const sources = [MARGIN_BANK, LIQUIDATION_ENGINE]
  console.log(`Reactivity SDK version: 0.2.1; viem: 2.57.11`)
  console.log(`Reactivity watch sources: ${sources.join(', ')}`)
  console.log(`Reactivity watch topics: ${topics.join(', ')}`)
  console.log(`Indexed owner topic filtering available: yes; not enabled because topicOverrides are global and guards can change dynamically.`)
  console.log(`DRY_RUN=${DRY_RUN}`)

  const eventAbiByTopic = new Map<string, Abi>()
  for (const entry of allEvents) eventAbiByTopic.set(topic0(entry).toLowerCase(), [entry] as Abi)
  let stopped = false
  let subscription: { unsubscribe: () => Promise<unknown> } | undefined
  let reconnectTimer: NodeJS.Timeout | undefined
  let reconnectDelay = 1_000
  let pollTimer: NodeJS.Timeout | undefined
  let connected = false
  let lastEventTime: string | null = null
  const inFlight = new Set<string>()

  async function evaluate(guard: Guard, reason: string): Promise<void> {
    const market = byName.get(guard.market)
    if (!market) {
      await eventLog({ timestamp: new Date().toISOString(), kind: 'evaluation_failed', guardId: guard.id, owner: guard.owner, market: guard.market, reason: 'Market not found in SDK list' })
      return
    }
    try {
      const position = await readRetry(`client.getPerpPosition(${market.poolAddress}, ${guard.owner})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress }))
      const margin = await readRetry(`client.getMarginAccount(${guard.owner})`, () => client.getMarginAccount(market.marginBank, guard.owner))
      const state = await readRetry(`client.getPerpState(${market.poolAddress})`, () => client.getPerpState(market.poolAddress))
      const feed = await readRetry(`client.getPerpFeedStatus(${market.poolAddress})`, () => client.getPerpFeedStatus(market.poolAddress))
      const liquidation = position.size === 0n ? null : await readRetry(`client.getLiquidationPrice(${market.poolAddress}, ${guard.owner})`, () => client.getLiquidationPrice({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress }))
      const mark = Number(formatUnits(state.markPrice, 18))
      const liquidationNumber = liquidation === null ? null : Number(formatUnits(liquidation, 18))
      const before = positionSnapshot(position, liquidation, market)
      const hit = triggered(guard, mark, liquidationNumber)
      console.log(`POLL/EVAL guard=${guard.id} owner=${guard.owner} market=${guard.market} reason=${reason} mark=${mark} feed=${json(feed)} margin=${json(margin)} triggered=${hit}`)
      if (!hit || inCooldown(guard)) return
      await eventLog({ timestamp: new Date().toISOString(), kind: 'trigger_hit', guardId: guard.id, owner: guard.owner, market: guard.market, reason, before })
      if (inFlight.has(guard.id)) return
      inFlight.add(guard.id)
      try {
        if (guard.action.type === 'notify_only') {
          await eventLog({ timestamp: new Date().toISOString(), kind: 'simulated', guardId: guard.id, owner: guard.owner, market: guard.market, reason: 'notify_only action; no transaction required', before })
          return
        }
        await executePartialClose(guard, market, position, before, client, publicClient, inFlight)
      } finally {
        inFlight.delete(guard.id)
      }
    } catch (error) {
      await eventLog({ timestamp: new Date().toISOString(), kind: 'evaluation_failed', guardId: guard.id, owner: guard.owner, market: guard.market, reason: text(error) })
    }
  }

  async function coldStart(reason: string): Promise<void> {
    const current = await active()
    console.log(`Cold start: ${reason}; active guards=${current.length}`)
    for (const guard of current) await evaluate(guard, reason)
  }

  async function subscribe(): Promise<void> {
    if (stopped) return
    const result = await reactivity.watch({
      ethCalls: [],
      eventContractSources: sources,
      topicOverrides: topics,
      onlyPushChanges: false,
      onData: async (notification: { params?: { result?: { topics: Hex[]; data: Hex; simulationResults: Hex[] } } }) => {
        const payload = notification.params?.result
        if (!payload) return
        const entry = eventAbiByTopic.get(payload.topics[0]?.toLowerCase())
        if (!entry) return
        const decoded = decodeEventLog({ abi: entry, data: payload.data, topics: payload.topics as [Hex, ...Hex[]] })
        const args = decoded.args as unknown as Record<string, unknown>
        const owner = ownerInDecoded(args)
        lastEventTime = new Date().toISOString()
        const current = await active()
        const relevant = current.filter((guard) => owner !== null && guard.owner.toLowerCase() === owner.toLowerCase())
        console.log(`DECODED event=${decoded.eventName} owner=${owner ?? 'none'} relevantGuards=${relevant.length} topics=${json(payload.topics)} args=${json(args)}`)
        for (const guard of relevant) await evaluate(guard, `event:${decoded.eventName}`)
      },
      onError: (error) => {
        console.error(`Reactivity watch error: ${text(error)}`)
        connected = false
        scheduleReconnect()
      },
    })
    if (result instanceof Error) throw result
    subscription = result
    connected = true
    reconnectDelay = 1_000
    console.log(`Reactivity subscription confirmed: ${result.subscriptionId}`)
    await coldStart('subscription connected')
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return
    const delay = reconnectDelay
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    console.log(`Reactivity reconnect scheduled in ${delay}ms`)
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = undefined
      try {
        await subscription?.unsubscribe()
        subscription = undefined
        await subscribe()
      } catch (error) {
        console.error(`Reactivity reconnect failed: ${text(error)}`)
        scheduleReconnect()
      }
    }, delay)
  }

  pollTimer = setInterval(async () => {
    try {
      const current = await active()
      for (const guard of current) await evaluate(guard, '5-second poll')
    } catch (error) {
      console.error(`Poll failed: ${text(error)}`)
    }
  }, POLL_MS)

  const server = createServer(async (request, response) => {
    await handleHttp(request, response, active, saveGuards, () => ({ connected, lastEventTime, dryRun: DRY_RUN }))
  })
  const port = Number(process.env.GUARDIAN_PORT ?? 8787)
  server.listen(port, () => console.log(`Guardian HTTP server listening on ${port}`))
  await subscribe()
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      stopped = true
      if (pollTimer) clearInterval(pollTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      await subscription?.unsubscribe()
      client.stopLive()
      const publicRpc = await publicClient.transport.getRpcClient?.()
      publicRpc?.close()
      server.close()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

async function executePartialClose(
  guard: Guard,
  market: PerpMarket,
  livePosition: { size: bigint; avgEntryPrice: bigint },
  before: PositionSnapshot,
  client: ProofClient,
  publicClient: ReturnType<typeof createPublicClient>,
  inFlight: Set<string>,
): Promise<void> {
  const configuredKey = process.env.BOT_PRIVATE_KEY
  if (!configuredKey) throw new Error('BOT_PRIVATE_KEY is required for partial_close')
  const botAccount = privateKeyToAccount((configuredKey.startsWith('0x') ? configuredKey : `0x${configuredKey}`) as Hex)
  const approved = await readRetry(`client.isApprovedForPool(${market.poolAddress})`, () => client.isApprovedForPool({
    pool: market.poolAddress,
    owner: guard.owner,
    operator: botAccount.address,
    selector: '0x80054449',
  }))
  if (!approved) throw new Error('Bot is not approved for owner and placeOrderFor selector')
  const current = await readRetry(`client.getPerpPosition(${market.poolAddress}, ${guard.owner})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress }))
  if (current.size === 0n) throw new Error('Cannot close a flat position')
  const quantity = (current.size < 0n ? -current.size : current.size) * BigInt(guard.action.type === 'partial_close' ? guard.action.closePct : 100) / 100n
  const lotSize = BigInt(market.lotSize)
  const minQuantity = BigInt(market.minQuantity)
  const closeQuantity = (quantity / lotSize) * lotSize
  if (closeQuantity < minQuantity || closeQuantity > (current.size < 0n ? -current.size : current.size)) throw new Error('Close size does not satisfy lot/minimum/live-position constraints')
  const isBid = current.size < 0n
  const book = await readRetry(`client.getSpotOrderBook(${market.poolAddress})`, () => client.getSpotOrderBook(market.poolAddress, { depth: 1 }))
  const level = isBid ? book.asks[0] : book.bids[0]
  if (!level) throw new Error('No opposing book liquidity')
  const tick = BigInt(market.tickSize)
  const slippage = BigInt(process.env.GUARDIAN_SLIPPAGE_BPS ?? '100')
  const rawPrice = BigInt(level.price)
  const price = isBid
    ? ((rawPrice * (10_000n + slippage) / 10_000n + tick - 1n) / tick) * tick
    : (rawPrice * (10_000n - slippage) / 10_000n / tick) * tick
  const max = await readRetry(`client.getMaxPerpOrderSize(${market.poolAddress})`, () => client.getMaxPerpOrderSize({ pool: market.poolAddress, marginBank: market.marginBank, account: guard.owner, isBid, price }))
  if (!max.priceable || !max.placeable || BigInt(max.maxQuantity) < closeQuantity) throw new Error(`Max order size rejected close: ${json(max)}`)
  const block = await readRetry('publicClient.getBlock()', () => publicClient.getBlock())
  const expiry = (block.timestamp + 50n * 365n * 24n * 3600n) * 1_000_000_000n
  const botTransport = webSocket(WS_RPC_URL)
  const bot = createWalletClient({ account: botAccount, chain: hidekiTestnet, transport: botTransport }).extend(publicActions)
  const request = {
    address: market.poolAddress,
    abi: delegatedOrderAbi,
    functionName: 'placeOrderFor' as const,
    args: [guard.owner, isBid, 0n, price, closeQuantity, expiry, ORDER_TYPE.MARKET, SELF_MATCHING_OPTION.CANCEL_TAKER, '0x0000000000000000000000000000000000000000' as Address, 0n] as const,
    gas: GAS_LIMIT,
    account: botAccount,
  }
  console.log(`Guard close args: ${json({ owner: guard.owner, isBid, quantity: closeQuantity, price, expiry, blockTimestamp: block.timestamp, orderType: ORDER_TYPE.MARKET, selfMatchingOption: SELF_MATCHING_OPTION.CANCEL_TAKER })}`)
  const simulation = await bot.simulateContract(request)
  await eventLog({ timestamp: new Date().toISOString(), kind: 'simulated', guardId: guard.id, owner: guard.owner, market: guard.market, reason: `DRY_RUN=${DRY_RUN}; simulation passed`, before })
  if (DRY_RUN) {
    const botRpc = await botTransport({ chain: hidekiTestnet }).value?.getRpcClient()
    botRpc?.close()
    return
  }
  const hash = await bot.writeContract(simulation.request)
  const receipt = await bot.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction receipt status was ${receipt.status}`)
  const afterPosition = await readRetry(`client.getPerpPosition(${market.poolAddress}, ${guard.owner})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress }))
  await eventLog({ timestamp: new Date().toISOString(), kind: 'confirmed', guardId: guard.id, owner: guard.owner, market: guard.market, txHash: hash, explorer: `https://explorer.testnet.somnia.network/tokyo (hash: ${hash})`, before, after: positionSnapshot(afterPosition, null, market) })
  const items = await guards()
  const found = items.find((item) => item.id === guard.id)
  if (found) {
    found.status = 'fired'
    found.lastTriggeredAt = new Date().toISOString()
    await saveGuards(items)
  }
  const botRpc = await botTransport({ chain: hidekiTestnet }).value?.getRpcClient()
  botRpc?.close()
  inFlight.delete(guard.id)
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  active: () => Promise<Guard[]>,
  saveGuards: (guards: Guard[]) => Promise<void>,
  health: () => { connected: boolean; lastEventTime: string | null; dryRun: boolean },
): Promise<void> {
  response.setHeader('content-type', 'application/json')
  const url = new URL(request.url ?? '/', 'http://localhost')
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      response.end(JSON.stringify(health()))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/guards') {
      const owner = url.searchParams.get('owner')
      const result = (await active()).filter((guard) => !owner || guard.owner.toLowerCase() === owner.toLowerCase())
      response.end(JSON.stringify(result))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      const owner = url.searchParams.get('owner')
      const records: EventRecord[] = JSON.parse(await readFile(EVENTS_FILE, 'utf8'))
      response.end(JSON.stringify(owner ? records.filter((record) => record.owner?.toLowerCase() === owner.toLowerCase()) : records))
      return
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/guards/')) {
      response.statusCode = 501
      response.end(JSON.stringify({ error: 'Wallet ownership verification is unavailable server-side; AuthShield only proves browser connection.' }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'Not found' }))
  } catch (error) {
    response.statusCode = 500
    response.end(JSON.stringify({ error: text(error) }))
  }
}

main().catch((error) => {
  console.error(`Guardian stopped: ${text(error)}`)
  process.exitCode = 1
})
