import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { disableKey as signetDisableKey } from "../signet/client.js"
import { getKeyByAddress, getKeysByUser, updateKeyStatus, type StoredKey } from "../signet/keyStore.js"
import type { ToolContext } from "./index.js"

export const registerDisableKeyTools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "disable_key",
    "Disable a scoped payment sub-key. Signet will refuse to sign anything with it and will reject any delegation tokens that name it. This is the kill switch — use when a delegation token may have leaked, or when the user is done with a sub-key. Reversible via enable_key. Cannot disable the parent key.",
    {
      key: z
        .string()
        .describe("The sub-key to disable: ethereum_address (0x...) or key_id."),
      reason: z
        .enum(["compromised", "retired", "other"])
        .optional()
        .describe("Optional reason for audit logging."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ key, reason }) => {
      const resolved = resolveKey(ctx, key)
      if (!resolved) {
        return errorContent("key_not_found", `No key found matching '${key}'.`)
      }
      if (resolved.kind === "parent") {
        return errorContent("cannot_disable_parent", "The parent key cannot be disabled via this tool.")
      }
      if (resolved.status === "disabled") {
        return jsonContent({ key_id: resolved.id, ethereum_address: resolved.ethereum_address, status: "disabled", message: "Already disabled." })
      }

      const session = await ctx.sessionManager.getOrCreate({ userId: ctx.userId, jwt: ctx.jwt })

      const suffix = extractSuffix(resolved.id)

      await signetDisableKey({
        keypair: session.keypair,
        claims: session.claims,
        keySuffix: suffix,
        identity: session.identity,
        curve: "ecdsa_secp256k1",
      })

      updateKeyStatus(ctx.db, resolved.id, "disabled")

      return jsonContent({
        key_id: resolved.id,
        ethereum_address: resolved.ethereum_address,
        status: "disabled",
      })
    },
  )
}

function resolveKey(ctx: ToolContext, key: string): StoredKey | null {
  // Try by address first
  if (key.startsWith("0x") && key.length === 42) {
    return getKeyByAddress(ctx.db, key)
  }
  // Try by key_id
  const all = getKeysByUser(ctx.db, ctx.userId)
  return all.find((k) => k.id === key) ?? null
}

function extractSuffix(keyId: string): string | undefined {
  // key_id format: "iss:sub" (parent) or "iss:sub:suffix" (sub-key)
  // The identity contains ":" (e.g. "https://...ngrok.dev:userId"), so the
  // suffix is always the LAST colon-separated segment — but only if the
  // key_id is longer than the identity (i.e., has a suffix appended).
  const lastColon = keyId.lastIndexOf(":")
  if (lastColon === -1) return undefined
  const candidate = keyId.slice(lastColon + 1)
  // Suffix is a hex string (sha256 of scope, 16 chars). If it looks like
  // a suffix (short, hex-only), return it. Otherwise it's part of the identity.
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
