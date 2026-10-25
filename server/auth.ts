import { getAddress, type Address, type Hex } from 'viem'
import { createPublicClient } from 'viem'
import type { IncomingMessage } from 'node:http'
import { badRequest, nonces, type AuthPayload, type NonceRecord } from './shared.js'
export function parseAuth(request: IncomingMessage): AuthPayload {
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

export function nonceFor(owner: Address): NonceRecord {
  const key = owner.toLowerCase()
  const existing = nonces.get(key)
  if (existing && existing.expiresAt > Date.now()) return existing
  const record = { nonce: `${Date.now()}-${crypto.randomUUID()}`, owner, expiresAt: Date.now() + 5 * 60_000 }
  nonces.set(key, record)
  return record
}

export async function verifyAuth(request: IncomingMessage, publicClient: ReturnType<typeof createPublicClient>, bodyOwner?: unknown): Promise<Address> {
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
