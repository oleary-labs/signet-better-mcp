import type { SessionKeypair, IdTokenClaims } from "@oleary-labs/signet-sdk/types"
import { signSignRequest, signKeygenRequest, deriveKeyId } from "@oleary-labs/signet-sdk/request"
import { env } from "../env.js"

/**
 * The signet-sdk handles auth (`authenticateWithBootstrap`), keygen
 * (`keygen`), and the request-signing canonical-hash dance for /v1/sign
 * (`signSignRequest`). The two HTTP endpoints the SDK does NOT wrap are:
 *
 *   - GET /v1/keys?group_id=...      → list keys for the group
 *   - POST /v1/sign                   → actually POST the signed-sign request
 *
 * Those live here. Everything else, call the SDK directly.
 */

export type SignetKey = {
  group_id: string
  key_id: string
  ethereum_address: string
  threshold: number
  parties: string[]
}

export type SignetSignature = {
  group_id: string
  key_id: string
  ethereum_signature: string
}

const nodeURL = (): string => {
  // Bias to node 0 for read paths and for the sign initiator; the node
  // coordinates with peers internally.
  const url = env.SIGNET_NODE_URLS[0]
  if (!url) {
    throw new Error("SIGNET_NODE_URLS must contain at least one node URL")
  }
  return url
}

/**
 * List keys held by the group. Filtered by group_id server-side.
 */
export const listKeys = async (): Promise<SignetKey[]> => {
  const url = `${nodeURL()}/v1/keys?group_id=${encodeURIComponent(env.SIGNET_GROUP_ID)}`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) {
    throw new SignetError(res.status, `list_keys ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as SignetKey[]
}

/**
 * Threshold-sign a message_hash for the calling user's key. The SDK builds
 * the session-signed request envelope; we just POST it.
 */
export const sign = async (args: {
  keypair: SessionKeypair
  claims: IdTokenClaims
  messageHash: Uint8Array
  keySuffix?: string
  identity?: string
}): Promise<SignetSignature> => {
  const signed = await signSignRequest(
    args.keypair,
    args.claims,
    env.SIGNET_GROUP_ID,
    args.messageHash,
    args.keySuffix,
    args.identity,
  )
  const res = await fetch(`${nodeURL()}/v1/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(signed),
  })
  if (!res.ok) {
    throw new SignetError(res.status, `sign ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as SignetSignature
}

/**
 * Disable a key. Uses the same session auth as keygen.
 * POST /v1/keys/disable
 */
export const disableKey = async (args: {
  keypair: SessionKeypair
  claims: IdTokenClaims
  keySuffix?: string
  identity?: string
  curve: string
}): Promise<{ key_id: string; status: string }> => {
  return setKeyStatus("disable", args)
}

/**
 * Re-enable a previously disabled key.
 * POST /v1/keys/enable
 */
export const enableKey = async (args: {
  keypair: SessionKeypair
  claims: IdTokenClaims
  keySuffix?: string
  identity?: string
  curve: string
}): Promise<{ key_id: string; status: string }> => {
  return setKeyStatus("enable", args)
}

const setKeyStatus = async (
  action: "disable" | "enable",
  args: {
    keypair: SessionKeypair
    claims: IdTokenClaims
    keySuffix?: string
    identity?: string
    curve: string
  },
): Promise<{ key_id: string; status: string }> => {
  const signed = await signKeygenRequest(
    args.keypair,
    args.claims,
    env.SIGNET_GROUP_ID,
    args.keySuffix,
    args.identity,
  )
  const res = await fetch(`${nodeURL()}/v1/keys/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...signed, curve: args.curve }),
  })
  if (!res.ok) {
    throw new SignetError(res.status, `${action}_key ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as { key_id: string; status: string }
}

export class SignetError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "SignetError"
  }
}
