import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { badRequest, readRetry, COMPILE_CACHE_FILE, COMPILE_SCHEMA_VERSION, compileRate, type Address, type CompiledRule, type ProofClient, type Trigger, type Action, type PerpMarket } from './shared.js'
import { marketName } from './storage.js'
export function assertRule(value: unknown, markets: string[]): CompiledRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('compiled rule must be an object')
  const input = value as Record<string, unknown>
  const allowed = new Set(['market', 'trigger', 'action', 'cooldownSeconds'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw badRequest('compiled rule contains unknown fields')
  if (typeof input.market !== 'string' || !markets.includes(input.market)) throw badRequest(`market must be one of: ${markets.join(', ')}`)
  if (!Number.isInteger(input.cooldownSeconds) || (input.cooldownSeconds as number) < 0) throw badRequest('cooldownSeconds must be a non-negative integer')
  const trigger = input.trigger
  const action = input.action
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw badRequest('trigger is required')
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw badRequest('action is required')
  const triggerValue = trigger as Record<string, unknown>
  const actionValue = action as Record<string, unknown>
  let validTrigger: Trigger
  if (triggerValue.type === 'liquidation_distance_pct') {
    if (Object.keys(triggerValue).some((key) => !['type', 'thresholdPct'].includes(key)) || typeof triggerValue.thresholdPct !== 'number' || !Number.isFinite(triggerValue.thresholdPct) || triggerValue.thresholdPct <= 0 || triggerValue.thresholdPct > 100) {
      throw badRequest('thresholdPct must be a number greater than 0 and at most 100')
    }
    validTrigger = { type: 'liquidation_distance_pct', thresholdPct: triggerValue.thresholdPct }
  } else if (triggerValue.type === 'mark_price') {
    if (Object.keys(triggerValue).some((key) => !['type', 'direction', 'price'].includes(key)) || !['below', 'above'].includes(triggerValue.direction as string) || typeof triggerValue.price !== 'number' || !Number.isFinite(triggerValue.price) || triggerValue.price <= 0) {
      throw badRequest('mark_price requires direction below/above and a positive price')
    }
    validTrigger = { type: 'mark_price', direction: triggerValue.direction as 'below' | 'above', price: triggerValue.price as number }
  } else {
    throw badRequest('unsupported trigger type')
  }
  let validAction: Action
  if (actionValue.type === 'notify_only' && Object.keys(actionValue).length === 1) {
    validAction = { type: 'notify_only' }
  } else if (actionValue.type === 'partial_close' && Object.keys(actionValue).every((key) => ['type', 'closePct'].includes(key)) && [25, 50, 75, 100].includes(actionValue.closePct as number)) {
    validAction = { type: 'partial_close', closePct: actionValue.closePct as 25 | 50 | 75 | 100 }
  } else {
    throw badRequest('unsupported action; use notify_only or partial_close with closePct 25, 50, 75 or 100')
  }
  return { market: input.market, trigger: validTrigger, action: validAction, cooldownSeconds: input.cooldownSeconds as number }
}

export function restate(rule: CompiledRule): string {
  const trigger = rule.trigger.type === 'mark_price'
    ? `when ${rule.market} mark price is ${rule.trigger.direction} ${rule.trigger.price}`
    : `when liquidation is within ${rule.trigger.thresholdPct}% of the mark price`
  const action = rule.action.type === 'notify_only' ? 'send a notification' : `close ${rule.action.closePct}% of the position`
  return `On ${rule.market}, ${action} ${trigger}. Cooldown: ${rule.cooldownSeconds} seconds.`
}

export function allowCompile(owner: Address): void {
  const now = Date.now()
  const recent = (compileRate.get(owner.toLowerCase()) ?? []).filter((stamp) => now - stamp < 60_000)
  if (recent.length >= 5) throw badRequest('compile rate limit exceeded; try again later')
  recent.push(now)
  compileRate.set(owner.toLowerCase(), recent)
}

export async function currentPositionExists(client: ProofClient, owner: Address, market: PerpMarket): Promise<boolean> {
  const positions = await readRetry(`client.listPerpPositions(${owner})`, () => client.listPerpPositions(owner))
  return positions.some((position) => position.pool.toLowerCase() === market.poolAddress.toLowerCase() && BigInt(position.size) !== 0n)
}
