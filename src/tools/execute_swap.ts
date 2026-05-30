import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { buildTransferAuthorization, buildPaymentPayload } from "@oleary-labs/signet-sdk/x402"
import { signTypedData, type EIP712TypedData } from "@oleary-labs/signet-sdk/scopedSign"
import { env } from "../env.js"
import { resolveAssetId, getQuote, submitDeposit, getSwapStatus, USDC_BASE, listTokens } from "../services/near-intents.js"
import { settle, buildPaymentRequirements } from "../services/facilitator.js"
import { getKeyByScope } from "../signet/keyStore.js"
import { fetchERC20Balance } from "../chain/balance.js"
import type { ToolContext } from "./index.js"

export const registerExecuteSwapTools = (server: McpServer, ctx: ToolContext) => {
  server.tool(
    "execute_swap",
    "Execute a cross-chain swap: send USDC on Base to receive any token on any chain via NEAR Intents. This is destructive — it spends USDC from the user's payment key. The x402 facilitator submits the transaction on-chain (no gas needed). The user MUST have a funded USDC-on-Base payment key. Do NOT call this without the user's explicit intent to swap.",
    {
      destination_token: z
        .string()
        .describe("Destination token: symbol (e.g., 'SOL', 'ETH') or full Defuse asset ID."),
      destination_chain: z
        .string()
        .optional()
        .describe("Destination blockchain (e.g., 'sol', 'eth'). Required if token symbol is ambiguous."),
      amount_usdc: z
        .string()
        .describe("Amount of USDC to swap, in human-readable units (e.g., '5.00' for $5)."),
      recipient: z
        .string()
        .describe("Recipient address on the destination chain (e.g., Solana address, Ethereum address)."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ destination_token, destination_chain, amount_usdc, recipient }) => {
      // 1. Resolve destination asset
      const destAssetId = await resolveAssetId(destination_token, destination_chain)
      const tokens = await listTokens()
      const destToken = tokens.find((t) => t.assetId === destAssetId)

      // 2. Look up USDC-on-Base sub-key
      const subKey = getKeyByScope(
        ctx.db,
        ctx.userId,
        USDC_BASE.chainId,
        USDC_BASE.contract,
      )
      if (!subKey) {
        return errorContent("need_key", "No USDC-on-Base payment key. Create one with create_payment_key first.")
      }
      if (subKey.status === "disabled") {
        return errorContent("key_disabled", `Payment key ${subKey.ethereum_address} is disabled.`)
      }

      // 3. Check balance
      const amountBaseUnits = Math.floor(parseFloat(amount_usdc) * 10 ** USDC_BASE.decimals).toString()
      const balance = await fetchERC20Balance(USDC_BASE.chainId, USDC_BASE.contract, subKey.ethereum_address)
      if (balance < BigInt(amountBaseUnits)) {
        return errorContent("need_funding", {
          message: `Insufficient USDC balance. Have ${balance.toString()}, need ${amountBaseUnits}.`,
          address: subKey.ethereum_address,
          balance: balance.toString(),
          required: amountBaseUnits,
        })
      }

      // 4. Get real quote (not dry) with deposit address
      const quote = await getQuote({
        originAsset: USDC_BASE.assetId,
        destinationAsset: destAssetId,
        amount: amountBaseUnits,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        depositType: "ORIGIN_CHAIN",
        refundTo: subKey.ethereum_address,
        refundType: "ORIGIN_CHAIN",
        recipient,
        recipientType: "DESTINATION_CHAIN",
        dry: false,
        deadline: new Date(Date.now() + 3600_000).toISOString(),
      })

      const depositAddress = quote.quote?.depositAddress
      if (!depositAddress) {
        return errorContent("no_deposit_address", "Quote did not return a deposit address.")
      }

      // 5. Build TransferWithAuthorization to the deposit address
      const typedData = buildTransferAuthorization(
        subKey.ethereum_address,
        depositAddress,
        amountBaseUnits,
        USDC_BASE.contract,
        USDC_BASE.chainId,
        USDC_BASE.eip712Name,
        USDC_BASE.eip712Version,
      )

      // 6. Sign via Signet
      const session = await ctx.sessionManager.getOrCreate({ userId: ctx.userId, jwt: ctx.jwt })
      const sigResult = await signTypedData(
        env.SIGNET_NODE_URLS[0],
        `${env.SIGNET_NODE_URLS[0]}/v1/sign`,
        env.SIGNET_GROUP_ID,
        subKey.id,
        "ecdsa_secp256k1",
        typedData as EIP712TypedData,
        session.keypair,
        session.claims,
        session.identity,
      )

      // 7. Build payment payload and settle via facilitator
      const paymentRequirements = buildPaymentRequirements(
        depositAddress,
        amountBaseUnits,
        USDC_BASE.contract,
        `eip155:${USDC_BASE.chainId}`,
        USDC_BASE.eip712Name,
        USDC_BASE.eip712Version,
      )

      const paymentPayload = buildPaymentPayload(
        paymentRequirements,
        (typedData as any).message,
        sigResult.ecdsaSignature,
      )

      const settleResult = await settle(paymentPayload, paymentRequirements)

      // 8. Notify NEAR Intents of deposit
      if (settleResult.transaction) {
        try {
          await submitDeposit(settleResult.transaction, depositAddress)
        } catch {
          // Non-fatal — NEAR detects deposits automatically
        }
      }

      // 9. Poll for initial status
      let swapStatus = null
      try {
        await new Promise((r) => setTimeout(r, 3000))
        swapStatus = await getSwapStatus(depositAddress)
      } catch {
        // Status not yet available
      }

      // 10. Return result
      const amountOut = quote.quote?.amountOut
      let outputHuman: string | null = null
      if (amountOut && destToken) {
        outputHuman = (parseInt(amountOut) / 10 ** destToken.decimals).toFixed(destToken.decimals)
      }

      return jsonContent({
        swap: {
          input: { token: "USDC", chain: "Base", amount: amount_usdc },
          output: {
            token: destToken?.symbol ?? destination_token,
            chain: destToken?.blockchain ?? destination_chain,
            estimated_amount: outputHuman,
          },
          recipient,
          deposit_address: depositAddress,
          settlement_tx: settleResult.transaction,
          status: swapStatus?.status ?? "PENDING",
        },
        monitor: {
          message: "Swap submitted. Use the deposit_address to check status. Cross-chain swaps typically complete in 1-5 minutes.",
          deposit_address: depositAddress,
        },
      })
    },
  )
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

const errorContent = (code: string, data: string | object) => ({
  content: [{
    type: "text" as const,
    text: JSON.stringify(
      typeof data === "string" ? { error: code, message: data } : { error: code, ...data },
      null, 2,
    ),
  }],
  isError: true as const,
})
