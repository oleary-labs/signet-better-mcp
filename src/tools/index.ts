import type { Database } from "bun:sqlite"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SignetSessionManager } from "../signet/sessionManager.js"
import { registerListKeysTools } from "./list_keys.js"
import { registerCreatePaymentKeyTools } from "./create_payment_key.js"
import { registerSignPaymentTools } from "./sign_payment.js"
import { registerPayX402Tools } from "./pay_x402.js"
import { registerDisableKeyTools } from "./disable_key.js"
import { registerEnableKeyTools } from "./enable_key.js"
import { registerMintDelegationTools } from "./mint_delegation.js"

export type ToolContext = {
  userId: string
  jwt: string
  sessionManager: SignetSessionManager
  db: Database
}

export const registerAllTools = (server: McpServer, ctx: ToolContext) => {
  registerListKeysTools(server, ctx)
  registerCreatePaymentKeyTools(server, ctx)
  registerSignPaymentTools(server, ctx)
  registerPayX402Tools(server, ctx)
  registerDisableKeyTools(server, ctx)
  registerEnableKeyTools(server, ctx)
  registerMintDelegationTools(server, ctx)
}
