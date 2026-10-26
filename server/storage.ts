import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DATA_DIR, GUARDS_FILE, EVENTS_FILE, COMPILE_CACHE_FILE, EVENTS_JSONL_FILE, type EventRecord, type Guard, type ProofClient, json, type PerpMarket } from './shared.js'
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
  await migrateEventsToJsonl()
  try { await readFile(COMPILE_CACHE_FILE, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(COMPILE_CACHE_FILE, '{}\n', 'utf8')
  }
  if (!process.env.GEMINI_API_KEY_FALLBACK && !fallbackNoticePrinted) {
    console.log('GEMINI_API_KEY_FALLBACK is not configured; using the primary Gemini key only.')
    fallbackNoticePrinted = true
  }
}

// All writes to a given file go through one promise chain so they never interleave.
let writeQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task)
  writeQueue = run.catch(() => undefined)
  return run
}

// events.json used to be a JSON array that was rewritten on every event and got corrupted.
// It is now events.jsonl (one JSON object per line, append-only). Salvage the old file once.
async function migrateEventsToJsonl(): Promise<void> {
  try { await readFile(EVENTS_JSONL_FILE, 'utf8'); return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let lines: string[] = []
  try {
    const raw = await readFile(EVENTS_FILE, 'utf8')
    let records: unknown[] = []
    try { records = JSON.parse(raw) as unknown[] } catch {
      // Corrupted: keep the first complete array and drop trailing garbage.
      const end = raw.indexOf('\n]')
      if (end !== -1) { try { records = JSON.parse(raw.slice(0, end + 2)) as unknown[] } catch {} }
    }
    lines = (Array.isArray(records) ? records : []).map((record) => JSON.stringify(record))
    await rename(EVENTS_FILE, `${EVENTS_FILE}.bak`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(EVENTS_JSONL_FILE, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
}

export async function guards(): Promise<Guard[]> {
  const parsed: unknown = JSON.parse(await readFile(GUARDS_FILE, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('server/data/guards.json must contain an array')
  return parsed as Guard[]
}

export async function saveGuards(value: Guard[]): Promise<void> {
  await enqueue(async () => {
    const tmp = `${GUARDS_FILE}.tmp`
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, GUARDS_FILE)
  })
}

// Every read-modify-write of guards.json runs inside the write queue, so concurrent
// requests and worker updates cannot overwrite each other.
export async function mutateGuards<T>(change: (items: Guard[]) => T): Promise<T> {
  return enqueue(async () => {
    const items = await guards()
    const result = change(items)
    const tmp = `${GUARDS_FILE}.tmp`
    await writeFile(tmp, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
    await rename(tmp, GUARDS_FILE)
    return result
  })
}

export async function updateGuard(id: string, change: (guard: Guard) => void): Promise<Guard | null> {
  return mutateGuards((items) => {
    const found = items.find((item) => item.id === id)
    if (!found) return null
    change(found)
    return found
  })
}

export async function eventLog(record: EventRecord): Promise<void> {
  await enqueue(() => appendFile(EVENTS_JSONL_FILE, `${JSON.stringify(record)}\n`, 'utf8'))
  console.log(`EVENT ${record.kind} guard=${record.guardId ?? '-'} ${record.reason ?? ''}`)
}

export async function readEvents(owner?: string | null): Promise<EventRecord[]> {
  let raw = ''
  try { raw = await readFile(EVENTS_JSONL_FILE, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const records: EventRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line) as EventRecord) } catch { /* skip a torn line */ }
  }
  return owner ? records.filter((record) => record.owner?.toLowerCase() === owner.toLowerCase()) : records
}

export async function loadClientFactory(): Promise<(config: unknown) => ProofClient> {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@somnia-chain/markets-sdk')
  const path = join(dirname(entry), 'createClient.js')
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