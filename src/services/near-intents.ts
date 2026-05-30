import { env } from "../env.js"

export interface NearToken {
  assetId: string
  decimals: number
  blockchain: string
  symbol: string
  price: number
  priceUpdatedAt: string
  contractAddress: string
}

export interface QuoteRequest {
  originAsset: string
  destinationAsset: string
  amount: string
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT"
  slippageTolerance: number
  depositType: "ORIGIN_CHAIN" | "INTENTS"
  refundTo: string
  refundType: "ORIGIN_CHAIN" | "INTENTS"
  recipient: string
  recipientType: "DESTINATION_CHAIN" | "INTENTS"
  dry: boolean
  deadline: string
}

export interface QuoteResponse {
  quote?: {
    depositAddress?: string
    amountIn: string
    amountOut: string
    estimatedTime?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface SwapStatus {
  status: string
  swapDetails?: {
    amountIn?: string
    amountOut?: string
    originAsset?: string
    destinationAsset?: string
    [key: string]: unknown
  }
  transactionDetails?: unknown
  [key: string]: unknown
}

// ---- Token cache (60s TTL) ----
let tokenCache: { tokens: NearToken[]; ts: number } | null = null
const TOKEN_CACHE_TTL = 60_000

export async function listTokens(): Promise<NearToken[]> {
  if (tokenCache && Date.now() - tokenCache.ts < TOKEN_CACHE_TTL) {
    return tokenCache.tokens
  }

  const res = await fetch(`${env.NEAR_INTENTS_API_URL}/v0/tokens`)
  if (!res.ok) throw new Error(`listTokens failed: ${res.status}`)
  const tokens = (await res.json()) as NearToken[]
  tokenCache = { tokens, ts: Date.now() }
  return tokens
}

/**
 * Resolve a human-friendly token reference to a Defuse asset ID.
 * Accepts: full asset ID, or symbol + chain (e.g. "SOL" + "sol").
 */
export async function resolveAssetId(tokenRef: string, chain?: string): Promise<string> {
  // If it looks like a full asset ID, return as-is
  if (tokenRef.includes(":")) return tokenRef

  const tokens = await listTokens()
  const matches = tokens.filter((t) => {
    const symbolMatch = t.symbol.toLowerCase() === tokenRef.toLowerCase()
    const chainMatch = !chain || t.blockchain.toLowerCase() === chain.toLowerCase()
    return symbolMatch && chainMatch
  })

  if (matches.length === 0) {
    throw new Error(`Token "${tokenRef}"${chain ? ` on ${chain}` : ""} not found. Use list_swap_tokens to see available tokens.`)
  }
  if (matches.length > 1 && !chain) {
    const chains = matches.map((t) => t.blockchain).join(", ")
    throw new Error(`"${tokenRef}" exists on multiple chains: ${chains}. Specify destination_chain.`)
  }

  return matches[0].assetId
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (env.NEAR_INTENTS_JWT) {
    headers["Authorization"] = `Bearer ${env.NEAR_INTENTS_JWT}`
  }
  return headers
}

export async function getQuote(params: QuoteRequest): Promise<QuoteResponse> {
  const res = await fetch(`${env.NEAR_INTENTS_API_URL}/v0/quote`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getQuote failed: ${res.status} — ${body}`)
  }
  return (await res.json()) as QuoteResponse
}

export async function submitDeposit(txHash: string, depositAddress: string): Promise<unknown> {
  const res = await fetch(`${env.NEAR_INTENTS_API_URL}/v0/deposit/submit`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ txHash, depositAddress }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`submitDeposit failed: ${res.status} — ${body}`)
  }
  return res.json()
}

export async function getSwapStatus(depositAddress: string): Promise<SwapStatus> {
  const res = await fetch(
    `${env.NEAR_INTENTS_API_URL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getStatus failed: ${res.status} — ${body}`)
  }
  return (await res.json()) as SwapStatus
}

// USDC on Base — the origin asset for all swaps
export const USDC_BASE = {
  assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  chainId: 8453,
  contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
  eip712Name: "USD Coin",
  eip712Version: "2",
}
