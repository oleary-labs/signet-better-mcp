import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { signTypedData, type EIP712TypedData } from "@oleary-labs/signet-sdk/scopedSign"
import { env } from "../env.js"
import { getKeyByScope } from "../signet/keyStore.js"
import type { ToolContext } from "./index.js"

export const registerSignPaymentTools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "sign_payment",
    "Sign an EIP-3009 TransferWithAuthorization typed-data payload using the scoped sub-key whose scope matches the typed data's domain. ONLY accepts primaryType 'TransferWithAuthorization' — rejects Permit, Permit2, and all other typed-data shapes. For most use cases, prefer pay_x402_request which handles the full 402 dance automatically.",
    {
      typed_data: z
        .object({
          domain: z.object({
            name: z.string().optional(),
            version: z.string().optional(),
            chainId: z.number().int().positive(),
            verifyingContract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
          }),
          types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
          primaryType: z.string(),
          message: z.record(z.unknown()),
        })
        .describe("Full EIP-712 typed data envelope. primaryType MUST be 'TransferWithAuthorization'."),
    },
    async ({ typed_data }) => {
      // Policy: only TransferWithAuthorization
      if (typed_data.primaryType !== "TransferWithAuthorization") {
        return errorContent(
          "wrong_primary_type",
          `Rejected: primaryType '${typed_data.primaryType}' is not allowed. This tool only signs 'TransferWithAuthorization' (EIP-3009) messages.`,
        )
      }

      const { chainId, verifyingContract } = typed_data.domain
      const subKey = getKeyByScope(ctx.db, ctx.userId, chainId, verifyingContract)
      if (!subKey) {
        return errorContent(
          "need_key",
          `No scoped sub-key exists for chain ${chainId} / contract ${verifyingContract}. Create one with create_payment_key first.`,
        )
      }

      if (subKey.status === "disabled") {
        return errorContent("key_disabled", `Sub-key ${subKey.ethereum_address} is disabled. Call enable_key to reactivate.`)
      }

      // Verify message.from matches the sub-key's address
      const from = String(typed_data.message.from ?? "").toLowerCase()
      if (from && from !== subKey.ethereum_address.toLowerCase()) {
        return errorContent(
          "wrong_signer",
          `message.from (${from}) does not match sub-key address (${subKey.ethereum_address}). The signature would be invalid.`,
        )
      }

      const session = await ctx.sessionManager.getOrCreate({ userId: ctx.userId, jwt: ctx.jwt })

      const result = await signTypedData(
        env.SIGNET_NODE_URLS[0],
        `${env.SIGNET_NODE_URLS[0]}/v1/sign`,
        env.SIGNET_GROUP_ID,
        subKey.id,
        "ecdsa_secp256k1",
        typed_data as EIP712TypedData,
        session.keypair,
        session.claims,
        session.identity,
      )

      return jsonContent({
        ecdsa_signature: result.ecdsaSignature,
        signature: result.signature,
        key_id: subKey.id,
        ethereum_address: subKey.ethereum_address,
      })
    },
  )
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

const errorContent = (code: string, message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }, null, 2) }],
  isError: true as const,
})
