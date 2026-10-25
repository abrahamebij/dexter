import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
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
const OPERATOR_PERMISSIONS_REGISTRY = '0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a' as Address
const GAS_LIMIT = 10_000_000n
const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))
const GUARDS_FILE = `${DATA_DIR}guards.json`
const EVENTS_FILE = `${DATA_DIR}events.json`
const COMPILE_CACHE_FILE = `${DATA_DIR}compile-cache.json`
const DRY_RUN = process.env.DRY_RUN !== 'false'
const POLL_MS = 5_000
const GEMINI_DOCS_URL = 'https://ai.google.dev/gemini-api/docs/models'
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite'
const COMPILE_SCHEMA_VERSION = 'guard-rule-v1'
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
  triggerValues?: { markPrice?: string; liquidationPrice?: string | null; thresholdPct?: number; direction?: string; targetPrice?: number; triggered?: boolean }
  positionSizeBefore?: string
  computedCloseQuantity?: string | null
  priceUsed?: string | null
  expireTimestampNs?: string | null
  simulationResult?: string
  simulationError?: string
  dryRun?: boolean
}
type PositionSnapshot = { size: string; side: string; entryPrice: string; liquidationPrice: string | null }
type ProofClient = SomniaMarketsClient & {
  listPerpMarkets: (options?: { baseSymbol?: string; quoteSymbol?: string; limit?: number }) => Promise<PerpMarket[]>
}
type AuthPayload = { message: string; signature: Hex; owner: Address }
type CompiledRule = {
  market: string
  trigger: Trigger
  action: Action
  cooldownSeconds: number
}
type NonceRecord = { nonce: string; owner: Address; expiresAt: number }
const nonces = new Map<string, NonceRecord>()
const compileRate = new Map<string, number[]>()
let fallbackPreferredUntil = 0
let fallbackNoticePrinted = false

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

function badRequest(message: string): Error {
  return new Error(`BAD_REQUEST: ${message}`)
}

function parseJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > 100_000) reject(badRequest('request body is too large'))
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(badRequest('request body must be valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

function parseAuth(request: IncomingMessage): AuthPayload {
  const raw = request.headers['x-dexter-auth']
  if (typeof raw !== 'string') throw badRequest('missing x-dexter-auth header')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw badRequest('x-dexter-auth must be JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw badRequest('invalid auth payload')
  const value = parsed as Record<string, unknown>
  if (typeof value.message !== 'string' || typeof value.signature !== 'string' || typeof value.owner !== 'string') {
    throw badRequest('auth requires message, signature and owner')
  }
  return { message: value.message, signature: value.signature as Hex, owner: getAddress(value.owner) }
}

function nonceFor(owner: Address): NonceRecord {
  const key = owner.toLowerCase()
  const existing = nonces.get(key)
  if (existing && existing.expiresAt > Date.now()) return existing
  const record = { nonce: `${Date.now()}-${crypto.randomUUID()}`, owner, expiresAt: Date.now() + 5 * 60_000 }
  nonces.set(key, record)
  return record
}

async function verifyAuth(request: IncomingMessage, publicClient: ReturnType<typeof createPublicClient>, bodyOwner?: unknown): Promise<Address> {
  const auth = parseAuth(request)
  if (bodyOwner !== undefined && (typeof bodyOwner !== 'string' || getAddress(bodyOwner) !== auth.owner)) {
    throw badRequest('body owner does not match verified owner')
  }
  const record = nonces.get(auth.owner.toLowerCase())
  if (!record || record.expiresAt <= Date.now()) throw badRequest('nonce is missing or expired')
  const expiryMatch = auth.message.match(/Expiry:\s*(\d+)/i)
  if (!auth.message.includes('Dexter') || !auth.message.includes(auth.owner) || !auth.message.includes(record.nonce) || !expiryMatch) {
    throw badRequest('message must contain Dexter, owner, nonce and expiry')
  }
  if (Number(expiryMatch[1]) <= Date.now()) throw badRequest('message is expired')
  const valid = await publicClient.verifyMessage({ address: auth.owner, message: auth.message, signature: auth.signature })
  if (!valid) throw badRequest('signature verification failed')
  nonces.delete(auth.owner.toLowerCase())
  return auth.owner
}

function assertRule(value: unknown, markets: string[]): CompiledRule {
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

function restate(rule: CompiledRule): string {
  const trigger = rule.trigger.type === 'mark_price'
    ? `when ${rule.market} mark price is ${rule.trigger.direction} ${rule.trigger.price}`
    : `when liquidation is within ${rule.trigger.thresholdPct}% of the mark price`
  const action = rule.action.type === 'notify_only' ? 'send a notification' : `close ${rule.action.closePct}% of the position`
  return `On ${rule.market}, ${action} ${trigger}. Cooldown: ${rule.cooldownSeconds} seconds.`
}

function allowCompile(owner: Address): void {
  const now = Date.now()
  const recent = (compileRate.get(owner.toLowerCase()) ?? []).filter((stamp) => now - stamp < 60_000)
  if (recent.length >= 5) throw badRequest('compile rate limit exceeded; try again later')
  recent.push(now)
  compileRate.set(owner.toLowerCase(), recent)
}

async function currentPositionExists(client: ProofClient, owner: Address, market: PerpMarket): Promise<boolean> {
  const positions = await readRetry(`client.listPerpPositions(${owner})`, () => client.listPerpPositions(owner))
  return positions.some((position) => position.pool.toLowerCase() === market.poolAddress.toLowerCase() && BigInt(position.size) !== 0n)
}

type CompileResult = { rule: CompiledRule; restatement: string; warning?: string; assumptions: string[]; model: string; docsUrl: string; source: 'gemini' | 'cache' | 'manual'; keyUsed?: 'primary' | 'fallback' }

function compileCacheKey(textInput: string, markets: PerpMarket[]): string {
  const normalized = textInput.trim().toLowerCase().replace(/\s+/g, ' ')
  const symbols = markets.map(marketName).sort().join('|')
  return createHash('sha256').update(`${COMPILE_SCHEMA_VERSION}|${normalized}|${symbols}`).digest('hex')
}

async function readCompileCache(): Promise<Record<string, { rule: CompiledRule; model: string }>> {
  try {
    const value: unknown = JSON.parse(await readFile(COMPILE_CACHE_FILE, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('compile cache must be an object')
    return value as Record<string, { rule: CompiledRule; model: string }>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeCompileCache(cache: Record<string, { rule: CompiledRule; model: string }>): Promise<void> {
  await writeFile(COMPILE_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
}

async function compileRule(textInput: string, owner: Address, markets: PerpMarket[], client: ProofClient): Promise<CompileResult> {
  const normalized = textInput.toLowerCase()
  if (/\bstop[- ]loss\b|\btake[- ]profit\b/.test(normalized)) {
    throw badRequest('unsupported action: stop-loss and take-profit rules are not supported by the guard schema')
  }
  if (/^\s*protect my position\s*[.!?]*\s*$/i.test(textInput)) {
    throw badRequest('ambiguous request: specify liquidation distance or a mark-price direction and price')
  }
  const marketNames = markets.flatMap((market) => [marketName(market), ...(market.baseSymbol ? [market.baseSymbol] : [])])
  const cache = await readCompileCache()
  const cached = cache[compileCacheKey(textInput, markets)]
  const resolveResult = async (rule: CompiledRule, model: string, source: 'gemini' | 'cache', keyUsed?: 'primary' | 'fallback'): Promise<CompileResult> => {
    const selectedMarket = markets.find((market) => marketName(market) === rule.market || market.baseSymbol === rule.market)
    if (!selectedMarket) throw badRequest('compiled market is not available')
    const canonicalRule = { ...rule, market: marketName(selectedMarket) }
    const hasPosition = await currentPositionExists(client, owner, selectedMarket)
    const warning = !hasPosition ? 'No open position in this market right now. The guard will wait.' : undefined
    const assumptions = [`Uses the live ${canonicalRule.market} market definition.`]
    if (!hasPosition) assumptions.push('This owner currently has no open position in this market.')
    return { rule: canonicalRule, restatement: restate(canonicalRule), assumptions, ...(warning ? { warning } : {}), model, docsUrl: GEMINI_DOCS_URL, source, ...(keyUsed ? { keyUsed } : {}) }
  }
  if (cached) return resolveResult(cached.rule, cached.model, 'cache')
  const model = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL
  if (!process.env.GEMINI_MODEL) console.log(`Gemini model selected from official docs: ${model}; URL: ${GEMINI_DOCS_URL}`)
  const primaryKey = process.env.GEMINI_API_KEY
  const fallbackKey = process.env.GEMINI_API_KEY_FALLBACK
  if (!primaryKey) throw new Error('GEMINI_API_KEY is not configured in server/.env')
  const schema = {
    type: 'OBJECT',
    properties: {
      market: { type: 'STRING', enum: marketNames },
      trigger: { type: 'OBJECT', properties: { type: { type: 'STRING', enum: ['liquidation_distance_pct', 'mark_price'] }, thresholdPct: { type: 'NUMBER' }, direction: { type: 'STRING', enum: ['below', 'above'] }, price: { type: 'NUMBER' } }, required: ['type'] },
      action: { type: 'OBJECT', properties: { type: { type: 'STRING', enum: ['notify_only', 'partial_close'] }, closePct: { type: 'INTEGER' } }, required: ['type'] },
      cooldownSeconds: { type: 'INTEGER' },
    },
    required: ['market', 'trigger', 'action', 'cooldownSeconds'],
  }
  const requestBody = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Compile this user request into exactly one supported guard rule: "${textInput}". Owner: ${owner}. Allowed markets only: ${marketNames.join(', ')}. Supported triggers are liquidation_distance_pct with thresholdPct, or mark_price with direction below/above and price. Supported actions are notify_only or partial_close with closePct 25, 50, 75, or 100. Reject ambiguous requests and unsupported stop-loss/take-profit/price-based close semantics. Return JSON only.` }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: schema },
    })
  async function requestWithKey(key: string, attempts: number): Promise<{ response: Response; keyUsed: 'primary' | 'fallback'; status?: number }> {
    const keyUsed = key === primaryKey ? 'primary' : 'fallback'
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 2_000 : 5_000))
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody })
        if (response.ok || ![429, 503].includes(response.status)) return { response, keyUsed }
        lastError = new Error(`HTTP ${response.status}`)
        if (response.status === 429 && keyUsed === 'primary') fallbackPreferredUntil = Date.now() + 10 * 60_000
      } catch (error) { lastError = error }
    }
    throw lastError ?? new Error('Gemini request failed')
  }
  let result: { response: Response; keyUsed: 'primary' | 'fallback' }
  const preferredFallback = fallbackKey && fallbackPreferredUntil > Date.now()
  try {
    result = preferredFallback ? await requestWithKey(fallbackKey, 1) : await requestWithKey(primaryKey, 3)
  } catch (error) {
    if (!fallbackKey) throw new Error('Gemini is temporarily unavailable. Try again shortly or use the manual rule builder.', { cause: error })
    try {
      result = preferredFallback ? await requestWithKey(primaryKey, 3) : await requestWithKey(fallbackKey, 1)
    } catch {
      throw new Error('Gemini is temporarily unavailable. Try again shortly or use the manual rule builder.')
    }
  }
  if (!result.response.ok) throw new Error(`Gemini request failed with HTTP ${result.response.status}; try again shortly or use the manual rule builder.`)
  const payload = await result.response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const output = payload.candidates?.[0]?.content?.parts?.[0]?.text
  if (!output) throw new Error('Gemini returned no rule')
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { throw badRequest('Gemini returned invalid structured JSON') }
  const rule = assertRule(parsed, marketNames)
  const cacheKey = compileCacheKey(textInput, markets)
  const resolved = await resolveResult(rule, model, 'gemini', result.keyUsed)
  cache[cacheKey] = { rule: resolved.rule, model }
  await writeCompileCache(cache)
  return resolved
}

async function validateManualRule(value: unknown, owner: Address, markets: PerpMarket[], client: ProofClient): Promise<CompileResult> {
  const marketNames = markets.flatMap((market) => [marketName(market), ...(market.baseSymbol ? [market.baseSymbol] : [])])
  const rule = assertRule(value, marketNames)
  const selectedMarket = markets.find((market) => marketName(market) === rule.market || market.baseSymbol === rule.market)
  if (!selectedMarket) throw badRequest('market must be one of the live perp markets')
  const canonicalRule = { ...rule, market: marketName(selectedMarket) }
  const hasPosition = await currentPositionExists(client, owner, selectedMarket)
  const warning = !hasPosition ? 'No open position in this market right now. The guard will wait.' : undefined
  const assumptions = [`Uses the live ${canonicalRule.market} market definition.`]
  if (!hasPosition) assumptions.push('This owner currently has no open position in this market.')
  return { rule: canonicalRule, restatement: restate(canonicalRule), assumptions, ...(warning ? { warning } : {}), model: 'manual', docsUrl: GEMINI_DOCS_URL, source: 'manual' }
}

async function ensureData(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  try {
    await readFile(GUARDS_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(GUARDS_FILE, '[]\n', 'utf8')
  }
  try {
    await readFile(EVENTS_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(EVENTS_FILE, '[]\n', 'utf8')
  }
  try { await readFile(COMPILE_CACHE_FILE, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(COMPILE_CACHE_FILE, '{}\n', 'utf8')
  }
  if (!process.env.GEMINI_API_KEY_FALLBACK && !fallbackNoticePrinted) {
    console.log('GEMINI_API_KEY_FALLBACK is not configured; using the primary Gemini key only.')
    fallbackNoticePrinted = true
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

function botAccountFromEnv(): Address {
  const configuredKey = process.env.BOT_PRIVATE_KEY
  if (!configuredKey) throw new Error('BOT_PRIVATE_KEY is not configured in server/.env')
  return privateKeyToAccount((configuredKey.startsWith('0x') ? configuredKey : `0x${configuredKey}`) as Hex).address
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

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  active: () => Promise<Guard[]>,
  saveGuards: (guards: Guard[]) => Promise<void>,
  client: ProofClient,
  publicClient: ReturnType<typeof createPublicClient>,
  markets: PerpMarket[],
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
    if (request.method === 'GET' && url.pathname === '/api/positions') {
      const ownerValue = url.searchParams.get('owner')
      if (!ownerValue) throw badRequest('owner is required')
      const owner = getAddress(ownerValue)
      const indexed = await readRetry(`client.listPerpPositions(${owner})`, () => client.listPerpPositions(owner))
      const positions = []
      for (const market of markets) {
        const position = await readRetry(`client.getPerpPosition(${market.poolAddress}, ${owner})`, () => client.getPerpPosition({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
        if (position.size === 0n) continue
        const analytics = await readRetry(`client.getPerpPositionAnalytics(${market.poolAddress}, ${owner})`, () => client.getPerpPositionAnalytics({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
        const liquidationPrice = await readRetry(`client.getLiquidationPrice(${market.poolAddress}, ${owner})`, () => client.getLiquidationPrice({ marginBank: market.marginBank, account: owner, pool: market.poolAddress }))
        const margin = await readRetry(`client.getMarginAccount(${market.marginBank}, ${owner})`, () => client.getMarginAccount(market.marginBank, owner))
        const markPrice = analytics.priceable ? analytics.markPrice : 0n
        const distance = liquidationPrice !== null && liquidationPrice > 0n && markPrice > 0n ? Number(((liquidationPrice > markPrice ? liquidationPrice - markPrice : markPrice - liquidationPrice) * 10_000n) / markPrice) / 100 : null
        positions.push({
          market: marketName(market),
          pool: market.poolAddress,
          side: position.size > 0n ? 'long' : 'short',
          size: formatUnits(position.size < 0n ? -position.size : position.size, market.baseDecimals),
          sizeRaw: position.size.toString(),
          entryPrice: formatUnits(position.avgEntryPrice, 18),
          markPrice: analytics.priceable ? formatUnits(analytics.markPrice, 18) : null,
          margin: formatUnits(margin.equity, market.quoteDecimals),
          liquidationPrice: liquidationPrice === null || liquidationPrice === 0n ? null : formatUnits(liquidationPrice, 18),
          liquidationPriceRaw: liquidationPrice?.toString() ?? null,
          liquidationPriceDisplay: liquidationPrice === null || liquidationPrice === 0n ? 'Not available' : formatUnits(liquidationPrice, 18),
          liquidationDistancePct: distance,
          unrealizedPnl: analytics.priceable ? formatUnits(analytics.unrealizedPnl, market.quoteDecimals) : null,
          asOfBlock: analytics.asOfBlock.toString(),
          indexed: indexed.some((item) => item.pool.toLowerCase() === market.poolAddress.toLowerCase()),
        })
      }
      response.end(JSON.stringify({ owner, positions }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/permissions') {
      const ownerValue = url.searchParams.get('owner')
      if (!ownerValue) throw badRequest('owner is required')
      const owner = getAddress(ownerValue)
      const bot = botAccountFromEnv()
      const balance = await readRetry(`publicClient.getBalance(${bot})`, () => publicClient.getBalance({ address: bot }))
      const permissions = []
      for (const market of markets) {
        const approved = await readRetry(`client.isApprovedForPool(${market.poolAddress}, ${owner})`, () => client.isApprovedForPool({
          pool: market.poolAddress,
          owner,
          operator: bot,
          selector: '0x80054449',
        }))
        permissions.push({ market: marketName(market), pool: market.poolAddress, approved })
      }
      response.end(JSON.stringify({ owner, bot, selector: '0x80054449', botBalance: formatUnits(balance, 18), botBalanceRaw: balance.toString(), permissions }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/nonce') {
      const ownerValue = url.searchParams.get('owner')
      if (!ownerValue) throw badRequest('owner is required')
      const owner = getAddress(ownerValue)
      const record = nonceFor(owner)
      response.end(JSON.stringify({ owner, nonce: record.nonce, expiresAt: new Date(record.expiresAt).toISOString(), message: `Dexter authorization\nOwner: ${owner}\nNonce: ${record.nonce}\nExpiry: ${record.expiresAt}` }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/markets') {
      response.end(JSON.stringify({ markets: markets.map(marketName).sort() }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/guards/validate') {
      const body = await parseJsonBody(request) as Record<string, unknown>
      if (typeof body.owner !== 'string' || !body.rule || typeof body.rule !== 'object') throw badRequest('validate requires owner and rule')
      const result = await validateManualRule(body.rule, getAddress(body.owner), markets, client)
      response.end(JSON.stringify({ ...result, source: 'manual' }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/guards/compile') {
      const body = await parseJsonBody(request) as Record<string, unknown>
      if (typeof body.text !== 'string' || typeof body.owner !== 'string') throw badRequest('compile requires text and owner')
      const owner = getAddress(body.owner)
      allowCompile(owner)
      const result = await compileRule(body.text, owner, markets, client)
      response.end(JSON.stringify(result))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/guards') {
      const body = await parseJsonBody(request) as Record<string, unknown>
      const owner = await verifyAuth(request, publicClient, body.owner)
      if (typeof body.market !== 'string') throw badRequest('market is required')
      const rule = assertRule({ market: body.market, trigger: body.trigger, action: body.action, cooldownSeconds: body.cooldownSeconds ?? 300 }, markets.flatMap((market) => [marketName(market), ...(market.baseSymbol ? [market.baseSymbol] : [])]))
      const current = await guards()
      const duplicate = current.some((guard) => guard.status === 'active' && guard.owner.toLowerCase() === owner.toLowerCase() && guard.market === rule.market && JSON.stringify({ trigger: guard.trigger, action: guard.action, cooldownSeconds: guard.cooldownSeconds }) === JSON.stringify({ trigger: rule.trigger, action: rule.action, cooldownSeconds: rule.cooldownSeconds }))
      if (duplicate) throw badRequest('an identical active guard already exists for this owner and market')
      const guard: Guard = { id: crypto.randomUUID(), owner, market: rule.market, trigger: rule.trigger, action: rule.action, cooldownSeconds: rule.cooldownSeconds, status: 'active', createdAt: new Date().toISOString(), lastTriggeredAt: null, source: body.source === 'manual' ? 'manual' : 'ai' }
      current.push(guard)
      await saveGuards(current)
      response.statusCode = 201
      response.end(JSON.stringify(guard))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      const owner = url.searchParams.get('owner')
      const records: EventRecord[] = JSON.parse(await readFile(EVENTS_FILE, 'utf8'))
      response.end(JSON.stringify(owner ? records.filter((record) => record.owner?.toLowerCase() === owner.toLowerCase()) : records))
      return
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/guards/')) {
      const id = url.pathname.slice('/api/guards/'.length)
      const body = await parseJsonBody(request) as Record<string, unknown>
      const current = await guards()
      const guard = current.find((item) => item.id === id)
      if (!guard) throw badRequest('guard not found')
      const owner = await verifyAuth(request, publicClient, body.owner ?? guard.owner)
      if (owner.toLowerCase() !== guard.owner.toLowerCase()) throw badRequest('verified owner does not own this guard')
      if (body.status !== 'active' && body.status !== 'paused') throw badRequest('status must be active or paused')
      guard.status = body.status
      await saveGuards(current)
      response.end(JSON.stringify(guard))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'Not found' }))
  } catch (error) {
    const message = text(error)
    response.statusCode = /missing x-dexter-auth|auth requires|nonce is missing|signature verification failed|message must contain/i.test(message)
      ? 401
      : message.includes('BAD_REQUEST:') ? 400 : 500
    response.end(JSON.stringify({ error: message }))
  }
}

main().catch((error) => {
  console.error(`Guardian stopped: ${text(error)}`)
  process.exitCode = 1
})
