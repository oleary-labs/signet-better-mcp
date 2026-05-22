# Try the Signet MCP server

A hosted MCP server that lets an AI agent **pay for things on your behalf** —
it signs x402 micropayments (EIP-3009 `TransferWithAuthorization`, USDC on
Base) using scoped keys held on the Signet threshold-signing network. The
agent never holds a private key, and each key can only pay one specific asset.

> ⚠️ **Signet is a testnet deployment — but x402 payments settle in real
> USDC on Base mainnet (real money).** Only fund a payment key with a tiny
> amount: **~$0.50 is plenty** to try the full flow end to end. Do **not** put
> significant money in.

## 1. Connect your MCP client

Add this as a remote MCP server / custom connector:

```
https://signet-testnet-auth.olearylabs.com/mcp
```

- **Claude (web or desktop):** Settings → Connectors → **Add custom connector**
  → paste the URL above.
- **Cursor / other MCP clients:** add an MCP server entry pointing at that URL
  (type: streamable HTTP / remote).

The client opens a browser for sign-in the first time — that's OAuth, and it's
expected.

## 2. Sign in

On the login page, either create an account with **email + password** or
**Continue with Google**. Once signed in, the tools appear, and a read-only
**parent key** (your Ethereum identity on Signet) is created automatically.

## 3. Easiest way to actually try it: Nansen x402 APIs

The services that work most reliably are **live production x402 endpoints**,
which charge **USDC on Base**. Nansen's agentic-payment APIs are the smoothest
path we've found, and the simplest way to drive them is to just point your
agent at their docs:

> "Read https://docs.nansen.ai/getting-started/agentic-payments/x402-payments
> and use my Signet payment key to try one of the x402 endpoints."

Claude reads the page and handles the rest — finding an endpoint, hitting it,
catching the 402, signing the payment, and retrying.

## 4. The tools, in plain English

| You want to… | Ask the agent | What happens |
|---|---|---|
| See your keys + balances | "list my Signet keys" | Shows the parent key and any payment keys, with on-chain balances |
| Set up paying for USDC on Base | "create a payment key for USDC on Base" | Mints a scoped sub-key for that (chain, contract). Returns its address |
| Pay an x402-priced API | "pay for and fetch `<url>`" | Agent hits the URL, handles the 402, signs the payment, retries |

(`disable_key`, `enable_key`, `mint_delegation`, and low-level `sign_payment`
also exist, but the three above cover the main flow.)

## 5. Fund the key (a tiny amount)

A freshly created payment key has a **zero balance** and can't pay yet. Send a
small amount of **USDC on Base** — again, **~$0.50 is enough** — to the address
`create_payment_key` returned, then ask the agent to pay.

## 6. A complete first run

1. "List my Signet keys." → see your parent key.
2. "Create a payment key for USDC on Base." → note the returned address.
3. Send ~$0.50 of USDC (on Base) to that address.
4. "List my keys again." → confirm the balance shows up.
5. "Read https://docs.nansen.ai/getting-started/agentic-payments/x402-payments
   and pay for one of their x402 endpoints with my Signet key." → the agent
   completes the payment and returns the response.

## What it will and won't sign

- **Will:** EIP-3009 `TransferWithAuthorization` (x402 payments) — and only with
  a key scoped to that exact asset.
- **Won't:** arbitrary hashes, raw transactions, EIP-2612 Permit, Permit2, SIWE,
  or any other typed data. A scoped key physically cannot be used to drain
  funds outside its one asset — the Signet network enforces this on every node.

## Trouble?

- **Stuck on connect / sign-in loop** → make sure your client opened the OAuth
  browser window and you completed sign-in.
- **"need funding"** → the payment key has a zero balance; send a little USDC on
  Base to its address (step 5).
- **"need key"** → ask the agent to `create_payment_key` for USDC on Base first;
  it won't auto-create one.
