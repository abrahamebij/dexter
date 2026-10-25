import { getAddress, hashMessage, recoverAddress, type Address, type Hex } from 'viem'
import { createPublicClient } from 'viem'
import type { IncomingMessage } from 'node:http'
import { badRequest, nonces, text, type AuthPayload, type NonceRecord, type ProofClient } from './shared.js'
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

export async function verifyAuth(request: IncomingMessage, publicClient: ReturnType<typeof createPublicClient>, client: ProofClient, bodyOwner?: unknown): Promise<Address> {
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
  const digest = hashMessage(auth.message)
  let recovered: Address | null = null
  try { recovered = await recoverAddress({ hash: digest, signature: auth.signature }) } catch { }
  // 1) The signer is the owner itself (plain account).
  let valid = recovered !== null && recovered.toLowerCase() === auth.owner.toLowerCase()
  // 2) The owner is a smart wallet that validates the signature itself (ERC-1271).
  if (!valid) {
    try { valid = await publicClient.verifyMessage({ address: auth.owner, message: auth.message, signature: auth.signature }) } catch { valid = false }
  }
  // 3) The owner is a DreamDEX smart wallet and the signer is one of its controlling keys.
  //    A Safe rejects a plain EOA signature in step 2, so ask the SDK whether the recovered key has authority.
  if (!valid && recovered) {
    try {
      const path = await client.accounts.authorityPath(auth.owner, recovered)
      valid = path !== null
    } catch (error) {
      throw badRequest(`could not check wallet authority on chain, try again: ${text(error)}`)
    }
  }
  if (!valid) {
    const recoveredText = recovered ? ` Connected signer recovered as ${recovered}, which has no authority over ${auth.owner}.` : ''
    throw badRequest(`signature verification failed.${recoveredText} Sign with a wallet that is an owner of the requested DreamDEX account.`)
  }
  nonces.delete(auth.owner.toLowerCase())
  return auth.owner
}