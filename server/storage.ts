import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DATA_DIR, GUARDS_FILE, EVENTS_FILE, COMPILE_CACHE_FILE, EVENTS_JSONL_FILE, type EventRecord, type Guard, type ProofClient, json, type PerpMarket } from './shared.js'
import { privateKeyToAccount } from 'viem/accounts'
import { type Address, type Hex } from 'viem'
import { Pool } from 'pg'
let fallbackNoticePrinted = false
const databaseUrl = process.env.DATABASE_URL
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
}) : null
export const usingDatabase = pool !== null
export async function closeStorage(): Promise<void> {
  await pool?.end()
}
export async function ensureData(): Promise<void> {
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dexter_guards (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dexter_guards_owner_idx ON dexter_guards (lower(owner));
      CREATE TABLE IF NOT EXISTS dexter_events (
        id BIGSERIAL PRIMARY KEY,
        owner TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dexter_events_owner_idx ON dexter_events (lower(owner));
    `)
  }
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
  if (pool) {
    const result = await pool.query<{ data: Guard }>('SELECT data FROM dexter_guards ORDER BY created_at ASC, id ASC')
    return result.rows.map((row) => row.data)
  }
  const parsed: unknown = JSON.parse(await readFile(GUARDS_FILE, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('server/data/guards.json must contain an array')
  return parsed as Guard[]
}

export async function saveGuards(value: Guard[]): Promise<void> {
  if (pool) {
    await enqueue(async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM dexter_guards')
        for (const guard of value) {
          await client.query(
            'INSERT INTO dexter_guards (id, owner, created_at, data) VALUES ($1, $2, $3, $4)',
            [guard.id, guard.owner, guard.createdAt, guard],
          )
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    })
    return
  }
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
    if (pool) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM dexter_guards')
        for (const guard of items) {
          await client.query(
            'INSERT INTO dexter_guards (id, owner, created_at, data) VALUES ($1, $2, $3, $4)',
            [guard.id, guard.owner, guard.createdAt, guard],
          )
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      return result
    }
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
  if (pool) {
    await pool.query('INSERT INTO dexter_events (owner, created_at, data) VALUES ($1, $2, $3)', [record.owner ?? null, record.timestamp, record])
    console.log(`EVENT ${record.kind} guard=${record.guardId ?? '-'} ${record.reason ?? ''}`)
    return
  }
  await enqueue(() => appendFile(EVENTS_JSONL_FILE, `${JSON.stringify(record)}\n`, 'utf8'))
  console.log(`EVENT ${record.kind} guard=${record.guardId ?? '-'} ${record.reason ?? ''}`)
}

export async function readEvents(owner?: string | null): Promise<EventRecord[]> {
  if (pool) {
    const result = owner
      ? await pool.query<{ data: EventRecord }>('SELECT data FROM dexter_events WHERE lower(owner) = lower($1) ORDER BY id ASC', [owner])
      : await pool.query<{ data: EventRecord }>('SELECT data FROM dexter_events ORDER BY id ASC')
    return result.rows.map((row) => row.data)
  }
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