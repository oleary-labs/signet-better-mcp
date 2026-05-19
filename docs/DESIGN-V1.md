# signet-better-mcp — v1 design (draft)

Working doc. Two questions to pin down before we touch tool code:

1. **What does the user-facing tool surface look like once scoped subkeys
   are the primary signing model?** (the missing spec)
2. **Which MCP-protocol affordances do we use to make the server pleasant
   for AI clients to drive correctly?** (the "skills / llms.txt equivalent"
   question)

The first is much bigger and informs the second, so spec first.

---

# Part 1 — Scoped subkeys are the primary signing model

## What exists today

The MCP server currently exposes a tool surface that mirrors a generic
EOA wallet: `create_key` mints an unscoped key, `sign_message` /
`sign_transaction` sign arbitrary hashes with it. That's a wallet-shaped
API. It's also the universal AI-agent footgun: a prompt-injected agent
with one of these tools can drain anything the key owns.

The Signet protocol and SDK *already* support a better model: **scoped
subkeys.** A subkey is created with a `scope` — a byte string with a
scheme-prefix that the protocol enforces on every sign. The node refuses
to sign anything the scope doesn't cover. This is enforced on every
participating node, not just the initiator, so a malicious node can't
unilaterally widen a key's authority.

The Signet protocol layer has two orthogonal dimensions on every key:

1. **Signing mode** — determined by whether the key was created with a
   scope. Set at keygen time, fixed for the key's lifetime.
2. **Curve / signature scheme** — determined by the `curve` field at
   keygen time. Selects which threshold signature algorithm runs and what
   shape of signature comes out.

Mixing these up is the source of most of the confusion in earlier drafts.
Treat them as independent: any (mode × curve) combination is in principle
possible; the v1 MCP surface picks one specific combination.

### Signing modes (determined by the key, not by the request)

| Mode | Sign request includes | Stored on the key | Node enforcement |
|---|---|---|---|
| Unscoped | `message_hash` (32 bytes hex) | no scope bytes | Rejects requests that include `payload`. Signs the raw hash. |
| Scoped | `payload: { scheme, typed_data }` | scope bytes (scheme + scheme-specific args) | Rejects requests that include `message_hash`. Validates the payload against the stored scope, computes the canonical hash itself, signs that. |

The two are mutually exclusive at the API level. A scoped key cannot be
talked into raw-hash signing; an unscoped key cannot be talked into
structured-payload signing. Every participating node independently
re-runs the scope check, so a malicious initiator can't broaden a key's
authority.

Scope formats currently defined in `signet-protocol/node/scope.go`:

| Scheme | Hex | Status | Format |
|---|---|---|---|
| Unscoped | `0x00` | implemented | (no scope bytes; key has empty Scope field) |
| EVM UserOp | `0x01` | reserved, NOT implemented | TBD — ERC-4337 UserOperation binding (per-account) |
| EIP-712 domain | `0x03` | implemented | `0x03 | chainId(8B BE) | verifyingContract(20B)` (29 bytes total) |

### Curves / signature schemes

A separate axis. Picked at keygen time, fixed for the key. Three valid
values:

| Curve | Algorithm | Verifier compatibility | Typical use |
|---|---|---|---|
| `frost_secp256k1` | FROST Schnorr on secp256k1 | BIP-340 style; NOT ecrecover-compatible | Bitcoin Taproot, off-chain Schnorr verifiers, default for legacy |
| `frost_ed25519` | FROST Ed25519 | Ed25519 verifiers | Solana, Cosmos, other Ed25519-native chains |
| `ecdsa_secp256k1` | Threshold ECDSA on secp256k1 | Standard `ecrecover`; works in any EVM contract | EVM signing — EIP-712, personal_sign, raw EVM tx, ERC-4337 |

For agent-facing scoped EIP-712 signing, the curve must be
`ecdsa_secp256k1` — the signatures get consumed by EVM contracts via
`ecrecover`, which only accepts ECDSA. A FROST Schnorr signature over
the same typed-data hash would be valid but unverifiable on-chain.

### Response shape (curve-dependent)

| Field | Present for | Format |
|---|---|---|
| `signature` | all curves | raw `R \|\| Z` bytes — protocol-native shape |
| `ethereum_signature` | `frost_secp256k1` only | 65 bytes: `R.x(32) \|\| z(32) \|\| v(1)` |
| `ecdsa_signature` | `ecdsa_secp256k1` only | 65 bytes: `r \|\| s \|\| v` — directly ecrecover-ready |

Callers should consume `ecdsa_signature` for EVM contract calls.
`signature` is the lowest-common-denominator field if you're handling
multi-curve generic code.

### Suffixes are not user-facing

The "key suffix" is the protocol's internal addressing handle for a
subkey within an identity's key namespace. For scoped keys the protocol
derives it deterministically from `sha256(scope_bytes)[:8]`. Users
should never type, see, or manage suffixes; they don't appear in the v1
MCP surface.

### Key hierarchy (parent → sub-keys → delegations)

Every Signet user has a tree of keys, even if they don't realize it.
This is forced by how delegation works at the protocol layer.

```
  PARENT KEY  (unscoped, ecdsa_secp256k1)
    │   - the user's primary Ethereum identity / address
    │   - signs delegation tokens (JWTs) for sub-keys
    │   - one per user, idempotently created on first session bootstrap
    │
    ├── SUB-KEY  (scoped: eip712, ecdsa_secp256k1)
    │     - bound to one (chainId, verifyingContract) pair
    │     - one per (chain × contract) the user wants to interact with
    │     - signs only EIP-712 messages whose domain matches the scope
    │     - this is the unit of authority handed to agents
    │
    └── SUB-KEY  (scoped: eip712, ecdsa_secp256k1)
          - e.g., USDC on Base
                ▲
                │   (optional)
                │
          DELEGATION TOKEN — a JWT signed by the parent key, scoped to
          a specific sub-key, with an expiry. Lets a peer agent (one
          that doesn't hold the user's OAuth JWT) authenticate to
          Signet directly and sign with that one sub-key.
```

Why both layers exist:

- An **unscoped parent key** is unavoidable. Delegation tokens are JWTs
  signed by the parent — the act of signing a delegation JWT is a
  raw-hash sign over the JWT's signing input. That requires the parent
  to be in raw-hash signing mode, which means **unscoped**. You can't
  delegate from a scoped key. So every user gets one parent.
- **Scoped sub-keys** are the safe unit of authority. They're what
  agents (or x402 payment flows) actually use to sign. The parent
  never signs application messages directly.
- **Delegation tokens** are a peer-handoff mechanism. Used when an
  agent runs *outside* this MCP server (e.g., a separate worker process,
  a CLI tool, a partner service) and needs to talk to Signet directly
  without the user's OAuth session. Not needed when the MCP server
  itself is the in-the-loop signer (see "How the MCP server uses this
  hierarchy" below).

The user-facing names are "your key" (parent) and "your scoped key for
X" (sub-keys). Curve and scope are implementation detail; the parent
being unscoped is implementation detail. None of those words need to
appear in tool descriptions or UI copy.

### Two ways a sub-key gets signed with

Critical distinction. The protocol supports two independent auth
paths for sub-key signing, with different trust assumptions:

| Path | Who uses it | How the Signet session is authed | Where it lives |
|---|---|---|---|
| **OAuth-session sign** | User (or anything holding the user's OAuth JWT) | ZK proof of the OAuth JWT → `/v1/auth`. Session can sign with ANY key under the user's identity (parent OR any sub-key). The protocol resolves which key from `iss:sub:suffix` in the canonical request hash. | The MCP server uses this path. |
| **Delegation sign** | Agent that doesn't hold the user's OAuth JWT | A delegation JWT signed by the parent key, naming a specific sub-key → `/v1/auth` with `delegation_token`. Session can only sign with that one sub-key. | External agents / background workers / partner services. Demo of "autonomy without the user present." |

The parent key's only application role is to **sign delegation JWTs**.
It never directly signs application messages (no permits, no
TransferWithAuthorizations, no userOps). And the parent is NOT
"required" to sign with sub-keys via the OAuth session — sub-keys are
their own threshold keys; the OAuth session authes the request, the
suffix in the canonical hash picks the key.

### How the MCP server uses this hierarchy

The MCP server is the user's trusted in-process proxy. It holds the
user's Better Auth JWT, so for in-chat tool calls it uses the
**OAuth-session sign** path for everything — `sign_eip712`,
`pay_x402_request`, `create_eip712_key`, the lot. No delegation in
the loop.

The lifecycle:

1. **First MCP request after login.** `SignetSessionManager` bootstraps
   a Signet session for the user (ZK proof of Better Auth JWT → /v1/auth).
2. **Implicit parent-key check.** Immediately after the session is
   established, the MCP server calls `keygen` with no suffix, no scope,
   `curve: "ecdsa_secp256k1"` — idempotent. If the parent already
   exists, the 409 path returns it; if not, DKG runs and we get a fresh
   parent. Either way the user's Ethereum address is now known.
3. **`create_eip712_key` / `disable_key` / `sign_eip712` /
   `pay_x402_request`** all run via the OAuth-session sign path.
4. **`mint_delegation` (tool call)** is the one place where the
   parent's signing role is actually invoked. The MCP server, via the
   user's OAuth session, asks Signet to threshold-sign a JWT with the
   parent key naming a specific sub-key. The resulting JWT is the
   credential the user hands to an external autonomous agent.

The "autonomous agent" demo path looks like:

```
User in Claude  ──→ MCP server ──→ Signet: mint_delegation
                                   for "USDC on Base" sub-key, 30 days
                                   ←── returns delegation JWT

User (out of band) hands the JWT to an autonomous worker process —
e.g. a scheduled script, a separate service, a CLI tool.

[hours later, user offline, Better Auth session expired]

Worker  ──→ Signet directly: /v1/auth with delegation_token
        ←── delegation-scoped session for the named sub-key
Worker  ──→ Signet: /v1/sign with EIP-712 payload
        ←── signed TransferWithAuthorization
Worker  ──→ x402-priced API → pays → gets data
```

The worker never needs the user, the user's OAuth provider, or this
MCP server. That's the demo of "agent function-without-the-user."

### MCP-level constraint: x402 / EIP-3009 only

The protocol scope on a sub-key is `(chainId, verifyingContract)` —
nothing finer. At the protocol layer, a "USDC on Base" scoped key can
threshold-sign *any* EIP-712 message whose domain points at the USDC
contract on Base. That includes:

- EIP-3009 `TransferWithAuthorization` — the x402 path. Authorizes
  ONE transfer of N tokens to a specific recipient. Single-shot.
- EIP-3009 `ReceiveWithAuthorization` — same, but only the recipient
  can submit.
- EIP-2612 `Permit` — grants a spender *allowance up to N* with no
  recipient bound. The classic "approve infinite, get drained" shape.
- Anything else USDC adds to its typed-data set in the future.

That's too wide for the v1 agent surface. We narrow it at the MCP
layer with a hard rule:

> **`sign_*` tools accept only `primaryType === "TransferWithAuthorization"`
> (EIP-3009).** Any other `primaryType` is rejected before the typed
> data ever reaches the Signet node, with a `wrong_primary_type` error
> telling the caller exactly what was attempted.

This is policy on top of the protocol scope, defense-in-depth:

- Protocol scope: "you can only sign for this contract on this chain."
- MCP policy:  "and only TransferWithAuthorization-shaped messages."

If a future use case needs Permit signing (e.g. "approve this DEX
router once, then use it many times"), it's a deliberate new tool with
its own consent surface and risk warning — not an opportunistic side
effect of x402 onboarding.

The x402 SDK builds exactly `TransferWithAuthorization` payloads (see
`signet-sdk/src/x402.ts::buildTransferAuthorization`), so this
constraint doesn't restrict the x402 demo at all. It only blocks the
sharp edges adjacent to it.

### Sub-key states are an explicit lifecycle

Beyond create / fund / use, sub-keys also have an **active / disabled**
status at the protocol layer. The Signet node refuses to sign with
disabled keys, refuses to mint delegations naming disabled sub-keys,
and refuses delegation-auth on disabled keys (parent or sub). So
`disable_key` is the universal kill switch:

- Compromised delegation token in the wild? Disable the underlying
  sub-key → every delegation that names it is instantly dead.
- Done with a sub-key? Disable it → no further surprises.
- Changed your mind? `enable_key` puts it back.

`disable_key` is a v1 tool. `delete_key` (irrecoverable) is not — too
easy to mis-call and too hard to recover from. Keep that one for
operator-only paths.

### Sub-key lifecycle: create → fund → use

A sub-key has on-chain consequences. Minting it gives you a fresh
Ethereum address with **zero balance** — it can produce technically-valid
signatures from day one, but counterparties (or x402 facilitators) will
reject them because the signed `from` address has no funds to transfer.

The full lifecycle:

| State | Means | Next step |
|---|---|---|
| **Created** | DKG ran, key exists across the group, address known. Balance = 0. Status = active. | User must fund the address with the asset the scope binds. Until then the key is inert. |
| **Funded** | On-chain balance of the scoped asset > 0 at the key's address. Status = active. | Ready to pay / sign. |
| **In use** | Signatures producing real transfers, balance drains over time. Status = active. | Refund when low, or retire. |
| **Drained / dormant** | Balance back to 0. Status = active. | Either top up or `disable_key`. |
| **Disabled** | Protocol-side flag flipped via `disable_key`. Signet refuses to sign or honor delegations against this key, regardless of who's asking. | `enable_key` to reactivate, or leave disabled. |

This forces explicit user discipline at two moments:

1. **Sub-key creation is a deliberate user action**, not an
   optimization the AI can sneak in. The user has to *intend* to mint a
   USDC-on-Base key — that intent commits them to managing a new
   balance going forward. Auto-creating a sub-key inside a busy chat
   ("looks like you need a key for X, I'll just make one") violates
   that consent surface and is explicitly forbidden by v1's design.
2. **Funding is the user's job, off-platform.** This MCP server doesn't
   help move tokens in. The agent can return funding instructions
   (address, asset, recommended amount, links), but the user moves the
   money via their existing wallet / exchange / whatever.

The MCP server has to be able to *see* funded state — not just "does
the key exist" but "does the key have a positive balance of the asset
its scope binds." That requires the MCP server to make read-only RPC
calls (`balanceOf` against the ERC-20). See open question §7 for the
env-config implications.

## What this means for the MCP tool surface

We want a **scope-first** surface. Concretely:

### Tools to remove

- `sign_message` in `raw_hash` mode — universal wallet-drain footgun. No
  scope, no preimage validation.
- `sign_message` in `personal_sign` mode — slightly safer, still
  unscoped. EIP-191 signatures are used as off-chain auth tokens by
  many apps; an agent that can sign arbitrary text is an agent that can
  impersonate the user against any service that does "Sign in with
  Ethereum." Removable.
- `sign_transaction` — the legacy EVM tx path requires the key to be
  *unscoped*. Until `0x01 EVMUserOp` lands, there's no scope-safe way to
  let an agent send arbitrary txs. So we remove it for now.
- `create_key` with no scope — unscoped keys are not part of the agent
  surface.
- `key_suffix` argument — never exposed.

### Tools to add

v1 surface is **scoped + ecdsa_secp256k1** only. Curve is not a
user-facing parameter; the tool is "I want to sign EIP-712 messages"
and the server picks `ecdsa_secp256k1` because that's what EVM
contracts can verify.

Parent-key creation is **implicit** — done by the MCP server when it
bootstraps a Signet session, not exposed as a tool. The agent never
sees it happen.

- **`list_keys`** *(read-only)*. Returns the user's parent key plus all
  scoped sub-keys, with their decoded scope, on-chain balance for the
  scoped asset, and lifecycle status. Output shape:
  ```
  {
    "parent": {
      "key_id":           "https://.../oauth:<sub>",
      "ethereum_address": "0xabc...",
      "kind":             "parent"           // unscoped, ecdsa_secp256k1
    },
    "scoped": [
      {
        "key_id":           "https://.../oauth:<sub>:<derived>",
        "ethereum_address": "0xdef...",
        "kind":             "scoped_eip712",
        "scope": {
          "chain_id":           8453,
          "verifying_contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "label":              "USDC on Base"   // optional, from registry
        },
        "balance": {
          "raw":     "1000000",          // smallest unit (e.g. 6-decimal USDC)
          "decimal": "1.0",              // human-readable
          "symbol":  "USDC",
          "as_of":   "2026-05-18T18:42:01Z"
        },
        "status": "funded"              // "created" | "funded" | "drained"
      },
      ...
    ]
  }
  ```
  The parent key is *always* present (it's auto-created on session
  bootstrap). Balance is fetched fresh via RPC per call. `status` is
  derived: `created` if balance == 0 and the key has never had a
  successful sign, `funded` if balance > 0, `drained` if balance went
  from > 0 back to 0 (we know via the audit log).

  v1 only surfaces sub-keys with the (`ecdsa_secp256k1` + `eip712`)
  shape; other curves / schemes would render as a different `kind`
  once added.

- **`create_eip712_key`** *(idempotent, write — requires explicit user
  consent via elicitation)*. Mints a new scoped subkey for **x402 /
  EIP-3009 payments** in one specific token on one specific chain. The
  protocol scope is `(chainId, verifyingContract)`; the MCP layer
  further restricts what this key will ever sign to
  `TransferWithAuthorization` (see "MCP-level constraint" above). Uses
  the `ecdsa_secp256k1` curve.

  This is a **deliberate user action**, not an optimization the AI
  invokes opportunistically. The MCP server's job here is to make sure
  the user understands what they're committing to before the key
  exists. Concretely:
  - The tool description tells the model "ask the user before calling
    this."
  - The handler elicits user confirmation before minting, surfacing
    the asset / chain / contract in plain language and reminding the
    user that the resulting key will need to be **funded** separately.
  - The agent must NOT call `create_eip712_key` automatically as a
    side effect of any other tool (e.g., `pay_x402_request` must not
    auto-mint missing keys — it must error out and let the user
    initiate creation explicitly).

  Takes:
  ```
  {
    "chain_id":           8453,
    "verifying_contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "label":              "USDC on Base"   // optional display hint, not on-chain
  }
  ```
  Internally:
  - Decodes the contract via the SDK's `CHAIN_PRESETS` to a friendly
    asset name (e.g. "USDC") for the elicitation prompt.
  - Elicits: "Create a Signet-managed key that can ONLY sign payments
    for `{asset}` on `{chainName}`? You'll get a new Ethereum address;
    funding it with `{asset}` is a separate step you do from your
    existing wallet. The key cannot sign anything else."
  - If declined → return structured error, do not mint.
  - If accepted → builds the 29-byte EIP-712 scope
    (`0x03 | chainId | contract`), calls `keygen` via the SDK with
    `scope` set and `curve: "ecdsa_secp256k1"` pinned (curve is **not**
    a user-facing parameter).
  - If a key with the same scope already exists for the user, returns
    the existing key (the SDK already handles 409).

  Returns:
  ```
  {
    "key_id":            "https://.../oauth:<sub>:<derived>",
    "ethereum_address":  "0xdef...",
    "already_existed":   false,
    "scope":             { "chain_id": 8453, "verifying_contract": "0x...", "label": "USDC on Base" },
    "funding": {
      "instructions":  "Send USDC on Base to 0xdef... from any wallet or exchange.",
      "asset":         "USDC",
      "chain_name":    "Base",
      "chain_id":      8453,
      "contract":      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "address":       "0xdef..."
    }
  }
  ```
  The `funding` block is the agent's prompt to the user: "your key
  exists, here's how to fund it." Surface it verbatim in the chat.

- **`sign_eip712`** *(destructive, write)*. Signs an **EIP-3009
  TransferWithAuthorization** typed-data payload using the scoped
  subkey whose scope matches `(domain.chainId,
  domain.verifyingContract)`.

  Despite the generic name, this tool is x402-shaped: it will reject
  any `typed_data` whose `primaryType` is not
  `"TransferWithAuthorization"`. That keeps the tool from being
  repurposed to sign Permit-shaped messages or anything else the
  scoped contract happens to expose.

  Takes:
  ```
  {
    "typed_data": {
      // Must be a full EIP-712 envelope:
      "domain":      { "name": "USD Coin", "version": "2", "chainId": 8453, "verifyingContract": "0x..." },
      "types":       { "TransferWithAuthorization": [...], "EIP712Domain": [...] },
      "primaryType": "TransferWithAuthorization",
      "message":     { "from": "0xdef...", "to": "0x...", "value": "10000",
                       "validAfter": "...", "validBefore": "...", "nonce": "0x..." }
    }
  }
  ```
  The MCP server:
  - Validates `primaryType === "TransferWithAuthorization"`. If not,
    returns a `wrong_primary_type` error. Does NOT forward to Signet.
  - Reads `domain.chainId` and `domain.verifyingContract` out of the
    typed data.
  - Looks up the matching scoped subkey for the user. If none exists,
    returns a `need_key` error with the (chainId, contract) the user
    must authorize via `create_eip712_key`.
  - Verifies `message.from` matches the sub-key's `ethereum_address`
    (otherwise the signature would be valid but for the wrong sender;
    return a `wrong_signer` error).
  - Calls `signTypedData` from the SDK, posting the full typed data as
    the `payload`. The node re-derives the EIP-712 hash from the typed
    data and the scope; we never compute the hash ourselves.
  - Returns:
    ```
    {
      "ecdsa_signature":   "0x..." ,    // 65-byte r||s||v — feed to ecrecover
      "signature":         "0x..." ,    // raw R||Z form
      "key_id":            "...",
      "ethereum_address":  "0xdef..."
    }
    ```
    Surfaces decoded message fields (from / to / value / validity
    window) in the elicitation prompt before signing.

- **`pay_x402_request`** *(destructive, write)*. The canonical use case
  driving this whole surface. Wraps the SDK's `x402Fetch` so the agent
  can hit an x402-priced API in one tool call instead of orchestrating
  402-parsing, key lookup, EIP-712 building, and signing itself. Takes:
  ```
  {
    "url":               "https://api.example.com/expensive-endpoint",
    "method":            "GET" | "POST" | ...,            // default GET
    "headers":           { ... },                          // optional
    "body":              "...",                            // optional
    "preferred_network": "eip155:8453"                     // default Base
  }
  ```
  Internally:
  - Calls the URL once unauthenticated.
  - If non-402, returns the response (no payment needed).
  - If 402: parses `payment-required`, finds the matching EVM payment
    option, looks up the user's scoped sub-key for that asset's
    `(chainId, verifyingContract)`. Then:
    - If no matching sub-key exists, returns a structured `need_key`
      error with the (chain_id, verifying_contract, asset, amount) the
      agent should ask the user to authorize via
      `create_eip712_key`. Does **not** auto-mint.
    - If the sub-key exists but its balance < the required `amount`,
      returns a structured `need_funding` error with the address and
      required top-up. Does **not** attempt to sign.
    - Otherwise builds an EIP-3009 `TransferWithAuthorization` typed
      message and signs via the same path as `sign_eip712`, retries
      with `Payment-Signature` header.

  Returns:
  ```
  {
    "status":         200,
    "headers":        { ... },
    "body":           "...",
    "paid":           true,
    "payment":        { "amount": "10000", "network": "eip155:8453", "asset": "0x..." }
  }
  ```

- **`disable_key`** *(destructive, idempotent, write — requires
  elicitation)*. Flips the protocol-side status of a sub-key to
  `disabled`. Signet then refuses to sign anything with the key and
  refuses to authenticate any delegation that names it — so this is
  the kill switch for a sub-key whose delegation token has leaked, or
  for a sub-key you're done with.

  Takes:
  ```
  {
    "key":    "0xdef..."           // ethereum_address from list_keys, OR a key_id
                                   // (parent_key cannot be disabled here; v1 rejects it)
    "reason": "compromised | retired | other"   // optional, audit-log only
  }
  ```
  Elicitation pattern: "Disable the {label} sub-key (0xdef...)? Any
  delegation tokens that name this key will stop working immediately.
  This is reversible — call enable_key later to reactivate."

  Returns `{ key_id, ethereum_address, status: "disabled" }`.

- **`enable_key`** *(write — light elicitation)*. Reverses
  `disable_key`. Same arguments, returns `{ ..., status: "active" }`.

- **`mint_delegation`** *(destructive, write — requires elicitation
  with a clear warning)*. Creates a delegation JWT signed by the
  user's parent key, naming a specific sub-key, with a bounded expiry.
  The returned JWT is a credential — anyone who holds it can sign with
  that one sub-key, no further auth required. This is the tool that
  enables the "autonomous agent" demo: the user mints a delegation,
  hands the JWT to an external worker / script / service, and that
  worker can act on the sub-key's behalf without the user being
  online.

  Takes:
  ```
  {
    "sub_key":          "0xdef...",           // ethereum_address or key_id
    "expires_in_hours": 24,                    // 1..720 (max 30 days)
    "purpose":          "feed-paying script"   // optional, audit-log only
  }
  ```
  Elicitation pattern: "Mint a delegation token for the {label}
  sub-key (0xdef...), valid for {expires_in_hours}h? Anyone holding
  this token can spend up to the key's full balance ({balance_human})
  during that window. The token cannot be limited per-payment — only
  the sub-key's scope and balance bound it. To revoke, call
  disable_key on the sub-key. Continue?"

  Returns:
  ```
  {
    "delegation_token": "eyJhbGc...",          // the JWT — credential, treat as secret
    "sub_key":          { "key_id": "...", "ethereum_address": "0xdef..." },
    "parent_key_id":    "...",
    "expires_at":       "2026-06-17T18:42:01Z"
  }
  ```
  The agent must surface this to the user as a credential, not
  silently store it. Recommended copy in the chat: "Here's the
  delegation token. Treat it like a password — anyone with it can
  sign with this key. You can revoke it any time by disabling the
  sub-key."

That's the v1 surface — seven tools:
1. `list_keys` — read-only inventory + balance + status.
2. `create_eip712_key` — explicit, consent-gated, returns funding info.
3. `disable_key` — kill switch (also revokes delegations).
4. `enable_key` — reverse of disable.
5. `sign_eip712` — low-level: sign typed data with the matching sub-key.
6. `pay_x402_request` — high-level: 402 dance + balance check + sign.
7. `mint_delegation` — hand a sub-key to an external autonomous agent.

All sub-key operations are on the (`ecdsa_secp256k1` + `eip712`)
combination. Parent key is read-only from the agent's perspective.

### What's NOT in v1 (deferred)

Each of these is a future axis on the (scope × curve) grid. None are in
the v1 MCP surface.

- **`sign_userop`** — pending protocol-side implementation of scheme
  `0x01 EVMUserOp`. (scope: `0x01`, curve: `ecdsa_secp256k1`). When the
  protocol lands the scheme, the MCP server gets a fifth tool that
  signs ERC-4337 user operations bound to a specific account. This is
  the right home for "let the agent send arbitrary on-chain
  transactions within bounded per-account limits" — the complement to
  x402 (which is value-out via off-chain authorization).
- **Non-EVM scoped signing** — e.g., Solana transaction binding
  (curve: `frost_ed25519`, scope: TBD). Needs both a new scope scheme
  in the protocol and a curve switch on the tool surface.
- **Schnorr scoped signing** — Bitcoin Taproot / off-chain Schnorr
  flows (curve: `frost_secp256k1`, scope: TBD). Same shape as above
  but secp256k1 / BIP-340.
- **Unscoped signing tools** — `sign_message` (personal_sign /
  raw_hash) and raw EVM tx signing on the parent key. Not coming back
  to the agent surface. The parent key exists and is reachable via the
  SDK from non-agent contexts (signet-ui, CLI), but MCP doesn't expose
  it as a signing tool.
- **`delete_key`** — irrecoverable. The protocol has
  `POST /v1/keys/delete` but exposing it as an MCP tool needs a
  much stronger consent flow than v1 provides. For now, `disable_key`
  covers "stop using this key" reversibly. Revisit once the consent
  story for irreversibles is solid.
- **`disable_key` on the parent** — v1 rejects it. Disabling the
  parent locks the user out of minting any future delegations and
  blocks all delegation-based agent paths. Operator-only territory.
- **`revoke_delegation` as a separate tool** — not needed. Disabling
  the underlying sub-key kills every delegation that names it,
  immediately and across all agents. That's the right primitive.
- **Multi-scope keys** — one key, one scope today. If a use case wants
  "this key can sign USDC permits AND DAI permits," we either model it
  as two keys (current answer) or extend the protocol with a multi-scope
  scheme. Defer until needed.
- **Other EIP-712 primaryTypes beyond TransferWithAuthorization.** The
  protocol scope is wide enough to cover EIP-2612 `Permit`, EIP-3009
  `ReceiveWithAuthorization`, Permit2 `PermitTransferFrom`, and
  arbitrary contract-specific typed data — but v1 hard-codes the
  policy filter to `TransferWithAuthorization` only. Adding a new
  primaryType is a deliberate new tool (e.g. `sign_permit`) with its
  own consent surface and a clear warning that allowance-shaped
  signatures are riskier than single-shot transfer authorizations.
- **`ReceiveWithAuthorization`** — same shape as
  `TransferWithAuthorization` but only the named recipient can submit.
  Useful for some x402 facilitators. Trivial to add later if the v1
  filter is broadened to accept it alongside `TransferWithAuthorization`.

## Open questions on the spec

1. **Parent key UX in `list_keys`.** Should the parent show up at all
   in the tool output? Pros: the model can answer "what's my Ethereum
   address?" without a separate tool. Cons: invites the model to ask
   "can you sign with the parent?" and we'd have to keep saying no.
   Recommendation: include it with `kind: "parent"` and write the tool
   description so it's clearly read-only-from-the-agent's-point-of-view.
2. **When does the parent key get created?** Two timings:
   - Eagerly, on the first `SignetSessionManager.getOrCreate()` for a
     user (i.e., the very first MCP request). Costs an extra DKG round
     on day 1. Idempotent on every later run.
   - Lazily, on the first `create_eip712_key` or `list_keys` call. Same
     work, slightly later.
   Recommendation: eager. Latency of the first tool call doesn't matter
   much (the user just connected) and it means `list_keys` can always
   show a meaningful parent.
3. **Should `pay_x402_request` auto-create the matching sub-key on
   demand?** Or should it strictly require the user to have run
   `create_eip712_key` first? Pros of auto-create: smoother UX, agent
   just says "pay this" and it works. Cons: hides the moment where a
   new long-lived key is minted. Recommendation: NO auto-create. If
   the agent encounters a 402 for an asset the user has no sub-key
   for, return a structured "need_key" error with the (chainId,
   contract) the agent should ask the user to authorize. The user-
   approves-new-key moment is a real consent surface; don't elide it.
4. **Where does the `label` for `create_eip712_key` live?** Two
   options:
   - Store it on the Better Auth user record (per-user key labels).
     Survives across MCP servers.
   - Store it nowhere; just echo it in the response and rely on the
     SDK's `CHAIN_PRESETS` for common contracts. Lighter.
   Recommendation: option 2. Add user-level labels only if users ask.
5. **`sign_eip712` failure mode when the key exists for a different
   verifying contract on the same chain.** Reject with a pointer at
   the specific scope mismatch. Don't silently "find a close-enough
   key."
6. **Do we want a `delete_key` tool?** Recommendation: no in v1. Keys
   on Signet are threshold material distributed across the group —
   "delete" is a coordinated wipe that should be a deliberate operator
   action, not an agent action.
7. **How does the MCP server fetch on-chain balances?** Required for
   the `balance` / `status` fields in `list_keys` and for the
   pre-flight check in `pay_x402_request`. Options:
   - Per-chain RPC URLs configured via env (e.g.
     `SIGNET_RPC_URLS='{"8453":"https://...","1":"https://..."}'`).
     Use viem's `readContract` against the ERC-20 `balanceOf`. Simple,
     adds one env knob per chain we support.
   - Use a multi-chain provider (Alchemy / QuickNode) with a single
     URL pattern. Fewer env knobs, vendor lock-in.
   - Get balances from the Signet node side (ask if it has any chain
     read APIs). Probably not — Signet is signer infrastructure, not
     an indexer.
   Recommendation: option 1 (per-chain env), cached for a few seconds
   so back-to-back `list_keys` calls don't hammer the RPC. Bake a
   sensible default for Base and Ethereum mainnet.

8. **`pay_x402_request` and HTTP semantics.** The tool runs HTTP from
   the MCP server, not the agent. That has security implications: the
   agent can ask the MCP server to GET arbitrary URLs. Mitigations:
   restrict to URLs that *return* 402 (so the tool is meaningless for
   non-payment use cases), enforce per-call timeout, log destinations.
   Worth pinning down before shipping.

9. **Elicitation frequency on `pay_x402_request`.** Eliciting every
   single payment kills autonomy; eliciting none of them is too much
   trust. Options:
   - Always elicit (safe, agent-unfriendly).
   - Elicit only above an amount threshold (e.g. > $1) — fast for
     micropayments, gate for material spend.
   - Elicit once per conversation, granting a session-bounded
     allowance afterward ("don't ask again under $X for this chat").
   Recommendation: amount-threshold elicitation, configurable, default
   threshold $1 equivalent. Refine after watching real usage.

10. **Should `sign_eip712` also accept `ReceiveWithAuthorization`?**
    Same EIP-3009 shape, same risk profile, but the recipient (not
    sender) submits. Some x402 facilitators prefer it. Recommendation:
    yes, broaden the filter to `{TransferWithAuthorization,
    ReceiveWithAuthorization}` in v1.1 once we hit a real facilitator
    that needs it. v1 stays narrower until we have a concrete use.

11. **Should the tools be renamed to be x402-specific?** Names like
    `sign_eip712` and `create_eip712_key` are technically accurate at
    the protocol layer but undersell the MCP-layer constraint. The
    agent reads "EIP-712" and may think the tool is general. Two
    alternatives:
    - Rename to `sign_payment_authorization` / `create_payment_key`
      — describes user intent, leaves room to broaden later.
    - Rename to `sign_x402_authorization` / `create_x402_key` —
      explicit about the protocol but couples names to a single use
      case (the keys could later sign other EIP-3009 variants).
    Recommendation: rename to `*_payment_*`. Defer the bikeshed; flag
    here so the tool descriptions can be written either way and
    swapped before v1 ships.

---

# Part 2 — MCP-protocol affordances ("skills / llms.txt equivalent")

MCP doesn't have a literal `llms.txt`. It has six knobs that, together,
do the same job: ambient context, document fetch, slash-style entry
points, risk hints, model-introspectable schemas, and confirmation
callbacks. None of these are wired up yet on this server.

In priority order for this codebase:

## 1. Server-level `instructions`

The `McpServer` constructor accepts an `instructions` string sent to the
client during the `initialize` handshake. The model sees it once when
the connection opens and uses it as ambient framing for every tool call.
This is the closest analog to a system prompt scoped to the server.

Draft content for ours:

```text
This server exposes scoped threshold-signing operations on the Signet
distributed key management network. The primary use case is x402
micropayments: signing EIP-712 TransferWithAuthorization messages so
agents can pay for HTTP APIs that require payment.

KEY MODEL
  Every user has one read-only parent key (their Ethereum identity)
  and zero-or-more scoped sub-keys. Each sub-key:
    - Is bound to one specific (chainId, verifying contract) pair —
      e.g., "USDC on Base."
    - Can ONLY sign EIP-3009 TransferWithAuthorization messages.
      Even if the contract supports other typed-data shapes (Permit,
      etc.), this server refuses to sign them. The point of these
      keys is x402-style payments, not general-purpose contract
      interaction.
    - Has its own Ethereum address.
    - Must be funded by the user (sending the scoped asset to that
      address from their own wallet / exchange) before payments work.
  This server cannot sign arbitrary hashes, off-chain auth tokens,
  raw EVM transactions, EIP-2612 Permits, Permit2 messages, or any
  EIP-712 payload whose primaryType is not "TransferWithAuthorization".

SUB-KEY LIFECYCLE — three states
  1. Created    — exists on Signet, address known, balance 0. Inert.
  2. Funded     — user has sent the scoped asset to the address.
                  Payments will work.
  3. Drained    — balance back to 0 after use. Top up or stop using.
  Surface this state to the user when relevant. list_keys returns it.

WHEN TO USE WHAT
  - list_keys           → "what keys does the user have, and are they
                          funded?" Shows balance + active/disabled
                          status per sub-key.
  - create_eip712_key   → first time the user wants to pay/sign for a
                          new (chain, contract). USER MUST EXPLICITLY
                          ASK FOR THIS — do not call it as a side
                          effect or "fix" for a missing key. Returns
                          funding instructions; surface them to the
                          user.
  - disable_key         → kill switch. Use when the user wants to
                          retire a sub-key OR when a delegation token
                          may have leaked. Reversible via enable_key.
  - enable_key          → undo disable.
  - sign_eip712         → low-level: caller already has typed data.
  - pay_x402_request    → high-level: hit an x402-priced URL. Handles
                          the 402 dance, balance check, and signing in
                          one call. Prefer this for "fetch / call this
                          paid API."
  - mint_delegation     → hand a sub-key off to an autonomous worker
                          that will run without the user present
                          (scheduled script, separate service). The
                          returned JWT is a credential. The user has
                          to explicitly ask for this; it is not part
                          of any other flow.

REFUSAL / ESCALATION PATTERNS
  - Asks to sign something not matching an existing scoped key →
    refuse, point at create_eip712_key with the specific (chainId,
    contract), and confirm the user wants to commit to a new key
    before calling it.
  - pay_x402_request returns need_key error → tell the user "this
    endpoint requires payment in {asset} on {chain}; do you want to
    create a key for that?" Do NOT auto-call create_eip712_key.
  - pay_x402_request returns need_funding error → tell the user
    "your {asset}-on-{chain} key needs another {amount}; here's the
    address to fund: 0x..." Do NOT retry until the user confirms
    funding.
  - sign_eip712 typed_data that decodes to authorizing a transfer to
    an unfamiliar recipient or an unusually large value → surface the
    decoded message (from, to, value) to the user BEFORE calling the
    tool, not after.
  - pay_x402_request asked to call a URL that has nothing to do with
    payments → run it once; if not 402, it just behaves as a fetch.
    Don't use it as a general-purpose HTTP client.
  - "Can I revoke this delegation?" → yes, call disable_key on the
    sub-key the delegation names. That instantly invalidates every
    delegation token that names it, across all agents.
  - "Can I delete this key?" → not in v1. Offer disable_key instead
    (reversible). Explain that delete is irrecoverable and isn't
    exposed here yet.
  - Asked to sign a Permit / Permit2 / SIWE message / arbitrary typed
    data → refuse. This server is x402/EIP-3009 only. Explain that
    those flows need different consent surfaces and aren't exposed.
```

## 2. Tool annotations

Every tool should declare its risk profile via `annotations`. Concrete
values for v1:

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|---|---|---|---|---|
| `list_keys` | true | false | true | false |
| `create_eip712_key` | false | false | true | false |
| `disable_key` | false | true | true | false |
| `enable_key` | false | false | true | false |
| `sign_eip712` | false | true | false | true |
| `pay_x402_request` | false | true | false | true |
| `mint_delegation` | false | true | false | false |

Claude Desktop already uses these to color the tool-call card and to
decide auto-approval. Set them honestly.

## 3. Sharper tool descriptions

The descriptions are what the model actually reads at call time.
Pattern: "when to use / when NOT to use / what comes back / cost."

Example for `create_eip712_key`:

```
Create a new scoped subkey that can ONLY sign EIP-712 typed messages for
one specific (chainId, verifying contract) pair. Use BEFORE the first
sign_eip712 call for that domain. Idempotent: if a key already exists
with this scope for the user, returns it. Cost: ~3-6 seconds, runs a
threshold key generation protocol across every Signet node in the group.
Returns: { ethereum_address, key_id, alreadyExisted }. Does NOT mint a
general-purpose key — see list_keys for what already exists.
```

## 4. Elicitation on `sign_eip712`

The MCP elicitation API lets a tool, mid-execution, ask the client to
prompt the user. This is the protocol-level home for "are you sure?":

```
sign_eip712 handler:
  - decode the typed message to a human-readable form
  - elicit({
      message: "Sign this <primaryType> on <chain>?\nContract: <contract>\nMessage:\n<rendered fields>",
      requestedSchema: { confirm: boolean }
    })
  - if not confirmed → return error content, don't call Signet
  - else proceed
```

The user gets a dialog from their own Claude/ChatGPT client. The model
can't talk its way past it. This is the right place for the treasury-
console guardrail; everything else (scope checking, allow-lists) is
defense in depth around it.

## 5. Resources

URI-addressable content the model can fetch on demand. Two we should
expose:

- `signet://group/info` — current group config (threshold, members,
  trusted issuers). Useful for the model to answer "what is this MCP
  connected to?" questions without us having to write a tool for it.
- `signet://docs/scoped-keys` — a markdown document explaining the
  scope model, listing known scope schemes, and pointing at example
  EIP-712 payloads for common contracts. This *is* the llms.txt
  equivalent: the model reads it when it needs deeper context than
  `instructions` provides.

Lower-priority but worth flagging:

- `signet://my/keys` — same data as `list_keys` but expressed as a
  resource. Some clients prefer resources for "ambient state I might
  want to glance at." Defer.

## 6. Prompts

User-invokable templates that surface in Claude's slash menu. Not the
same as tools — the user picks them deliberately. Good v1 candidates:

- `setup_eip712_signing` — "I want to sign typed messages for a
  specific contract" → walks chainId / contract entry, calls
  `create_eip712_key`, summarizes.
- `audit_my_keys` — `list_keys`, summarize per-key activity, flag
  scopes that look suspicious.

Defer until after instructions + annotations + elicitation land.

## 7. Structured output schemas

Newer SDK supports declaring an `outputSchema` on tools and returning
`structuredContent` rather than JSON-in-text. Worth adopting once the
v1 tool shapes are stable — gives the model a typed contract rather
than asking it to JSON-parse strings. Defer to phase 5.

---

# Implementation order

Strictly proposed; trim as you like.

1. **Spec sign-off on Part 1.** Agree on the v1 tool surface
   (`list_keys`, `create_eip712_key`, `disable_key`, `enable_key`,
   `sign_eip712`, `pay_x402_request`, `mint_delegation`), the
   parent-key lifecycle, the OAuth-session-vs-delegation split, and
   the open questions in §1. *No code yet.*
2. **Bootstrap the parent key in `SignetSessionManager`.** After the
   ZK proof + /v1/auth round succeeds, immediately call `keygen` with
   no suffix, no scope, `curve: "ecdsa_secp256k1"`. Cache the result
   on the session object so `list_keys` can show it without a re-query.

2a. **Add a per-chain RPC layer** (`src/chain/balance.ts` or similar).
   Reads `SIGNET_RPC_URLS` (JSON map of chainId → URL), exposes a
   `fetchERC20Balance(chainId, contract, holder)` helper backed by
   viem. Bake in a 5-second in-memory cache per (chainId, contract,
   holder) tuple so list_keys and pay_x402_request don't hammer RPC.
3. **Rewrite tool files** to the seven-tool surface. Drop
   `sign_message`, `sign_transaction`, the current `create_key`. Add
   `create_eip712_key`, `sign_eip712`, `pay_x402_request`,
   `disable_key`, `enable_key`, `mint_delegation`. Update
   `signet/client.ts` to expose:
   - `signTypedData` (SDK already has it in `scopedSign.ts`).
   - `disableKey` / `enableKey` (NOT in the SDK yet — wrap
     `POST /v1/keys/disable` and `POST /v1/keys/enable` directly,
     using the session-auth pattern from `request.ts`).
   - `requestDelegation` (already in the SDK).
   - Use `x402Fetch` for `pay_x402_request`.
   Critically, `create_eip712_key` must pass BOTH
   `curve: "ecdsa_secp256k1"` AND a non-empty `scope` (built via the
   SDK's `buildEIP712Scope`) to the keygen call — the protocol defaults
   curve to `frost_secp256k1` (Schnorr, not ecrecover-compatible),
   which is wrong for EVM signing.
4. **Server instructions** added to `buildMcpServer` (draft in §"1.
   Server-level `instructions`").
5. **Annotations** added to all four tools (table in §"2. Tool
   annotations").
6. **Elicitation** wired into:
   - `create_eip712_key` (mandatory) — asset/chain commitment + funding reminder.
   - `disable_key` (mandatory) — confirm the kill switch.
   - `mint_delegation` (mandatory, with strong warning) — surface
     "this is a credential, anyone holding it can sign with this
     key" before returning the JWT.
   - `sign_eip712` (mandatory) — decoded typed message preview.
   - `pay_x402_request` (above an amount threshold) — gate material spend.
   - `enable_key` (light, optional) — re-enabling is usually safe.
7. **Resources** for `signet://group/info`, `signet://my/keys` (live
   parent + sub-keys), and `signet://docs/scoped-keys`.
8. **Audit logging** of every call (who, what, decoded message,
   result). Treat `sign_eip712` and `pay_x402_request` calls as the
   source of truth for what the agent did on the user's behalf.
9. **Scope enforcement on the OAuth token.** Wire `session.scopes`
   into a wrapper that gates `create_eip712_key` behind
   `signet:keygen` and `sign_eip712` / `pay_x402_request` behind
   `signet:sign`.
10. **Prompts** for the common flows (`audit_my_keys`,
    `setup_for_x402_payments`).
11. **Structured output schemas** once shapes are stable.

# Things to delete in this codebase

Independent of the redesign:

- `src/signet/{crypto,canonicalHash,zk}.ts` — DEPRECATED stubs from the
  pre-SDK version of the scaffold. Already flagged in CONTEXT.md.
- `src/tools/sign.ts` (current contents — replaced by a new
  `sign_eip712.ts` after Part 1 is signed off).
- `src/tools/keygen.ts` (current contents — replaced by
  `create_eip712_key.ts`; parent-key creation moves into
  `SignetSessionManager`).
- `key_suffix` from any tool parameter, README, and CONTEXT.md.

# Pointers

- `signet-protocol/node/scope.go` — scope schemes + verification.
- `signet-protocol/node/handlers.go` — keygen + sign endpoints, `Scope`
  field handling, delegation-token auth path.
- `signet-sdk/src/scopedSign.ts` — `buildEIP712Scope`, `signTypedData`,
  `CHAIN_PRESETS`.
- `signet-sdk/src/keygen.ts` — pass `scope` to mint a scoped subkey;
  pass no scope + `ecdsa_secp256k1` to mint the parent.
- `signet-sdk/src/delegate.ts` — `requestDelegation` /
  `authenticateWithDelegation` for the peer-handoff path (NOT used by
  this MCP server in v1; documented here for context).
- `signet-sdk/src/x402.ts` — `x402Fetch`, `buildTransferAuthorization`,
  `parsePaymentRequired`. This is what `pay_x402_request` wraps.
- `signet-ui/src/app/demo/x402/page.tsx` — reference implementation of
  the full flow (parent → sub-key → delegation → x402 fetch).
- MCP server feature spec:
  https://modelcontextprotocol.io/specification/draft/server (tools,
  resources, prompts, elicitation, annotations).
- x402 spec:
  https://www.x402.org/
