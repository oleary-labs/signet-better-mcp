# Polymarket MCP Server — Engineering Handoff

**Audience:** the dev building our Polymarket MCP server
**Goal:** wrap Polymarket trading + market data behind an MCP server, with key custody handled properly on our side (KMS/enclave signer, not a plaintext key in env)
**Status of this doc:** current as of 2026-06-03. The CLOB V2 migration (2026-04-28) and an open, unfixed SDK auth bug materially affect the design — read the "Blocker" section before architecting.

---

## TL;DR for the impatient

1. There is **no official Polymarket MCP server.** We're building one. Every existing MCP server is third-party and reimplements fragments of the official SDK flow, usually with a plaintext private key in env. We're replacing exactly that layer.
2. Polymarket's "smart wallet" is a **Gnosis Safe + private meta-transaction relayer**, *not* ERC-4337. No UserOps, no bundler, no EntryPoint. The EOA signs Safe `execTransaction` payloads (for on-chain ops) and EIP-712 order messages (for the CLOB). Gas is paid by Polymarket's relayer.
3. CLOB V2 went live **2026-04-28**; V1 SDKs no longer work, all open orders were wiped, EIP-712 domain bumped "1"→"2". Use the **v2** SDKs only.
4. **Hard blocker:** the documented new-user path (deposit wallet + POLY_1271 / sig type 3) is **broken in both the Python and Rust v2 SDKs** — the L1 auth code binds the API key to the EOA, not the deposit wallet, so every order is rejected with HTTP 400 `the order signer address has to be the address of the API KEY`. Legacy EOA flow (sig type 0) is also rejected post-2026-04-28. See the dedicated section — there's a full root cause + fix sketch we can implement ourselves.
5. Architecture to copy: the **official `Polymarket/*-safe-builder-example` repos**, specifically the proxy/remote-signing pattern, with our signer behind KMS. Crib the **MCP tool surface** from `@iqai/mcp-polymarket`, the **risk guardrails** from `caiovicentino`, and the **pre-trade slippage/liquidity logic** from `whitmorelabs`.

---

## 1. The auth & wallet model (read this before writing any signing code)

Polymarket is **not** ERC-4337 account abstraction. It's the older Gnosis-Safe-style smart-contract-wallet model plus a centralized relayer. Two things confuse people coming from a 4337 background, so be explicit:

### Wallet structure
- A user has an **owner EOA** (the key we control) and a **deposit wallet** (a Gnosis Safe / proxy wallet) deployed at a **deterministic CREATE2 address derived from the EOA**.
- The **Safe holds the funds** (pUSD/USDC.e and the ERC-1155 CTF outcome tokens). The EOA is the *owner/signer*; the Safe is the *funder*.
- The owner is NOT part of the signed Safe-create message — it's recovered from the signature.

### Two distinct signature paths
| Path | What it signs | How it's verified | Used for |
|---|---|---|---|
| **Safe `execTransaction`** | EIP-712 `SafeTx` struct | Safe owner check | Deploy Safe, set token approvals, CTF split/merge/redeem |
| **CLOB order** | EIP-712 order message | per-order `signature_type` field | Placing/cancelling orders on the off-chain book |

### Signature types (`signature_type` on the CLOB client)
- **0 = EOA** — bare ECDSA against the EOA. **Rejected for new users post-2026-04-28.**
- **1 = POLY_PROXY** — Magic/email-provisioned proxy wallet.
- **2 = POLY_GNOSIS_SAFE** — pre-upgrade Safe accounts.
- **3 = POLY_1271** — deposit wallet validated via **EIP-1271 `isValidSignature`** (contract signature, ERC-7739-wrapped). **This is the documented path for new users — and it's the one broken in the SDKs (see §3).**

### Gasless mechanism
Signed Safe transactions go to Polymarket's **Relayer** (`https://relayer-v2.polymarket.com`), which pays gas so users only need pUSD, never POL. Relayer access is gated by **builder HMAC credentials** (separate from the user's CLOB API creds). This is meta-transaction relaying off a private endpoint — not a 4337 paymaster.

### Custody implication for our design
EIP-1271 is the hook that lets a **contract/enclave signer** (Turnkey/Privy/Magic, or our own KMS) be the validator instead of a bare ECDSA key in a file. That's the whole point of doing real key management: the EOA private key should live in our KMS/enclave and only ever produce signatures on request. Owning the EOA = owning the Safe = able to drain it, so the key's blast radius is total — treat it accordingly. The relayer and the 1271 order layer do **not** constrain a withdrawal; only key custody does.

---

## 2. CLOB V2 migration facts (2026-04-28)

- V1 SDKs (`clob-client`, `py-clob-client`) **no longer function** against production. No backward compat. Use `@polymarket/clob-client-v2` (TS) / `py-clob-client-v2` (Python) / `rs-clob-client-v2` (Rust).
- Go-live ~11:00 UTC 2026-04-28, ~1h downtime. **All open orders were wiped**; V1 resting orders did not migrate.
- On-chain exchange rewritten: Solidity 0.8.15 → 0.8.30, Solady replacing OpenZeppelin. **Order struct changed**: `nonce`, `feeRateBps`, `taker` removed; `timestamp`, `metadata`, `builder` added. **EIP-712 exchange domain version "1" → "2".** Fees now collected on-chain at match time, no longer embedded in the signed order.
- Migration checklist + details: https://docs.polymarket.com/v2-migration

If we wrote any signing logic by hand (rather than via the SDK), every one of those struct/domain changes matters.

---

## 3. BLOCKER: deposit-wallet (POLY_1271) order placement is broken in the v2 SDKs

This is the single most important thing in this doc. Tracked at **`Polymarket/py-clob-client-v2` issue #70** (open, unassigned, filed 2026-05-19; tested against `py-clob-client-v2` 1.0.1 and `rs-clob-client-v2` 0.5.1). Related: issue #51 (legacy EOA rejection, open since 2026-05-08). The issue tracker has a steady stream of new auth complaints (#76, #77, #83–88), so this is actively biting people and not yet resolved.

### Symptom
A fresh EOA + deployed deposit wallet + funded pUSD + correct approvals + synced CLOB cache **cannot place orders**. Fails with:
```
HTTP 400 — {"error":"the order signer address has to be the address of the API KEY"}
```

### Root cause
Both SDKs' **L1 authentication path signs the auth message using the EOA's address** as `POLY_ADDRESS`, regardless of `signature_type=POLY_1271` and `funder=deposit_wallet` being set. Result: the derived API key is bound to the **EOA**, while orders correctly set `signer=deposit_wallet` → API rejects every order because key-owner ≠ order-signer.

Specifically (Python, `client.py` / `headers/headers.py` / `signing/clob_auth.py`):
1. `_l1_headers` ignores `self.signature_type` and `self.funder` entirely.
2. `create_level_1_headers` has no funder / signature-type parameter.
3. `sign_clob_auth_message` bakes `signer.address()` (the EOA) into the `ClobAuth.address` field of the EIP-712 payload — so even passing a funder wouldn't help; the signed payload itself claims the EOA identity.

The Rust SDK has the same gap: `authentication_builder` accepts `.funder()` and `.signature_type(Poly1271)`, but `.authenticate()` builds the auth message from `signer.address()`.

It's a **key-creation-time** bug, not key-selection. Deleting and re-deriving the key reproduces the same EOA binding.

### Why we can't just sidestep it
- Sig type 0 (EOA) is **rejected post-2026-04-28** (issue #51).
- Sig types 1/2 only work for **pre-existing** Magic or pre-upgrade Safe accounts — not available to a fresh programmatic user.
- So the *only* documented new-user path is POLY_1271, which is exactly what's broken.
- The community workaround — sign up via the Magic email UI, **extract the private key**, use sig type 1 — throws away the KMS/enclave protection that's the entire reason we're doing this properly. **Do not adopt this for production.** It also scales badly (one email/account per bot) and risks anti-multi-account TOS friction.

### The fix (we can implement this ourselves — ~50 lines per SDK)
The issue author provides a fix sketch, and the POLY_1271 **order** signing wrapper already exists in both SDKs — it's the same shape needed for L1 auth. When `signature_type=POLY_1271` and `funder` is set, the L1 auth path should:
1. Set `POLY_ADDRESS` to the **funder** (deposit wallet) address.
2. Set the signed payload's `ClobAuth.address` to the **funder** address.
3. **ERC-7739-wrap** the signature so the CLOB validates via `IERC1271(funder).isValidSignature(hash, sig)` instead of ECDSA-recovering the EOA. Use the deposit-wallet domain: `name="DepositWallet"`, `version="1"`, `verifyingContract=funder`.
4. Sign the wrapped hash with the EOA (in our case: via KMS).
5. Concatenate into the final POLY_1271 signature bytes.
6. Return headers with `POLY_ADDRESS=funder`.

**Recommended approach for us:** since we're wrapping the SDK anyway, implement the corrected L1-auth-for-1271 path in our own auth layer rather than waiting on an upstream fix. Watch issue #70 for an upstream PR/merge; if it lands, swap to it. Verify on-chain prerequisites (Safe deployed, approvals set, balances funded) are all confirmed working per the issue — the gap is purely the auth signing, so once that's correct, ordering should work.

### Reference addresses from the issue (Polygon mainnet, chain_id 137)
- CLOB host: `https://clob.polymarket.com`
- Relayer: `https://relayer-v2.polymarket.com`
- pUSD: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- Deposit wallet factory: `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`

> Verify these against current docs before hardcoding — addresses and the pUSD/USDC.e situation are exactly the kind of thing that changed in the V2 migration.

---

## 4. The APIs we're wrapping

- **Gamma Markets API** — market/event metadata, read-only. Start here for market discovery.
- **CLOB API (v2)** — order book, prices, place/cancel orders. The trading core.
- **Data API** — positions, P&L, trade history, user activity for a wallet address.
- **Builder Relayer** — gasless Safe deployment, token approvals, CTF operations. Gated by builder HMAC creds.

**Builder codes** are required for relayer access + order attribution (revenue share on routed orders). Get them at `polymarket.com/settings?tab=builder`. Keep builder credentials **server-side only** — never ship them to a client. There are throughput tiers (Unverified default → Verified, manual approval → Enterprise); relayer requests beyond the daily limit are rate-limited/errored, so if we expect volume, start the Verified application early.

---

## 5. Reference implementations — what to read and why

### Tier 1 — architecture skeleton (official)
- **`Polymarket/safe-wallet-integration`** — the canonical relayer + Safe + approvals + CTF flow. The `RelayClient` handles Safe deployment, token approvals, and CTF split/merge/redeem.
- **`Polymarket/turnkey-safe-builder-example`** — best for **enclave/remote-signer** patterns (closest to our KMS design). Note its custom `TurnkeyEthersSigner` adapter bridging viem WalletClient → ethers v5, because the ClobClient needs an ethers v5 signer for EIP-712.
- **`Polymarket/{privy,magic,wagmi}-safe-builder-example`** — same app, different wallet provider. `wagmi` is the barest EOA-signer version; `privy`/`magic` show embedded-wallet provisioning.
- Key files across these: `hooks/useTradingSession.ts`, `useSafeDeployment.ts`, `useRelayClient.ts`, and `app/api/polymarket/sign/route.ts` (the remote-signing endpoint — **this is the pattern we extend with KMS**).
- **Security pattern to adopt:** *Proxy pattern* — our server makes all CLOB/Relay requests; credentials never reach any client. The Turnkey example explicitly stores builder creds server-side behind a remote signing endpoint.

### Tier 2 — specific subsystems to crib
- **`@iqai/mcp-polymarket`** (IQAIcom, npm, org-backed, recently maintained) — best **MCP tool surface** reference: how to decompose place-order / cancel / redeem / positions into MCP tools, and how to **conditionally register trading tools only when a signer is available**. Ignore its env-var private-key handling (that's the layer we replace).
- **`caiovicentino/polymarket-mcp-server`** (45 tools, Python) — copy the **risk-guardrail layer**: max order size, max total exposure, per-market position cap, min-liquidity floor, max-spread tolerance, confirm-above-threshold. Cleanest safety design in the ecosystem. Do NOT copy its "tests hit live APIs, no mocks" approach.
- **`whitmorelabs/polymarket-mcp`** — **pre-trade execution quality**: walks the CLOB order book for slippage estimation (returns best/avg fill price, slippage %, go/caution/no-go), liquidity depth grading (A/B/C), arbitrage detection. The part everyone else skips; important if the agent *decides* trades rather than just placing them. Also has a real metered-API-key billing layer if we ever expose our MCP to other agents for a fee.
- **`lord5et/polymarket-mcp`** (40+ tools, full trading) — use as an **endpoint checklist / API map** so we don't miss a tool to wrap. Code quality lower than IQAI; don't treat as a code model.

### Tier 3 — read-only / data layer
- **`aryankeluskar/polymarket-mcp`** — the most-used read-only server (≈50k tool calls/month on Smithery). Clean reference for Gamma + Data API query/filter patterns and shaping market data into LLM-friendly output. No trading, no auth → reliable. Good template for a "agent can read markets well" first milestone.
- **`berlinbra/polymarket-mcp`** — only 4 read tools; minimal Python stdio-server boilerplate. Mostly skip.
- **`agent-next/polymarket-paper-trader`** — paper-trading simulator with live order books + backtesting. Use as a **test harness** to exercise trading logic against simulated fills before pointing at a key that controls real USDC.

### Skip
- **`guangxiangdebizi/PolyMarket-MCP`** — "comprehensive" in README but 3 commits, `node_modules` checked in, prototype.
- `pab1it0` and various Smithery mirrors — repackaging of the above.

---

## 6. Suggested build order

1. **Read-only MCP** over Gamma + Data APIs (model on `aryankeluskar`). No keys, no risk. Validates our MCP tool plumbing and market-data shaping.
2. **KMS signer layer** — EOA key in KMS/enclave, expose a sign-on-request interface. Model the remote-signing endpoint on the Turnkey example's `app/api/polymarket/sign/route.ts`, swapping Turnkey for our KMS.
3. **Safe lifecycle via relayer** — derive deterministic deposit-wallet address, deploy if needed, set approvals, CTF ops. Use `safe-wallet-integration` `RelayClient`. Requires builder creds.
4. **Corrected POLY_1271 L1 auth** (§3 fix) in our auth layer. Gate everything downstream on this working; test against the paper-trader and then a small live wallet.
5. **Order tools** (place/cancel/redeem/positions) — tool surface from `@iqai/mcp-polymarket`.
6. **Risk guardrails** (from `caiovicentino`) + **pre-trade slippage/liquidity checks** (from `whitmorelabs`) wrapped *around* order placement, before any signature is requested from KMS.

---

## 7. Collateral: pUSD, USDC.e, native USDC — the on-ramp path

pUSD (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`) is the **only**
collateral token accepted for CLOB trading on Polymarket V2. It's an
ERC-20 wrapper on Polygon with 1:1 USDC backing enforced on-chain.

### Wrapping / unwrapping

| Contract | Address | Function |
|---|---|---|
| CollateralOnramp | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | `wrap(asset, recipient, amount)` — USDC.e → pUSD |
| CollateralOfframp | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` | `unwrap(asset, recipient, amount)` — pUSD → USDC.e |

**Gotcha:** approve the **Onramp contract** for your USDC.e spend, not
the pUSD contract. The Onramp pulls USDC.e from you and mints pUSD.

### What the Onramp accepts (confirmed on-chain 2026-06-03)

The `CollateralOnramp` contract (`0x93070a...`, verified, Solidity
0.8.34) accepts **both USDC.e and native USDC** via the same
`wrap(address _asset, address _to, uint256 _amount)` function. It
inherits `Pausable` with **per-asset pause** control by an admin.

On-chain test results (simulated `wrap()` calls):
- **USDC.e** (`0x2791Bca...`) → reverts `TransferFromFailed()` — got
  past the asset check, failed on the pull (expected: no balance).
  **Active / unpaused.**
- **Native USDC** (`0x3c499c5...`) → reverts `OnlyUnpaused()` — hit
  the pause guard before attempting the transfer. **Currently paused.**

So native USDC wrapping is **supported by the contract but admin-paused
as of 2026-06-03.** This could change at any time; worth re-checking
periodically or monitoring the unpause event.

### Funding paths from our MCP

All paths start from the user's funded USDC-on-Base scoped key.

**Path A — native USDC unpaused (simplest, not available today):**
1. USDC (Base) → NEAR Intents → native USDC (Polygon) at deposit wallet
2. `CollateralOnramp.wrap(nativeUSDC, depositWallet, amount)` → pUSD
3. Ready to trade

**Path B — native USDC paused (current state):**
1. USDC (Base) → NEAR Intents → native USDC (Polygon) at deposit wallet
2. Native USDC → USDC.e via DEX swap (Uniswap/QuickSwap, ~1:1)
3. `CollateralOnramp.wrap(USDC.e, depositWallet, amount)` → pUSD
4. Ready to trade

Gas considerations:
- Step 1: gasless (x402 facilitator covers Base gas)
- Step 2 (Path B only): needs POL for the DEX swap tx
- Step 3: can go through Polymarket's **relayer** (gasless) if the
  deposit wallet is a deployed Safe and the `wrap()` is packaged as
  a Safe `execTransaction`

### Recommendation

For MVP, **treat funding as the user's responsibility** (they use
Polymarket's UI or fund manually). The MCP handles market discovery,
order placement, and risk checks — not the collateral on-ramp.

For the auto-funding follow-up:
- Monitor native USDC unpause on the CollateralOnramp (Path A)
- If still paused, Path B needs a DEX aggregator integration and a
  POL gas source (or a gasless DEX like 0x/Paraswap with meta-txs)
- The wrap step can be gasless via the relayer once the Safe is deployed

---

## 8. Other open questions to resolve before/while building

- Has issue #70 been fixed upstream yet? Check for a merged PR before we hand-roll the 1271 auth fix. (As of 2026-06-03: open, unassigned.)
- Builder tier: do we need Verified throughput on day one? Start the application if so.
- Which SDK language for the core — TS (`@polymarket/clob-client-v2`), Python (`py-clob-client-v2`), or Rust (`rs-clob-client-v2`)? The auth bug affects Python + Rust confirmed; TS untested in the issue — worth checking whether TS has the same L1-auth gap before choosing.

---

## 9. Key source links

- Gasless / relayer docs: https://docs.polymarket.com/trading/gasless
- Deposit wallets: https://docs.polymarket.com/trading/deposit-wallets
- V2 migration: https://docs.polymarket.com/v2-migration
- Builder program overview: https://docs.polymarket.com/builders/overview
- The blocker (issue #70): https://github.com/Polymarket/py-clob-client-v2/issues/70
- Legacy EOA rejection (issue #51): https://github.com/Polymarket/py-clob-client-v2/issues/51
- Official safe integration: https://github.com/Polymarket/safe-wallet-integration
- Builder examples: https://github.com/Polymarket/turnkey-safe-builder-example (+ privy / magic / wagmi variants)
- Turnkey cookbook: https://docs.turnkey.com/cookbook/polymarket-builders
- Builder partner discounts (incl. Turnkey, Privy): https://builders.polymarket.com/partners