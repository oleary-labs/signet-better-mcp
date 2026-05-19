import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { x402Fetch } from "@oleary-labs/signet-sdk/x402"
import { signTypedData, CHAIN_PRESETS, type EIP712TypedData } from "@oleary-labs/signet-sdk/scopedSign"
import { env } from "../env.js"
import { getKeyByScope, getKeysByUser, type StoredKey } from "../signet/keyStore.js"
import { fetchERC20Balance, getChainName } from "../chain/balance.js"
import type { ToolContext } from "./index.js"

export const registerPayX402Tools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "pay_x402_request",
    "Hit an x402-priced API endpoint, handling the full 402 payment dance in one call: makes the initial request, parses the payment challenge, finds the matching scoped sub-key, checks balance, signs a TransferWithAuthorization, and retries with payment. If the URL doesn't return 402, returns the response directly (no payment). Returns need_key or need_funding errors if the user needs to create a key or top up first — do NOT auto-create keys.",
    {
      url: z.string().url().describe("The API endpoint URL."),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET").describe("HTTP method."),
      headers: z.record(z.string()).optional().describe("Optional request headers."),
      body: z.string().optional().describe("Optional request body."),
      preferred_network: z
        .string()
        .default("eip155:8453")
        .describe("Preferred payment network (default: Base)."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ url, method, headers, body, preferred_network }) => {
      const session = await ctx.sessionManager.getOrCreate({ userId: ctx.userId, jwt: ctx.jwt })

      // Find a signer address for the preferred network. x402Fetch uses this
      // as the `from` field in the TransferWithAuthorization typed data.
      const chainId = parseInt(preferred_network.split(":")[1]) || 8453
      const userKeys = getKeysByUser(ctx.db, ctx.userId).filter((k) => k.kind === "scoped_eip712" && k.scope_chain_id === chainId)
      const signerAddress = userKeys[0]?.ethereum_address ?? ""

      const init: RequestInit = { method, headers }
      if (body) init.body = body

      try {
        const result = await x402Fetch(url, init, {
          signerAddress,
          preferredNetwork: preferred_network,
          signTypedData: async (typedData: EIP712TypedData) => {
            const { chainId, verifyingContract } = typedData.domain
            const subKey = getKeyByScope(ctx.db, ctx.userId, chainId, verifyingContract!)

            if (!subKey) {
              throw new NeedKeyError(chainId, verifyingContract!)
            }
            if (subKey.status === "disabled") {
              throw new Error(`Sub-key ${subKey.ethereum_address} is disabled.`)
            }

            // Check balance
            const balance = await fetchERC20Balance(chainId, verifyingContract!, subKey.ethereum_address)
            const requiredAmount = BigInt(String(typedData.message.value ?? "0"))
            if (balance < requiredAmount) {
              throw new NeedFundingError(subKey, chainId, verifyingContract!, balance, requiredAmount)
            }

            const sigResult = await signTypedData(
              env.SIGNET_NODE_URLS[0],
              `${env.SIGNET_NODE_URLS[0]}/v1/sign`,
              env.SIGNET_GROUP_ID,
              subKey.id,
              "ecdsa_secp256k1",
              typedData,
              session.keypair,
              session.claims,
              session.identity,
            )
            return sigResult.ecdsaSignature
          },
        })

        const responseBody = await result.response.text()
        const responseHeaders: Record<string, string> = {}
        result.response.headers.forEach((v, k) => { responseHeaders[k] = v })
        return jsonContent({
          status: result.response.status,
          headers: responseHeaders,
          body: responseBody,
          paid: result.paid,
          payment: result.paymentDetails ?? null,
        })
      } catch (err) {
        if (err instanceof NeedKeyError) {
          return errorContent("need_key", {
            message: `No scoped sub-key for ${getChainName(err.chainId)} / ${err.contract}. Create one with create_payment_key first.`,
            chain_id: err.chainId,
            verifying_contract: err.contract,
          })
        }
        if (err instanceof NeedFundingError) {
          return errorContent("need_funding", {
            message: `Insufficient balance. Key ${err.subKey.ethereum_address} has ${err.balance.toString()} but needs ${err.required.toString()}.`,
            address: err.subKey.ethereum_address,
            chain_id: err.chainId,
            contract: err.contract,
            balance: err.balance.toString(),
            required: err.required.toString(),
          })
        }
        throw err
      }
    },
  )
}

class NeedKeyError extends Error {
  constructor(
    public chainId: number,
    public contract: string,
  ) {
    super(`No key for chain ${chainId} / ${contract}`)
  }
}

class NeedFundingError extends Error {
  constructor(
    public subKey: StoredKey,
    public chainId: number,
    public contract: string,
    public balance: bigint,
    public required: bigint,
  ) {
    super(`Insufficient balance`)
  }
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

const errorContent = (code: string, data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: code, ...data as object }, null, 2) }],
  isError: true as const,
})
