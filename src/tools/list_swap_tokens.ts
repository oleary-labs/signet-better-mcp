import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { listTokens } from "../services/near-intents.js"
import type { ToolContext } from "./index.js"

export const registerListSwapTokensTools = (server: McpServer, _ctx: ToolContext) => {
  server.tool(
    "list_swap_tokens",
    "List tokens available for cross-chain swaps via NEAR Intents. Returns tokens grouped by blockchain with symbol, price, and decimals. Use this to discover what the user can swap their USDC to, and to find the exact asset IDs needed for get_swap_quote and execute_swap. Supports 17+ chains including Ethereum, Solana, Arbitrum, Polygon, and more.",
    {
      chain: z
        .string()
        .optional()
        .describe("Filter by blockchain (e.g., 'sol', 'eth', 'arb'). Omit to list all chains."),
      symbol: z
        .string()
        .optional()
        .describe("Filter by token symbol (e.g., 'ETH', 'SOL'). Case-insensitive."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ chain, symbol }) => {
      let tokens = await listTokens()

      if (chain) {
        tokens = tokens.filter((t) => t.blockchain.toLowerCase() === chain.toLowerCase())
      }
      if (symbol) {
        tokens = tokens.filter((t) => t.symbol.toLowerCase() === symbol.toLowerCase())
      }

      // Group by chain
      const grouped: Record<string, Array<{ symbol: string; assetId: string; price: number; decimals: number }>> = {}
      for (const t of tokens) {
        const chain = t.blockchain
        if (!grouped[chain]) grouped[chain] = []
        grouped[chain].push({
          symbol: t.symbol,
          assetId: t.assetId,
          price: t.price,
          decimals: t.decimals,
        })
      }

      return jsonContent({
        total_tokens: tokens.length,
        chains: Object.keys(grouped).length,
        tokens: grouped,
      })
    },
  )
}

const jsonContent = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})
