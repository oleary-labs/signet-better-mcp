import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { resolveAssetId, getQuote, USDC_BASE, listTokens } from "../services/near-intents.js"
import type { ToolContext } from "./index.js"

export const registerGetSwapQuoteTools = (server: McpServer, _ctx: ToolContext) => {
  server.tool(
    "get_swap_quote",
    "Get a quote for swapping USDC on Base to any token on any chain via NEAR Intents. This is a dry run — no funds are committed. Use to check rates, fees, and estimated output before executing. Origin is always USDC on Base (the user's funded payment key).",
    {
      destination_token: z
        .string()
        .describe("Destination token: symbol (e.g., 'SOL', 'ETH') or full Defuse asset ID. If ambiguous, specify destination_chain."),
      destination_chain: z
        .string()
        .optional()
        .describe("Destination blockchain (e.g., 'sol', 'eth', 'arb'). Required if the token symbol exists on multiple chains."),
      amount_usdc: z
        .string()
        .describe("Amount of USDC to swap, in human-readable units (e.g., '5.00' for $5)."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ destination_token, destination_chain, amount_usdc }) => {
      const destAssetId = await resolveAssetId(destination_token, destination_chain)

      // Convert human USDC amount to base units (6 decimals)
      const amountBaseUnits = Math.floor(parseFloat(amount_usdc) * 10 ** USDC_BASE.decimals).toString()

      // Look up destination token info for display
      const tokens = await listTokens()
      const destToken = tokens.find((t) => t.assetId === destAssetId)

      const quote = await getQuote({
        originAsset: USDC_BASE.assetId,
        destinationAsset: destAssetId,
        amount: amountBaseUnits,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100, // 1%
        depositType: "ORIGIN_CHAIN",
        refundTo: "0x0000000000000000000000000000000000000000", // dummy for dry run
        refundType: "ORIGIN_CHAIN",
        recipient: "0x0000000000000000000000000000000000000000", // dummy for dry run
        recipientType: "DESTINATION_CHAIN",
        dry: true,
        deadline: new Date(Date.now() + 3600_000).toISOString(),
      })

      // Format output
      const amountOut = quote.quote?.amountOut
      let outputHuman: string | null = null
      if (amountOut && destToken) {
        outputHuman = (parseInt(amountOut) / 10 ** destToken.decimals).toFixed(destToken.decimals)
      }

      return jsonContent({
        input: {
          token: "USDC",
          chain: "Base",
          amount: amount_usdc,
          amount_base_units: amountBaseUnits,
        },
        output: {
          token: destToken?.symbol ?? destination_token,
          chain: destToken?.blockchain ?? destination_chain,
          asset_id: destAssetId,
          amount_base_units: amountOut,
          amount_human: outputHuman,
          price_usd: destToken?.price,
        },
        quote_details: quote.quote,
      })
    },
  )
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})
