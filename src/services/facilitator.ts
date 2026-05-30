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
 *
 * @param paymentPayloadBase64 - Base64-encoded PaymentPayload from buildPaymentPayload
 */
export async function settle(
  paymentPayloadBase64: string,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResult> {
  // The facilitator's /settle expects the decoded JSON object, not the
  // base64 string (base64 is for the Payment-Signature HTTP header in
  // the standard x402 flow).
  const paymentPayload = JSON.parse(atob(paymentPayloadBase64))

  const res = await fetch(`${env.X402_FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  })

  const resultText = await res.text()
  let result: SettleResult
  try {
    result = JSON.parse(resultText) as SettleResult
  } catch {
    throw new Error(`Facilitator settle returned non-JSON (${res.status}): ${resultText.slice(0, 500)}`)
  }

  if (!result.success) {
    throw new Error(
      `Facilitator settle failed: ${result.errorReason ?? "unknown"} — ${result.errorMessage ?? JSON.stringify(result)}`,
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
