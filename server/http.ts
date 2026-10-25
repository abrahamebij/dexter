import { readFile } from 'node:fs/promises'
import { getAddress, formatUnits } from 'viem'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { badRequest, readRetry, type Guard, type EventRecord, type PerpMarket, type ProofClient } from './shared.js'
import { verifyAuth, nonceFor } from './auth.js'
import { allowCompile, assertRule } from './rules.js'
import { compileRule, validateManualRule } from './compiler.js'
import { botAccountFromEnv, guards, saveGuards, marketName } from './storage.js'
export async function handleHttp(
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

