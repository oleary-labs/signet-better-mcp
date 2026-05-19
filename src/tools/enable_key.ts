import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { enableKey as signetEnableKey } from "../signet/client.js"
import { getKeyByAddress, getKeysByUser, updateKeyStatus, type StoredKey } from "../signet/keyStore.js"
import type { ToolContext } from "./index.js"

export const registerEnableKeyTools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "enable_key",
    "Re-enable a previously disabled sub-key. Restores signing ability and delegation token validity.",
    {
      key: z
        .string()
        .describe("The sub-key to enable: ethereum_address (0x...) or key_id."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ key }) => {
      const resolved = resolveKey(ctx, key)
      if (!resolved) {
        return errorContent("key_not_found", `No key found matching '${key}'.`)
      }
      if (resolved.kind === "parent") {
        return errorContent("cannot_enable_parent", "The parent key status is managed separately.")
      }
      if (resolved.status === "active") {
        return jsonContent({ key_id: resolved.id, ethereum_address: resolved.ethereum_address, status: "active", message: "Already active." })
      }

      const session = await ctx.sessionManager.getOrCreate({ userId: ctx.userId, jwt: ctx.jwt })
      const suffix = extractSuffix(resolved.id)

      await signetEnableKey({
        keypair: session.keypair,
        claims: session.claims,
        keySuffix: suffix,
        identity: session.identity,
        curve: "ecdsa_secp256k1",
      })

      updateKeyStatus(ctx.db, resolved.id, "active")

      return jsonContent({
        key_id: resolved.id,
        ethereum_address: resolved.ethereum_address,
        status: "active",
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
