import { formatUnits, getAddress, type Address } from 'viem'
import { type Guard, type PerpMarket, type PositionSnapshot } from './shared.js'
export function positionSnapshot(position: { size: bigint; avgEntryPrice: bigint }, liquidationPrice: bigint | null, market: PerpMarket): PositionSnapshot {
  return {
    size: position.size.toString(),
    side: position.size > 0n ? 'long' : position.size < 0n ? 'short' : 'flat',
    entryPrice: formatUnits(position.avgEntryPrice, 18),
    liquidationPrice: liquidationPrice === null ? null : formatUnits(liquidationPrice, 18),
  }
}

export function ownerInDecoded(args: Record<string, unknown>): Address | null {
  for (const key of ['account', 'from', 'to', 'counterparty', 'bankrupt']) {
    const value = args[key]
    if (typeof value === 'string' && value.startsWith('0x')) return getAddress(value)
  }
  return null
}

export function triggered(guard: Guard, mark: number, liquidation: number | null): boolean {
  if (guard.trigger.type === 'mark_price') {
    return guard.trigger.direction === 'below' ? mark <= guard.trigger.price : mark >= guard.trigger.price
  }
  if (liquidation === null || mark <= 0) return false
  return ((Math.abs(mark - liquidation) / mark) * 100) <= guard.trigger.thresholdPct
}

export function inCooldown(guard: Guard): boolean {
  if (!guard.lastTriggeredAt) return false
  return Date.now() - Date.parse(guard.lastTriggeredAt) < guard.cooldownSeconds * 1_000
}
