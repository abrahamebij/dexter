import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { badRequest, COMPILE_CACHE_FILE, COMPILE_SCHEMA_VERSION, DEFAULT_GEMINI_MODEL, GEMINI_DOCS_URL, type Address, type CompiledRule, type PerpMarket, type ProofClient } from './shared.js'
import { assertRule, currentPositionExists, restate } from './rules.js'
import { marketName } from './storage.js'

let fallbackPreferredUntil = 0
export type CompileResult = { rule: CompiledRule; restatement: string; warning?: string; assumptions: string[]; model: string; docsUrl: string; source: 'gemini' | 'cache' | 'manual'; keyUsed?: 'primary' | 'fallback' }
function providerError(status: number, body: string): Error {
  const detail = body.trim() || 'The provider returned an empty error response.'
  return new Error(`Gemini request failed (HTTP ${status}): ${detail}`)
}
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
// The LLM may invent numbers the user never wrote. Compare the validated rule with the user's text
// deterministically, override an invented cooldown with the 300-second default, and list every value
// the user did not state so the confirmation card can show them as assumptions.
const DEFAULT_COOLDOWN_SECONDS = 300
function numbersIn(textInput: string): number[] {
  const values: number[] = []
  for (const match of textInput.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k)?(?![\w])/gi)) {
    const value = Number(match[1].replace(/,/g, ''))
    if (Number.isFinite(value)) values.push(match[2] ? value * 1_000 : value)
  }
  return values
}
export function applyStatedValues(rule: CompiledRule, textInput: string): { rule: CompiledRule; assumptions: string[] } {
  const text = textInput.toLowerCase()
  const numbers = numbersIn(text)
  const assumptions: string[] = []
  const next: CompiledRule = { ...rule }

  const cooldown = text.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/)
  if (cooldown) {
    const unit = cooldown[2]
    const factor = unit.startsWith('h') ? 3_600 : unit.startsWith('m') ? 60 : 1
    next.cooldownSeconds = Math.round(Number(cooldown[1]) * factor)
  } else {
    next.cooldownSeconds = DEFAULT_COOLDOWN_SECONDS
    assumptions.push(`Cooldown: ${DEFAULT_COOLDOWN_SECONDS} seconds (you did not state one)`)
  }

  if (rule.trigger.type === 'liquidation_distance_pct' && !numbers.includes(rule.trigger.thresholdPct)) {
    assumptions.push(`Liquidation distance threshold: ${rule.trigger.thresholdPct}% (you did not state one)`)
  }
  if (rule.trigger.type === 'mark_price' && !numbers.includes(rule.trigger.price)) {
    assumptions.push(`Trigger price: ${rule.trigger.price} (this number is not in your text, check it)`)
  }
  if (rule.action.type === 'partial_close') {
    const word = /three[- ]quarters/.test(text) ? 75 : /\bhalf\b/.test(text) ? 50 : /\bquarter\b/.test(text) ? 25 : /\b(all|everything|entire|whole|fully)\b/.test(text) ? 100 : null
    if (!numbers.includes(rule.action.closePct) && word !== rule.action.closePct) {
      assumptions.push(`Close size: ${rule.action.closePct}% of the position (you did not state one)`)
    }
  }
  return { rule: next, assumptions }
}

export async function compileRule(textInput: string, owner: Address, markets: PerpMarket[], client: ProofClient): Promise<CompileResult> {
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
    const stated = applyStatedValues({ ...rule, market: marketName(selectedMarket) }, textInput)
    const canonicalRule = stated.rule
    const hasPosition = await currentPositionExists(client, owner, selectedMarket)
    const warning = !hasPosition ? 'No open position in this market right now. The guard will wait.' : undefined
    const assumptions = [...stated.assumptions, `Uses the live ${canonicalRule.market} market definition.`]
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
  async function requestWithKey(key: string, attempts: number): Promise<{ response: Response; body: string; keyUsed: 'primary' | 'fallback' }> {
    const keyUsed = key === primaryKey ? 'primary' : 'fallback'
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 2_000 : 5_000))
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody })
        const body = await response.text()
        if (response.ok || ![429, 503].includes(response.status)) return { response, body, keyUsed }
        lastError = providerError(response.status, body)
        if (response.status === 429 && keyUsed === 'primary') fallbackPreferredUntil = Date.now() + 10 * 60_000
      } catch (error) { lastError = error }
    }
    throw lastError ?? new Error('Gemini request failed')
  }
  let result: { response: Response; body: string; keyUsed: 'primary' | 'fallback' }
  const preferredFallback = fallbackKey && fallbackPreferredUntil > Date.now()
  try {
    result = preferredFallback ? await requestWithKey(fallbackKey, 1) : await requestWithKey(primaryKey, 3)
  } catch (error) {
    if (!fallbackKey) throw error
    try {
      result = preferredFallback ? await requestWithKey(primaryKey, 3) : await requestWithKey(fallbackKey, 1)
    } catch (fallbackError) {
      throw new Error(`Gemini primary request failed: ${error instanceof Error ? error.message : String(error)}; fallback request failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`)
    }
  }
  if (!result.response.ok) throw providerError(result.response.status, result.body)
  let payload: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  try {
    payload = JSON.parse(result.body) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  } catch {
    throw new Error(`Gemini returned an invalid response body (HTTP ${result.response.status}): ${result.body}`)
  }
  const output = payload.candidates?.[0]?.content?.parts?.[0]?.text
  if (!output) throw new Error(`Gemini returned no rule. Raw response: ${result.body}`)
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { throw new Error(`Gemini returned invalid structured JSON. Raw model output: ${output}`) }
  const rule = assertRule(parsed, marketNames)
  const cacheKey = compileCacheKey(textInput, markets)
  const resolved = await resolveResult(rule, model, 'gemini', result.keyUsed)
  cache[cacheKey] = { rule: resolved.rule, model }
  await writeCompileCache(cache)
  return resolved
}

export async function validateManualRule(value: unknown, owner: Address, markets: PerpMarket[], client: ProofClient): Promise<CompileResult> {
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