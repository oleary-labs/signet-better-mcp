import { createPublicClient, http, erc20Abi, formatUnits, type Address } from "viem"
import { base } from "viem/chains"
import { env } from "../env.js"

const chainById: Record<number, { chain: typeof base; name: string }> = {
  8453: { chain: base, name: "Base" },
}

function getClient(chainId: number) {
  const rpcUrl = env.SIGNET_RPC_URLS[String(chainId)]
  const info = chainById[chainId]
  if (!rpcUrl && !info) throw new Error(`No RPC URL configured for chain ${chainId}`)
  return createPublicClient({
    chain: info?.chain,
    transport: http(rpcUrl),
  })
}

// ---- Balance cache (5s TTL) ----
const balanceCache = new Map<string, { value: bigint; ts: number }>()
const BALANCE_TTL = 5_000

export async function fetchERC20Balance(
  chainId: number,
  contract: string,
  holder: string,
): Promise<bigint> {
  const key = `${chainId}:${contract.toLowerCase()}:${holder.toLowerCase()}`
  const cached = balanceCache.get(key)
  if (cached && Date.now() - cached.ts < BALANCE_TTL) return cached.value

  const client = getClient(chainId)
  const value = await client.readContract({
    address: contract as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder as Address],
  })

  balanceCache.set(key, { value, ts: Date.now() })
  return value
}

// ---- Decimals cache (indefinite) ----
const decimalsCache = new Map<string, number>()

export async function getTokenDecimals(chainId: number, contract: string): Promise<number> {
  const key = `${chainId}:${contract.toLowerCase()}`
  const cached = decimalsCache.get(key)
  if (cached !== undefined) return cached

  const client = getClient(chainId)
  const decimals = await client.readContract({
    address: contract as Address,
    abi: erc20Abi,
    functionName: "decimals",
  })

  decimalsCache.set(key, decimals)
  return decimals
}

export async function fetchFormattedBalance(
  chainId: number,
  contract: string,
  holder: string,
): Promise<{ raw: string; decimal: string; symbol: string }> {
  const [balance, decimals, symbol] = await Promise.all([
    fetchERC20Balance(chainId, contract, holder),
    getTokenDecimals(chainId, contract),
    getTokenSymbol(chainId, contract),
  ])
  return {
    raw: balance.toString(),
    decimal: formatUnits(balance, decimals),
    symbol,
  }
}

// ---- Symbol cache (indefinite) ----
const symbolCache = new Map<string, string>()

async function getTokenSymbol(chainId: number, contract: string): Promise<string> {
  const key = `${chainId}:${contract.toLowerCase()}`
  const cached = symbolCache.get(key)
  if (cached) return cached

  const client = getClient(chainId)
  const symbol = await client.readContract({
    address: contract as Address,
    abi: erc20Abi,
    functionName: "symbol",
  })

  symbolCache.set(key, symbol)
  return symbol
}

export function getChainName(chainId: number): string {
  return chainById[chainId]?.name ?? `Chain ${chainId}`
}
