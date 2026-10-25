import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { formatUnits, getAddress, keccak256, parseAbi, toBytes, toFunctionSelector, type AbiFunction, type Address, type Hex } from 'viem'
import { marginBankEventsAbi, liquidationEngineEventsAbi, type PerpMarket, type SomniaMarketsClient } from '@somnia-chain/markets-sdk'
export type { Address, Hex, PerpMarket, SomniaMarketsClient }
loadEnv({ path: fileURLToPath(new URL('./.env', import.meta.url)) })

export const WS_RPC_URL = 'wss://api.hideki2.infra.testnet.somnia.network/ws'
export const INDEXER_URL = 'https://hideki-dev.smk.somnia.host/v1/graphql'
export const MARGIN_BANK = '0x478769E1177C0773c43A593DCCc4Ad15F15F1394' as Address
export const LIQUIDATION_ENGINE = '0xA66d3C24Ad4a389d863846905D8173e1017e9F4D' as Address
export const OPERATOR_PERMISSIONS_REGISTRY = '0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a' as Address
export const GAS_LIMIT = 10_000_000n
export const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))
export const GUARDS_FILE = `${DATA_DIR}guards.json`
export const EVENTS_FILE = `${DATA_DIR}events.json`
export const COMPILE_CACHE_FILE = `${DATA_DIR}compile-cache.json`
export const DRY_RUN = process.env.DRY_RUN !== 'false'
export const POLL_MS = 5_000
export const GEMINI_DOCS_URL = 'https://ai.google.dev/gemini-api/docs/models'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite'
export const COMPILE_SCHEMA_VERSION = 'guard-rule-v1'
export const delegatedOrderAbi = parseAbi([
  'function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)',
])
export const placeOrderForSelector = toFunctionSelector(delegatedOrderAbi[0] as AbiFunction)

export type Trigger =
  | { type: 'liquidation_distance_pct'; thresholdPct: number }
  | { type: 'mark_price'; direction: 'below' | 'above'; price: number }
export type Action = { type: 'notify_only' } | { type: 'partial_close'; closePct: 25 | 50 | 75 | 100 }
export type Guard = {
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
export type PositionSnapshot = { size: string; side: string; entryPrice: string; liquidationPrice: string | null }
export type EventRecord = {
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
  triggerValues?: { markPrice?: string; liquidationPrice?: string | null; thresholdPct?: number; direction?: string; targetPrice?: number; triggered?: boolean }
  positionSizeBefore?: string
  computedCloseQuantity?: string | null
  priceUsed?: string | null
  expireTimestampNs?: string | null
  simulationResult?: string
  simulationError?: string
  dryRun?: boolean
}
export type ProofClient = SomniaMarketsClient & {
  listPerpMarkets: (options?: { baseSymbol?: string; quoteSymbol?: string; limit?: number }) => Promise<PerpMarket[]>
}
export type AuthPayload = { message: string; signature: Hex; owner: Address }
export type CompiledRule = { market: string; trigger: Trigger; action: Action; cooldownSeconds: number }
export type NonceRecord = { nonce: string; owner: Address; expiresAt: number }
export const nonces = new Map<string, NonceRecord>()
export const compileRate = new Map<string, number[]>()
export const watchedNames = new Set([
  'PositionUpdated', 'FundingSettled', 'Deposited', 'DepositedFor', 'Withdrawn',
  'CollateralLocked', 'CollateralUnlocked', 'AutoDeleveraged', 'PositionTransferred',
  'LiquidationOrderPanicked', 'AccountLiquidated', 'PositionLiquidated',
  'PositionTakenOver', 'LiquidationThrottled',
])
export const marginAbi = marginBankEventsAbi.filter((entry) => entry.type === 'event' && watchedNames.has(entry.name))
export const liquidationAbi = liquidationEngineEventsAbi.filter((entry) => entry.type === 'event' && watchedNames.has(entry.name))

export function text(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
export function retryable(error: unknown): boolean {
  const value = text(error).toLowerCase()
  if (/revert|validation|invalid|argument|unsupported|execution reverted/.test(value)) return false
  return /timeout|timed out|connection|econn|socket|network unavailable|temporarily unavailable|took too long to respond/.test(value)
}
export async function readRetry<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const waits = [0, 2_000, 5_000]
  for (let attempt = 0; attempt < waits.length; attempt += 1) {
    if (waits[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, waits[attempt]))
    try { return await operation() } catch (error) {
      if (attempt === waits.length - 1 || !retryable(error)) throw error
      console.log(`Retrying ${name} after attempt ${attempt + 1}: ${text(error)}`)
    }
  }
  throw new Error(`Read retry loop exhausted: ${name}`)
}
export function topic0(entry: { name: string; inputs: readonly { type: string }[] }): Hex {
  return keccak256(toBytes(`${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`))
}
export function json(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2)
}
export function badRequest(message: string): Error { return new Error(`BAD_REQUEST: ${message}`) }
export function parseJsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > 100_000) reject(badRequest('request body is too large'))
    })
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(badRequest('request body must be valid JSON')) }
    })
    request.on('error', reject)
  })
}
