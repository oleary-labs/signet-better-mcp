import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { requestDelegation } from "@oleary-labs/signet-sdk/delegate"
import { env } from "../env.js"
import { getKeyByAddress, getKeysByUser, type StoredKey } from "../signet/keyStore.js"
import type { ToolContext } from "./index.js"

export const registerMintDelegationTools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "mint_delegation",
    "Mint a delegation token (JWT) for a scoped sub-key, allowing an external autonomous agent to sign with it without the user being online. The returned JWT is a credential — anyone holding it can sign with that sub-key for the duration of the token. The user MUST explicitly request this. To revoke, call disable_key on the sub-key (instantly invalidates all delegations that name it).",
    {
      sub_key: z
        .string()
        .describe("The sub-key to delegate: ethereum_address (0x...) or key_id."),
      expires_in_hours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .describe("Token lifetime in hours (1-720, max 30 days)."),
      purpose: z
        .string()
        .optional()
        .describe("Optional description of what the delegation is for (audit log only)."),
    },
    async ({ sub_key, expires_in_hours, purpose }) => {
      const resolved = resolveKey(ctx, sub_key)
      if (!resolved) {
        return errorContent("key_not_found", `No key found matching '${sub_key}'.`)
      }
      if (resolved.kind === "parent") {
        return errorContent("cannot_delegate_parent", "Cannot mint a delegation for the parent key. Delegations are for scoped sub-keys.")
      }
      if (resolved.status === "disabled") {
        return errorContent("key_disabled", `Sub-key ${resolved.ethereum_address} is disabled. Enable it first.`)
      }

      const session = await ctx.sessionManager.getOrCreate({ userId: ctx.userId, jwt: ctx.jwt })
      const suffix = extractSuffix(resolved.id)
      if (!suffix) {
        return errorContent("invalid_key", "Could not determine sub-key suffix from key ID.")
      }

      const result = await requestDelegation(
        env.SIGNET_NODE_URLS[0],
        "", // direct, no proxy
        env.SIGNET_GROUP_ID,
        suffix,
        session.parentKey.keyId,
        "ecdsa_secp256k1",
        expires_in_hours * 3600,
        session.keypair,
        session.claims,
        session.identity,
      )

      return jsonContent({
        delegation_token: result.token,
        sub_key: {
          key_id: resolved.id,
          ethereum_address: resolved.ethereum_address,
        },
        parent_key_id: session.parentKey.keyId,
        expires_at: new Date(result.expiresAt * 1000).toISOString(),
      })
    },
  )
}

function resolveKey(ctx: ToolContext, key: string): StoredKey | null {
  if (key.startsWith("0x") && key.length === 42) {
    return getKeyByAddress(ctx.db, key)
  }
  const all = getKeysByUser(ctx.db, ctx.userId)
  return all.find((k) => k.id === key) ?? null
}

function extractSuffix(keyId: string): string | undefined {
  const lastColon = keyId.lastIndexOf(":")
  if (lastColon === -1) return undefined
  const candidate = keyId.slice(lastColon + 1)
  if (/^[0-9a-f]{16}$/.test(candidate)) return candidate
  return undefined
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

const errorContent = (code: string, message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }, null, 2) }],
  isError: true as const,
})
