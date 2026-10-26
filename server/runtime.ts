import { createServer } from 'node:http'
import { decodeEventLog, createPublicClient, formatUnits, webSocket, type Abi, type Hex } from 'viem'
import { SDK as ReactivitySDK } from '@somnia-chain/reactivity'
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains'
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk'
import { DRY_RUN, INDEXER_URL, WS_RPC_URL, MARGIN_BANK, LIQUIDATION_ENGINE, OPERATOR_PERMISSIONS_REGISTRY, POLL_MS, marginAbi, liquidationAbi, readRetry, topic0, json, text, type Guard, type PerpMarket, type ProofClient } from './shared.js'
import { ensureData, loadClientFactory, marketName, guards, updateGuard, eventLog, closeStorage } from './storage.js'
import { ownerInDecoded, positionSnapshot, triggered, inCooldown } from './helpers.js'
import { executePartialClose, closeBot } from './executor.js'
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
  for (const stuck of (await guards()).filter((guard) => guard.status === 'executing')) {
    // The worker stopped mid-execution. Never resend automatically; the owner decides.
    await updateGuard(stuck.id, (item) => { item.status = 'paused' })
    await eventLog({ timestamp: new Date().toISOString(), kind: 'execution_interrupted', guardId: stuck.id, owner: stuck.owner, market: stuck.market, reason: 'Worker restarted while this guard was executing; paused for manual review. Check the position before resuming.' })
  }
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
  const cooldownUntil = new Map<string, number>()
  const flatNotified = new Set<string>()
  const lastFailure = new Map<string, { message: string; at: number }>()
  let connected = false
  let lastEventTime: string | null = null
  const inFlight = new Set<string>()

  // Log a failure once per distinct message, then at most every 5 minutes, instead of every poll.
  async function logFailure(guard: Guard, reason: string): Promise<void> {
    const previous = lastFailure.get(guard.id)
    if (previous && previous.message === reason && Date.now() - previous.at < 300_000) return
    lastFailure.set(guard.id, { message: reason, at: Date.now() })
    await eventLog({ timestamp: new Date().toISOString(), kind: 'evaluation_failed', guardId: guard.id, owner: guard.owner, market: guard.market, reason })
  }

  async function evaluate(guard: Guard, reason: string): Promise<void> {
    // One evaluation per guard at a time: overlapping polls and events cannot stack or double-fire.
    if (inFlight.has(guard.id)) return
    inFlight.add(guard.id)
    try {
      const market = byName.get(guard.market)
      if (!market) { await logFailure(guard, 'Market not found in SDK list'); return }
      const position = await readRetry(`client.getPerpPosition(${market.poolAddress}, ${guard.owner})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress }))
      if (position.size === 0n) {
        // Nothing to guard. Say so once, then wait quietly until a position appears.
        if (!flatNotified.has(guard.id)) {
          flatNotified.add(guard.id)
          await eventLog({ timestamp: new Date().toISOString(), kind: 'position_flat', guardId: guard.id, owner: guard.owner, market: guard.market, reason: 'No open position; waiting' })
        }
        lastFailure.delete(guard.id)
        return
      }
      flatNotified.delete(guard.id)
      if ((cooldownUntil.get(guard.id) ?? 0) > Date.now() || inCooldown(guard)) return
      const state = await readRetry(`client.getPerpState(${market.poolAddress})`, () => client.getPerpState(market.poolAddress))
      const liquidation = guard.trigger.type === 'liquidation_distance_pct'
        ? await readRetry(`client.getLiquidationPrice(${market.poolAddress}, ${guard.owner})`, () => client.getLiquidationPrice({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress }))
        : null
      lastFailure.delete(guard.id)
      const mark = Number(formatUnits(state.markPrice, 18))
      const liquidationNumber = liquidation === null ? null : Number(formatUnits(liquidation, 18))
      const before = positionSnapshot(position, liquidation, market)
      const hit = triggered(guard, mark, liquidationNumber)
      if (!hit) return
      // Cooldown applies in dry run too, otherwise a hit is logged every poll.
      cooldownUntil.set(guard.id, Date.now() + guard.cooldownSeconds * 1_000)
      const triggerValues = guard.trigger.type === 'mark_price'
        ? { markPrice: mark.toString(), direction: guard.trigger.direction, targetPrice: guard.trigger.price, triggered: hit }
        : { markPrice: mark.toString(), liquidationPrice: liquidationNumber === null ? null : liquidationNumber.toString(), thresholdPct: guard.trigger.thresholdPct, triggered: hit }
      await eventLog({ timestamp: new Date().toISOString(), kind: 'trigger_hit', guardId: guard.id, owner: guard.owner, market: guard.market, reason, before, triggerValues, positionSizeBefore: position.size.toString(), dryRun: DRY_RUN })
      if (guard.action.type === 'notify_only') {
        await updateGuard(guard.id, (item) => { item.lastTriggeredAt = new Date().toISOString() })
        await eventLog({ timestamp: new Date().toISOString(), kind: 'simulated', guardId: guard.id, owner: guard.owner, market: guard.market, reason: 'notify_only action; no transaction required', before, triggerValues, positionSizeBefore: position.size.toString(), computedCloseQuantity: null, priceUsed: null, expireTimestampNs: null, simulationResult: 'not_applicable', dryRun: DRY_RUN })
        return
      }
      await executePartialClose(guard, market, position, before, client, publicClient)
    } catch (error) {
      await logFailure(guard, text(error))
    } finally {
      inFlight.delete(guard.id)
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
        try {
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
        } catch (error) {
          console.error(`Reactivity event handling failed: ${text(error)}`)
        }
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

  // Self-scheduling loop: the next poll starts POLL_MS after the previous one FINISHES.
  async function pollLoop(): Promise<void> {
    if (stopped) return
    try {
      const current = await active()
      for (const guard of current) await evaluate(guard, '5-second poll')
    } catch (error) {
      console.error(`Poll failed: ${text(error)}`)
    }
    if (!stopped) pollTimer = setTimeout(pollLoop, POLL_MS)
  }
  pollTimer = setTimeout(pollLoop, POLL_MS)

  const server = createServer(async (request, response) => {
    await handleHttp(request, response, active, client, publicClient, perpMarkets, () => ({ connected, lastEventTime, dryRun: DRY_RUN }))
  })
  const port = Number(process.env.PORT ?? process.env.GUARDIAN_PORT ?? 8787)
  server.listen(port, () => console.log(`Guardian HTTP server listening on ${port}`))
  await subscribe()
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      stopped = true
      if (pollTimer) clearTimeout(pollTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      await subscription?.unsubscribe()
      client.stopLive()
      await closeBot()
      const publicRpc = await publicClient.transport.getRpcClient?.()
      publicRpc?.close()
      await closeStorage()
      server.close()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}