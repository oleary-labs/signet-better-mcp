import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { keygen } from "@oleary-labs/signet-sdk/keygen"
import { buildEIP712Scope, CHAIN_PRESETS } from "@oleary-labs/signet-sdk/scopedSign"
import { bytesToHex } from "@oleary-labs/signet-sdk/session"
import { env } from "../env.js"
import { upsertKey, getKeyByScope } from "../signet/keyStore.js"
import { getChainName } from "../chain/balance.js"
import type { ToolContext } from "./index.js"

export const registerCreatePaymentKeyTools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "create_payment_key",
    "Create a new scoped payment sub-key that can ONLY sign EIP-712 TransferWithAuthorization messages for one specific (chainId, verifying contract) pair — e.g., 'USDC on Base'. Use BEFORE the first sign_payment or pay_x402_request call for that asset. Idempotent: returns existing key if one already exists for this scope. The user MUST explicitly request this — do NOT call it as a side effect of other tools. The resulting key needs to be funded separately by the user.",
    {
      chain_id: z.number().int().positive().describe("Blockchain chain ID (e.g., 8453 for Base)."),
      verifying_contract: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .describe("ERC-20 token contract address (e.g., USDC contract)."),
      label: z
        .string()
        .optional()
        .describe("Optional display label (e.g., 'USDC on Base'). Auto-detected from known presets if omitted."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ chain_id, verifying_contract, label }) => {
      const session = await ctx.sessionManager.getOrCreate({ userId: ctx.userId, jwt: ctx.jwt })

      // Check if key already exists in DB
      const existing = getKeyByScope(ctx.db, ctx.userId, chain_id, verifying_contract)
      if (existing) {
        return jsonContent({
          key_id: existing.id,
          ethereum_address: existing.ethereum_address,
          already_existed: true,
          scope: {
            chain_id,
            verifying_contract,
            label: existing.label,
          },
          funding: fundingBlock(existing.ethereum_address, chain_id, verifying_contract, existing.label),
        })
      }

      const preset = CHAIN_PRESETS.find(
        (p) => p.chainId === chain_id && p.verifyingContract.toLowerCase() === verifying_contract.toLowerCase(),
      )
      const resolvedLabel = label ?? preset?.label ?? `${verifying_contract.slice(0, 10)}... on ${getChainName(chain_id)}`

      // Build the 29-byte EIP-712 scope
      const scope = buildEIP712Scope(chain_id, verifying_contract)

      // Derive suffix from scope hash — must match server-side derivation
      // Protocol: sha256(scope_bytes)[:8] hex-encoded
      const scopeBytes = new Uint8Array(
        (scope.startsWith("0x") ? scope.slice(2) : scope).match(/.{2}/g)!.map((b) => parseInt(b, 16)),
      )
      const scopeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", scopeBytes))
      const keySuffix = bytesToHex(scopeHash.slice(0, 8))

      // Keygen with scope + ecdsa_secp256k1
      const result = await keygen(
        { groupId: env.SIGNET_GROUP_ID, nodeUrls: env.SIGNET_NODE_URLS },
        session.keypair,
        session.claims,
        keySuffix,
        session.identity,
        "ecdsa_secp256k1",
        scope,
      )

      // Persist to DB
      upsertKey(ctx.db, {
        id: result.keyId,
        user_id: ctx.userId,
        ethereum_address: result.ethereumAddress,
        group_public_key: result.groupPublicKey,
        curve: "ecdsa_secp256k1",
        scope,
        scope_chain_id: chain_id,
        scope_contract: verifying_contract.toLowerCase(),
        label: resolvedLabel,
        kind: "scoped_eip712",
        status: "active",
      })

      return jsonContent({
        key_id: result.keyId,
        ethereum_address: result.ethereumAddress,
        already_existed: result.alreadyExisted,
        scope: {
          chain_id,
          verifying_contract,
          label: resolvedLabel,
        },
        funding: fundingBlock(result.ethereumAddress, chain_id, verifying_contract, resolvedLabel),
      })
    },
  )
}

function fundingBlock(address: string, chainId: number, contract: string, label: string | null) {
  const preset = CHAIN_PRESETS.find(
    (p) => p.chainId === chainId && p.verifyingContract.toLowerCase() === contract.toLowerCase(),
  )
  const asset = preset?.contractName ?? "tokens"
  const chainName = getChainName(chainId)
  return {
    instructions: `Send ${asset} on ${chainName} to ${address} from any wallet or exchange.`,
    asset,
    chain_name: chainName,
    chain_id: chainId,
    contract,
    address,
  }
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})
