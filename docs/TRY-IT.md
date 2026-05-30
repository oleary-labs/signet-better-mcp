# Try the Signet MCP server

A hosted MCP server that lets an AI agent **pay for things and swap
tokens cross-chain on your behalf**. It signs x402 micropayments and
cross-chain swaps using scoped keys held on the Signet threshold-signing
network. The agent never holds a private key, and each key can only pay
one specific asset.

> **Signet is a testnet deployment — but payments and swaps settle in
> real USDC on Base mainnet (real money).** Only fund a payment key with
> a tiny amount: **~$1 is plenty** to try everything. Do **not** put
> significant money in.

## 1. Connect your MCP client

Add this as a remote MCP server / custom connector:

```
https://signet-testnet-auth.olearylabs.com/mcp
```

- **Claude (web or desktop):** Settings → Connectors → **Add custom
  connector** → paste the URL above.
- **Cursor / other MCP clients:** add an MCP server entry pointing at
  that URL (type: streamable HTTP / remote).

The client opens a browser for sign-in the first time — that's OAuth.

## 2. Sign in

On the login page, either create an account with **email + password** or
**Continue with Google**. Once signed in, the tools appear, and a
read-only **parent key** (your Ethereum identity on Signet) is created
automatically.

## 3. Create and fund a payment key

```
"Create a payment key for USDC on Base"
```

This mints a scoped sub-key and returns an Ethereum address. Send a
small amount of **USDC on Base** (~$1) to that address from any wallet
or exchange. Then confirm:

```
"List my keys"
```

You should see the parent key and your funded USDC payment key.

## 4. Pay for an x402 API

The easiest demo — point Claude at a live x402 endpoint:

> "Read https://docs.nansen.ai/getting-started/agentic-payments/x402-payments
> and use my Signet payment key to try one of the x402 endpoints."

Claude reads the docs, finds an endpoint, handles the 402 payment
challenge, signs with your scoped key, and returns the response.

## 5. Swap tokens cross-chain

With your funded USDC key, you can swap to **any token on 17+ chains**
via NEAR Intents. No gas needed — the x402 facilitator submits
on-chain for free.

```
"How much SOL would I get for 0.20 USDC?"
```

```
"Swap 0.20 USDC to SOL on Solana, send to <your-solana-address>"
```

You can also explore what's available:

```
"What tokens can I swap to?"
```

## 6. All the tools

| Tool | What it does |
|---|---|
| `list_keys` | Show your keys, balances, and status |
| `create_payment_key` | Mint a scoped key for a (chain, contract) pair |
| `sign_payment` | Low-level: sign a TransferWithAuthorization |
| `pay_x402_request` | High-level: full x402 payment dance in one call |
| `disable_key` | Kill switch — blocks signing + delegations |
| `enable_key` | Reverse a disable |
| `mint_delegation` | Create a JWT for an autonomous agent |
| `list_swap_tokens` | Discover tokens available for cross-chain swaps |
| `get_swap_quote` | Check swap rates before committing |
| `execute_swap` | Swap USDC to any token on any chain |

## What it will and won't sign

- **Will:** EIP-3009 `TransferWithAuthorization` (x402 payments and
  cross-chain swaps) — only with a key scoped to that exact asset.
- **Won't:** arbitrary hashes, raw transactions, EIP-2612 Permit,
  Permit2, SIWE, or any other typed data. A scoped key physically
  cannot be used outside its one asset — the Signet network enforces
  this on every node.

## Trouble?

- **Stuck on connect / sign-in** → make sure your client opened the
  OAuth browser window and you completed sign-in.
- **"need funding"** → the payment key has a zero balance; send USDC on
  Base to its address.
- **"need key"** → ask the agent to `create_payment_key` for USDC on
  Base first; it won't auto-create one.
- **Swap fails** → check that the destination address format matches the
  destination chain (e.g., Solana address for SOL swaps).
