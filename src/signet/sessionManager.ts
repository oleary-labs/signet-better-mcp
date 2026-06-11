import { generateSessionKeypair } from "@oleary-labs/signet-sdk/session"
import { generateServerProof } from "@oleary-labs/signet-sdk/server-prover"
import { authenticateWithBootstrap } from "@oleary-labs/signet-sdk/bootstrap"
import { keygen } from "@oleary-labs/signet-sdk/keygen"
import type { SessionKeypair, IdTokenClaims } from "@oleary-labs/signet-sdk/types"
import type { Database } from "bun:sqlite"
import { env } from "../env.js"
import { upsertKey } from "./keyStore.js"

export type ParentKeyInfo = {
  keyId: string
  ethereumAddress: string
  groupPublicKey: string
}

/**
 * Per-user Signet session. Held in memory; rebuilt when the underlying JWT
 * rotates or when the prior session's exp passes.
 */
export type SignetSession = {
  keypair: SessionKeypair
  claims: IdTokenClaims
  identity: string
  expiresAt: number
  parentKey: ParentKeyInfo
}

/**
 * Caches Signet sessions keyed by (user id, jwt fingerprint) so a single
 * Bearer token doesn't trigger the heavy generateServerProof + authWithBootstrap
 * round trip on every tool call.
 */
export class SignetSessionManager {
  private readonly cache = new Map<string, Promise<SignetSession>>()
  private db: Database | null = null

  setDatabase(db: Database) {
    this.db = db
  }

  async getOrCreate(args: { userId: string; jwt: string }): Promise<SignetSession> {
    const key = `${args.userId}|${fingerprint(args.jwt)}`
    const cached = this.cache.get(key)
    if (cached) {
      const session = await cached.catch(() => null)
      if (session && session.expiresAt * 1000 > Date.now() + 30_000) {
        return session
      }
      this.cache.delete(key)
    }

    const pending = this.build(args.userId, args.jwt).catch((err) => {
      this.cache.delete(key)
      throw err
    })
    this.cache.set(key, pending)
    return pending
  }

  /** Best-effort human label for a Better Auth user id, for log lines. */
  private describeUser(userId: string): string {
    if (!this.db) return `user=${userId}`
    try {
      const row = this.db
        .query("SELECT email, name FROM user WHERE id = ?")
        .get(userId) as { email?: string; name?: string } | null
      if (!row) return `user=${userId} (not found)`
      return `user=${userId} email=${row.email ?? "?"} name=${row.name ?? "?"}`
    } catch (err) {
      return `user=${userId} (lookup failed: ${(err as Error).message})`
    }
  }

  private async build(userId: string, jwt: string): Promise<SignetSession> {
    const debug = env.LOG_LEVEL === "debug"
    if (debug) console.log("[session] building new session...")
    const keypair = await generateSessionKeypair()
    const proof = await generateServerProof(env.SIGNET_PROVER_URL, jwt, keypair.publicKeyHex, env.SIGNET_BUNDLER_API_KEY)
    if (debug) console.log("[session] proof received, authenticating...")
    const claims: IdTokenClaims = {
      iss: proof.iss,
      sub: proof.sub,
      email: "",
      azp: proof.azp,
      aud: proof.aud,
      exp: proof.exp,
      iat: Math.floor(Date.now() / 1000),
    }

    const result = await authenticateWithBootstrap(
      { groupId: env.SIGNET_GROUP_ID, nodeUrls: env.SIGNET_NODE_URLS },
      proof.proof,
      keypair.publicKeyHex,
      claims,
      proof.jwksModulus,
    )

    // Bootstrap parent key (idempotent — 409 returns existing key)
    const parentResult = await keygen(
      { groupId: env.SIGNET_GROUP_ID, nodeUrls: env.SIGNET_NODE_URLS },
      keypair,
      claims,
      undefined, // no suffix
      result.identity,
      "ecdsa_secp256k1",
      undefined, // no scope
    )
    const who = this.describeUser(userId)
    console.log(
      `[session] parent key: ${parentResult.ethereumAddress} ${parentResult.alreadyExisted ? "(cached)" : "(new DKG)"} — ${who} sub=${claims.sub} iss=${claims.iss}`,
    )

    const parentKey: ParentKeyInfo = {
      keyId: parentResult.keyId,
      ethereumAddress: parentResult.ethereumAddress,
      groupPublicKey: parentResult.groupPublicKey,
    }

    // Persist parent key to DB
    if (this.db) {
      upsertKey(this.db, {
        id: parentResult.keyId,
        user_id: userId,
        ethereum_address: parentResult.ethereumAddress,
        group_public_key: parentResult.groupPublicKey,
        curve: "ecdsa_secp256k1",
        scope: null,
        scope_chain_id: null,
        scope_contract: null,
        label: null,
        kind: "parent",
        status: "active",
      })
    }

    return {
      keypair,
      claims,
      identity: result.identity,
      expiresAt: result.expiresAt > 0 ? result.expiresAt : proof.exp,
      parentKey,
    }
  }
}

const fingerprint = (jwt: string): string => {
  const tail = jwt.slice(-16)
  return `${jwt.length}-${tail}`
}
