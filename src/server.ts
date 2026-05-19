import type { Database } from "bun:sqlite"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAllTools } from "./tools/index.js"
import type { SignetSessionManager } from "./signet/sessionManager.js"

const SERVER_INSTRUCTIONS = `This server exposes scoped threshold-signing operations on the Signet
distributed key management network. The primary use case is x402
micropayments: signing EIP-712 TransferWithAuthorization messages so
agents can pay for HTTP APIs that require payment.

KEY MODEL
  Every user has one read-only parent key (their Ethereum identity)
  and zero-or-more scoped sub-keys. Each sub-key:
    - Is bound to one specific (chainId, verifying contract) pair —
      e.g., "USDC on Base."
    - Can ONLY sign EIP-3009 TransferWithAuthorization messages.
    - Has its own Ethereum address.
    - Must be funded by the user before payments work.
  This server cannot sign arbitrary hashes, raw EVM transactions,
  EIP-2612 Permits, Permit2 messages, or any EIP-712 payload whose
  primaryType is not "TransferWithAuthorization".

SUB-KEY LIFECYCLE
  1. Created  — exists on Signet, address known, balance 0. Inert.
  2. Funded   — user has sent the scoped asset to the address.
  3. Drained  — balance back to 0 after use. Top up or stop using.

WHEN TO USE WHAT
  - list_keys           → check what keys exist and whether funded
  - create_payment_key  → first time the user wants to pay for a new
                          (chain, contract). USER MUST EXPLICITLY ASK.
  - disable_key         → kill switch for a sub-key or leaked delegation
  - enable_key          → undo disable
  - sign_payment        → low-level: caller already has typed data
  - pay_x402_request    → high-level: hit an x402-priced URL (preferred)
  - mint_delegation     → hand a sub-key to an autonomous worker

REFUSAL PATTERNS
  - Missing key → point at create_payment_key, do NOT auto-create
  - Insufficient balance → show address + amount needed, do NOT retry
  - Non-TransferWithAuthorization typed data → refuse
  - Permit / Permit2 / SIWE → refuse, explain this server is x402 only`

export const buildMcpServer = (args: {
  userId: string
  jwt: string
  sessionManager: SignetSessionManager
  db: Database
}): McpServer => {
  const server = new McpServer({
    name: "signet-better-mcp",
    version: "0.1.0",
  }, { instructions: SERVER_INSTRUCTIONS })
  registerAllTools(server, args)
  return server
}
