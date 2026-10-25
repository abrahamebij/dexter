import { createWalletClient, publicActions, webSocket, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains'
import { ORDER_TYPE, SELF_MATCHING_OPTION } from '@somnia-chain/markets-sdk'
import { DRY_RUN, GAS_LIMIT, WS_RPC_URL, delegatedOrderAbi, json, readRetry, type Guard, type PerpMarket, type PositionSnapshot, type ProofClient } from './shared.js'
import { eventLog, guards, saveGuards } from './storage.js'
import { positionSnapshot } from './helpers.js'
export async function executePartialClose(
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
  let simulation: Awaited<ReturnType<typeof bot.simulateContract>>
  try {
    simulation = await bot.simulateContract(request)
  } catch (error) {
    const simulationError = text(error)
    await eventLog({ timestamp: new Date().toISOString(), kind: 'simulation_failed', guardId: guard.id, owner: guard.owner, market: guard.market, reason: 'eth_call simulation reverted or failed', before, positionSizeBefore: current.size.toString(), computedCloseQuantity: closeQuantity.toString(), priceUsed: price.toString(), expireTimestampNs: expiry.toString(), simulationError, dryRun: DRY_RUN })
    throw error
  }
  await eventLog({ timestamp: new Date().toISOString(), kind: 'simulated', guardId: guard.id, owner: guard.owner, market: guard.market, reason: `DRY_RUN=${DRY_RUN}; simulation passed`, before, positionSizeBefore: current.size.toString(), computedCloseQuantity: closeQuantity.toString(), priceUsed: price.toString(), expireTimestampNs: expiry.toString(), simulationResult: 'success', dryRun: DRY_RUN })
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

