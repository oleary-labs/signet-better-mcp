import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CHAIN_PRESETS } from "@oleary-labs/signet-sdk/scopedSign"
import { fetchFormattedBalance } from "../chain/balance.js"
import { getKeysByUser } from "../signet/keyStore.js"
import type { ToolContext } from "./index.js"

export const registerListKeysTools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "list_keys",
    "List the user's Signet keys: one parent key (their Ethereum identity, read-only) and zero-or-more scoped payment sub-keys. Each sub-key shows its scope (chain + contract), on-chain balance, and active/disabled status. Use this to check what keys exist and whether they're funded before calling sign_payment or pay_x402_request.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      const keys = getKeysByUser(ctx.db, ctx.userId)
      const parent = keys.find((k) => k.kind === "parent")
      const scoped = keys.filter((k) => k.kind === "scoped_eip712")

      const scopedEntries = await Promise.all(
        scoped.map(async (k) => {
          const preset = CHAIN_PRESETS.find(
            (p) =>
              p.chainId === k.scope_chain_id &&
              p.verifyingContract.toLowerCase() === k.scope_contract?.toLowerCase(),
          )

          let balance = null
          if (k.scope_chain_id && k.scope_contract) {
            try {
              const b = await fetchFormattedBalance(k.scope_chain_id, k.scope_contract, k.ethereum_address)
              balance = { ...b, as_of: new Date().toISOString() }
            } catch {
              // RPC error — omit balance rather than fail
            }
          }

          const funded = balance && BigInt(balance.raw) > 0n
          const status = k.status === "disabled" ? "disabled" : funded ? "funded" : "created"

          return {
            key_id: k.id,
            ethereum_address: k.ethereum_address,
            kind: "scoped_eip712",
            scope: {
              chain_id: k.scope_chain_id,
              verifying_contract: k.scope_contract,
              label: k.label ?? preset?.label ?? null,
            },
            balance,
            status,
          }
        }),
      )

      return jsonContent({
        parent: parent
          ? {
              key_id: parent.id,
              ethereum_address: parent.ethereum_address,
              kind: "parent",
            }
          : null,
        scoped: scopedEntries,
      })
    },
  )
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})
