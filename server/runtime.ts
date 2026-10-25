import { createServer } from 'node:http'
import { decodeEventLog, createPublicClient, formatUnits, webSocket, type Abi, type Hex } from 'viem'
import { SDK as ReactivitySDK } from '@somnia-chain/reactivity'
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains'
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk'
import { DRY_RUN, INDEXER_URL, WS_RPC_URL, MARGIN_BANK, LIQUIDATION_ENGINE, OPERATOR_PERMISSIONS_REGISTRY, POLL_MS, marginAbi, liquidationAbi, readRetry, topic0, json, text, type Guard, type PerpMarket, type ProofClient } from './shared.js'
import { ensureData, loadClientFactory, marketName, guards, saveGuards, eventLog } from './storage.js'
import { ownerInDecoded, positionSnapshot, triggered, inCooldown } from './helpers.js'
import { executePartialClose } from './executor.js'
import { handleHttp } from './http.js'
export async function main(): Promise<void> {
  await ensureData()
  const createClient = await loadClientFactory()
  const client = createClient({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: { ...SOMNIA_HIDEKI_TESTNET_ADDRESSES, operatorPermissionsRegistry: OPERATOR_PERMISSIONS_REGISTRY },
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
      const triggerValues = guard.trigger.type === 'mark_price'
        ? { markPrice: mark.toString(), direction: guard.trigger.direction, targetPrice: guard.trigger.price, triggered: hit }
        : { markPrice: mark.toString(), liquidationPrice: liquidationNumber === null ? null : liquidationNumber.toString(), thresholdPct: guard.trigger.thresholdPct, triggered: hit }
      await eventLog({ timestamp: new Date().toISOString(), kind: 'trigger_hit', guardId: guard.id, owner: guard.owner, market: guard.market, reason, before, triggerValues, positionSizeBefore: position.size.toString(), dryRun: DRY_RUN })
      if (inFlight.has(guard.id)) return
      inFlight.add(guard.id)
      try {
        if (guard.action.type === 'notify_only') {
          await eventLog({ timestamp: new Date().toISOString(), kind: 'simulated', guardId: guard.id, owner: guard.owner, market: guard.market, reason: 'notify_only action; no transaction required', before, triggerValues, positionSizeBefore: position.size.toString(), computedCloseQuantity: null, priceUsed: null, expireTimestampNs: null, simulationResult: 'not_applicable', dryRun: DRY_RUN })
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
    await handleHttp(request, response, active, saveGuards, client, publicClient, perpMarkets, () => ({ connected, lastEventTime, dryRun: DRY_RUN }))
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
