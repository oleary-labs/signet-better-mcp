import { env } from "../env.js"

export interface PaymentRequirements {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

export interface SettleResult {
  success: boolean
  transaction?: string
  network?: string
  errorReason?: string
  errorMessage?: string
}

/**
 * Call the x402 facilitator's /settle endpoint to submit a signed
 * TransferWithAuthorization on-chain. The facilitator pays gas.
 */
export async function settle(
  paymentPayload: string,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResult> {
  const res = await fetch(`${env.X402_FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  })

  const result = (await res.json()) as SettleResult

  if (!result.success) {
    throw new Error(
      `Facilitator settle failed: ${result.errorReason ?? "unknown"} — ${result.errorMessage ?? "no details"}`,
    )
  }

  return result
}

/**
 * Build PaymentRequirements for a direct transfer (not from a 402 response).
 * Used when we're initiating a transfer to a NEAR Intent deposit address.
 */
export function buildPaymentRequirements(
  payTo: string,
  amount: string,
  asset: string,
  network: string,
  tokenName: string,
  tokenVersion: string,
): PaymentRequirements {
  return {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { name: tokenName, version: tokenVersion },
  }
}
