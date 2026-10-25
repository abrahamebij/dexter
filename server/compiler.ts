import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { badRequest, COMPILE_CACHE_FILE, COMPILE_SCHEMA_VERSION, DEFAULT_GEMINI_MODEL, GEMINI_DOCS_URL, type Address, type CompiledRule, type PerpMarket, type ProofClient } from './shared.js'
import { assertRule, currentPositionExists, restate } from './rules.js'
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

