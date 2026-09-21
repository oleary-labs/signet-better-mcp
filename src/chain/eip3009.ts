/**
 * The EIP-3009 TransferWithAuthorization type, and the scope bound to it.
 *
 * This server signs exactly one kind of message, and a scope has to say so. A
 * 0x03 scope is `0x03 | chainId | verifyingContract | typeHash` — 61 bytes —
 * and the type hash is the part that confines a key to one *method* rather than
 * to a whole contract. Without it, a key scoped to USDC could sign an EIP-2612
 * `permit` as readily as a transfer, which is a different authority than the one
 * the user granted.
 *
 * The field list is the canonical one, and it is not ours to vary: USDC's
 * contract, go-ethereum's apitypes.TypeHash and the Signet nodes all derive
 * `0x7c7c6cdb…` from it, and every one of them recomputes the hash from the
 * payload rather than trusting what the client sends. A field out of order here
 * produces a scope no node will match.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const

/** The canonical typehash, for asserting the derivation still agrees. */
export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
  "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267"
