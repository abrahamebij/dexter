import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DATA_DIR, GUARDS_FILE, EVENTS_FILE, COMPILE_CACHE_FILE, type EventRecord, type Guard, type ProofClient, json, type PerpMarket } from './shared.js'
import { privateKeyToAccount } from 'viem/accounts'
import { type Address, type Hex } from 'viem'
let fallbackNoticePrinted = false
export async function ensureData(): Promise<void> {
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

export async function guards(): Promise<Guard[]> {
  const parsed: unknown = JSON.parse(await readFile(GUARDS_FILE, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('server/data/guards.json must contain an array')
  return parsed as Guard[]
}

export async function saveGuards(value: Guard[]): Promise<void> {
  await writeFile(GUARDS_FILE, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function eventLog(record: EventRecord): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(EVENTS_FILE, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('server/data/events.json must contain an array')
  parsed.push(record)
  await writeFile(EVENTS_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  console.log(`EVENT ${record.kind}: ${json(record)}`)
}

export async function loadClientFactory(): Promise<(config: unknown) => ProofClient> {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@somnia-chain/markets-sdk')
  const path = `${entry.slice(0, entry.lastIndexOf('\\'))}\\createClient.js`
  const module = await import(pathToFileURL(path).href) as { createClient: (config: unknown) => ProofClient }
  return module.createClient
}

export function marketName(market: PerpMarket): string {
  return `${market.baseSymbol ?? market.baseToken}/${market.quoteSymbol ?? market.quoteToken}`
}
export function botAccountFromEnv(): Address {
  const configuredKey = process.env.BOT_PRIVATE_KEY
  if (!configuredKey) throw new Error('BOT_PRIVATE_KEY is not configured in server/.env')
  return privateKeyToAccount((configuredKey.startsWith('0x') ? configuredKey : `0x${configuredKey}`) as Hex).address
}
