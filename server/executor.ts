import { createPublicClient, createWalletClient, publicActions, webSocket, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains'
import { ORDER_TYPE, SELF_MATCHING_OPTION } from '@somnia-chain/markets-sdk'
import { DRY_RUN, GAS_LIMIT, WS_RPC_URL, delegatedOrderAbi, json, placeOrderForSelector, readRetry, text, type Guard, type PerpMarket, type PositionSnapshot, type ProofClient } from './shared.js'
import { eventLog, updateGuard } from './storage.js'
import { positionSnapshot } from './helpers.js'
type BotClient = ReturnType<typeof makeBot>
let botClient: BotClient | undefined
function makeBot(account: ReturnType<typeof privateKeyToAccount>) {
  return createWalletClient({ account, chain: hidekiTestnet, transport: webSocket(WS_RPC_URL) }).extend(publicActions)
}
// One long-lived WebSocket for the bot, reused by every attempt (previously one socket was opened per attempt and leaked on failure).
function getBot(account: ReturnType<typeof privateKeyToAccount>): BotClient {
  botClient ??= makeBot(account)
  return botClient
}
export async function closeBot(): Promise<void> {
  const current = botClient
  botClient = undefined
  if (!current) return
  try { const rpc = await (current.transport as { getRpcClient?: () => Promise<{ close: () => void }> }).getRpcClient?.(); rpc?.close() } catch {}
}
const RECEIPT_TIMEOUT_MS = 60_000

export async function executePartialClose(
  guard: Guard,
  market: PerpMarket,
  livePosition: { size: bigint; avgEntryPrice: bigint },
  before: PositionSnapshot,
  client: ProofClient,
  publicClient: ReturnType<typeof createPublicClient>,
): Promise<void> {
  const configuredKey = process.env.BOT_PRIVATE_KEY
  if (!configuredKey) throw new Error('BOT_PRIVATE_KEY is required for partial_close')
  const botAccount = privateKeyToAccount((configuredKey.startsWith('0x') ? configuredKey : `0x${configuredKey}`) as Hex)
  const approvalArgs = {
    pool: market.poolAddress,
    owner: guard.owner,
    operator: botAccount.address,
    selector: placeOrderForSelector,
  } as const
  console.log(`Approval check: ${json({ storedGuardOwner: guard.owner, owner: approvalArgs.owner, operator: approvalArgs.operator, pool: approvalArgs.pool, selector: approvalArgs.selector })}`)
  const approved = await readRetry(`client.isApprovedForPool(${approvalArgs.pool})`, () => client.isApprovedForPool(approvalArgs))
  console.log(`Approval result: ${json({ owner: approvalArgs.owner, operator: approvalArgs.operator, pool: approvalArgs.pool, selector: approvalArgs.selector, rawReturnValue: approved })}`)
  if (approved !== true) throw new Error('Bot approval read returned false for the requested owner, pool and placeOrderFor selector')
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
  const bot = getBot(botAccount)
  const request = {
    address: market.poolAddress,
    abi: delegatedOrderAbi,
    functionName: 'placeOrderFor' as const,
    args: [guard.owner, isBid, 0n, price, closeQuantity, expiry, ORDER_TYPE.MARKET, SELF_MATCHING_OPTION.CANCEL_TAKER, '0x0000000000000000000000000000000000000000' as Address, 0n] as const,
    gas: GAS_LIMIT,
    account: botAccount,
  }
  console.log(`Guard close args: ${json({ owner: guard.owner, isBid, quantity: closeQuantity, price, expiry, blockTimestamp: block.timestamp, orderType: ORDER_TYPE.MARKET, selfMatchingOption: SELF_MATCHING_OPTION.CANCEL_TAKER })}`)
  let simulation: any
  try {
    simulation = await bot.simulateContract(request)
  } catch (error) {
    const simulationError = text(error)
    await eventLog({ timestamp: new Date().toISOString(), kind: 'simulation_failed', guardId: guard.id, owner: guard.owner, market: guard.market, reason: 'eth_call simulation reverted or failed', before, positionSizeBefore: current.size.toString(), computedCloseQuantity: closeQuantity.toString(), priceUsed: price.toString(), expireTimestampNs: expiry.toString(), simulationError, dryRun: DRY_RUN })
    throw error
  }
  await eventLog({ timestamp: new Date().toISOString(), kind: 'simulated', guardId: guard.id, owner: guard.owner, market: guard.market, reason: `DRY_RUN=${DRY_RUN}; simulation passed`, before, positionSizeBefore: current.size.toString(), computedCloseQuantity: closeQuantity.toString(), priceUsed: price.toString(), expireTimestampNs: expiry.toString(), simulationResult: 'success', dryRun: DRY_RUN })
  if (DRY_RUN) return

  // Claim the guard BEFORE broadcasting. A guard that is 'executing' is not returned by active(),
  // so no poll or event can send a second close while this one is in flight or unconfirmed.
  const claimed = await updateGuard(guard.id, (item) => {
    if (item.status === 'active') { item.status = 'executing'; item.lastTriggeredAt = new Date().toISOString() }
  })
  if (!claimed || claimed.status !== 'executing') throw new Error('Guard was paused or already executing; no order sent')

  let hash: Hex
  try {
    hash = await bot.writeContract(simulation.request)
  } catch (error) {
    // A failed send may or may not have reached the network, so never auto-resume. The owner must review and resume.
    await updateGuard(guard.id, (item) => { item.status = 'paused' })
    await eventLog({ timestamp: new Date().toISOString(), kind: 'send_failed', guardId: guard.id, owner: guard.owner, market: guard.market, reason: `Send failed; guard paused for manual review: ${text(error)}`, before, dryRun: false })
    throw error
  }
  // Hash exists, so the order is on the network. Mark fired now, before waiting for the receipt.
  await updateGuard(guard.id, (item) => { item.status = 'fired' })
  await eventLog({ timestamp: new Date().toISOString(), kind: 'submitted', guardId: guard.id, owner: guard.owner, market: guard.market, txHash: hash, reason: 'Transaction broadcast; waiting for receipt', before, dryRun: false })
  try {
    const receipt = await bot.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
    if (receipt.status !== 'success') {
      await eventLog({ timestamp: new Date().toISOString(), kind: 'reverted', guardId: guard.id, owner: guard.owner, market: guard.market, txHash: hash, reason: `Transaction receipt status was ${receipt.status}`, before, dryRun: false })
      return
    }
  } catch (error) {
    // Do not resend. Record it and re-read the live position to see what actually happened.
    const reread = await readRetry(`client.getPerpPosition(${market.poolAddress}, ${guard.owner})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress })).catch(() => null)
    await eventLog({ timestamp: new Date().toISOString(), kind: 'receipt_unconfirmed', guardId: guard.id, owner: guard.owner, market: guard.market, txHash: hash, reason: `Receipt not confirmed (${text(error)}); not resending`, before, after: reread ? positionSnapshot(reread, null, market) : undefined, dryRun: false })
    return
  }
  const afterPosition = await readRetry(`client.getPerpPosition(${market.poolAddress}, ${guard.owner})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: guard.owner, pool: market.poolAddress }))
  // No explorer URL is stored: none is confirmed for Hideki yet. The UI shows the hash only.
  await eventLog({ timestamp: new Date().toISOString(), kind: 'confirmed', guardId: guard.id, owner: guard.owner, market: guard.market, txHash: hash, before, after: positionSnapshot(afterPosition, null, market) })
}
