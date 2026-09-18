import { CHAIN_PRESETS } from "@oleary-labs/signet-sdk/scopedSign"

export type PaymentPreset = {
  label: string
  chainId: number
  contractName: string
  verifyingContract: string
  eip712Name: string
  eip712Version: string
}

/**
 * SDK presets plus chains the SDK doesn't ship yet.
 *
 * Arc USDC is the ERC-20 interface over the native gas token (6 decimals here,
 * 18 at the protocol level). Its EIP-712 domain name is "USDC", not
 * "USD Coin" as on Base — verified against DOMAIN_SEPARATOR() on chain 5042.
 */
export const PAYMENT_PRESETS: readonly PaymentPreset[] = [
  ...CHAIN_PRESETS,
  {
    label: "USDC on Arc",
    chainId: 5042,
    contractName: "USDC",
    verifyingContract: "0x3600000000000000000000000000000000000000",
    eip712Name: "USDC",
    eip712Version: "2",
  },
]

export const findPreset = (chainId: number, contract: string | null | undefined): PaymentPreset | undefined =>
  contract
    ? PAYMENT_PRESETS.find(
        (p) => p.chainId === chainId && p.verifyingContract.toLowerCase() === contract.toLowerCase(),
      )
    : undefined
