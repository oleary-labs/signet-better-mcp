# signet-better-mcp — handoff context

This document is the developer handoff for the MCP service skeleton in this
directory. It exists so the first engineer who picks this up doesn't have to
re-derive the design from chat scrollback.

## What this service is

An HTTP service that exposes scoped threshold-signing operations to AI
agents (Claude, ChatGPT, Cursor, etc.) over the Model Context Protocol.
Primary use case: **x402 micropayments** — signing EIP-3009
`TransferWithAuthorization` messages so agents can pay for HTTP APIs.

Each end user connects an MCP client to this service via OAuth. The server
creates a parent key (the user's Ethereum identity) and scoped sub-keys
for specific (chainId, contract) pairs. Sub-keys can ONLY sign
`TransferWithAuthorization` — no arbitrary hashes, no Permits, no raw txs.

See [`DESIGN-V1.md`](./DESIGN-V1.md) for the full v1 design spec.

This service is the Better Auth server AND the MCP server in one process:

- **Better Auth** runs in-process as the OAuth authorization server. It issues
  RS256 JWTs, handles user signup/login (email+password, Google), and provides
  the MCP OAuth flow (dynamic client registration, authorize, token, consent).
- **The Signet group** is configured to trust this service as an OAuth issuer
  (the group contract has `(issuer, [client_id])` registered).
- **`@oleary-labs/signet-sdk`** does the heavy lifting: ephemeral keypair
  generation, ZK proof generation via a remote prover service, /v1/auth
  bootstrap, request signing, /v1/keygen, /v1/sign.
- **The MCP layer** wires those together, using `withMcpAuth` to validate
  Better Auth Bearer tokens on each call and caching the resulting Signet
  session for the lifetime of that token.

## Goals

1. **Per-user OAuth.** Each user authorizes specific MCP clients to specific
   scopes. The MCP service never has unilateral access.
2. **Reuse the SDK.** Nothing crypto-shaped lives in this repo. All of it is
   in `@oleary-labs/signet-sdk`. Bugs get fixed once, in one place.
3. **Safe by default.** Read tools (`list_keys`) are open; signing tools
   (`sign_message`, `sign_transaction`) and `create_key` need scope checks
   and audit logging before going to real users — see "Sign safety" below.

## Non-goals

- Not replacing any user-facing app's own auth.
- Not implementing the AI client.
- Not running the ZK prover. Proof generation is delegated to a separate
  service via `SIGNET_PROVER_URL`. The SDK's `generateServerProof()` POSTs
  `{ jwt, session_pub }` and expects a JSON response with `{ proof, sub, iss,
  exp, aud, azp, jwks_modulus, session_pub }`. The prover service is what
  runs noir + bb.

## Stack

| Choice | Why |
|---|---|
| Bun, TypeScript, ESM | Fast runtime with native SQLite support for Better Auth's database. |
| Hono | Tiny, framework-agnostic. Better Auth's `auth.handler` is Fetch-native so it mounts directly. |
| `better-auth` (server) | Runs in-process: user auth (email+password, Google), JWT issuance (RS256/RSA-2048), MCP OAuth flow. |
| `better-auth/plugins` (`jwt`, `mcp`) | JWT plugin for JWKS + RS256 tokens. MCP plugin for OAuth discovery, dynamic client registration, authorize/token/consent. |
| `@modelcontextprotocol/sdk` (official) | Reference MCP implementation. |
| `@oleary-labs/signet-sdk` | All Signet-protocol-shaped code lives here. We depend via `file:../signet-sdk`. |
| `viem` | Transaction serialization + hashing for `sign_transaction`. |
| `zod` | Env + tool input validation. |

## Architecture

```
            ┌──────────────────────────────────────────────┐
            │  signet-better-mcp (this service)            │
            │                                              │
 AI client →│  /api/auth/*    Better Auth server           │
 (Claude)   │                 - email+password, Google     │
            │                 - RS256/RSA-2048 JWTs        │
            │                 - JWKS at /api/auth/jwks     │
            │                 - SQLite database             │
            │                                              │
            │  /mcp           MCP endpoint                 │
            │                 - withMcpAuth(auth, handler)  │
            │                 - sessionManager.getOrCreate  │
            │                     generates session keypair │
            │                     calls prover for ZK proof │
            │                     authenticateWithBootstrap  │
            │                 - tool calls reuse session    │
            │                                              │
            │  /.well-known/  OAuth + OIDC discovery       │
            └────┬──────────┬──────────────────────────────┘
                 │          │
                 │          │ keygen + sign requests, signed with session key
                 ▼          ▼
       ┌────────────┐  ┌──────────────────┐
       │ Signet     │  │ ZK prover        │  /v1/prove
       │ nodes      │  │ (separate svc;   │  takes (jwt, session_pub)
       │ /v1/auth,  │  │  runs noir + bb) │  returns proof + claims + modulus
       │ /v1/keygen,│  └──────────────────┘
       │ /v1/sign,  │
       │ /v1/keys   │
       └────────────┘
```

## Better Auth setup

Better Auth runs in-process in `src/auth.ts`. It's configured with:

- **JWT plugin** issuing **RS256** with **RSA-2048** modulus. The Signet ZK
  circuit (jwt_auth) is hardcoded for RSA-2048; smaller or different
  algorithms will not verify.
- **MCP plugin** providing OAuth 2.1 flow for AI clients: dynamic client
  registration (`/mcp/register`), authorize (`/mcp/authorize`), token
  (`/mcp/token`), and consent (`/oauth2/consent`).
- **SQLite database** (via Bun's native `bun:sqlite`) for users, sessions,
  OAuth applications, access tokens, and consent records.
- **Social providers**: Google. Email+password also enabled.

Better Auth does **not** ship an OIDC discovery document. The Signet prover
fetches `{iss}/.well-known/openid-configuration` to find the JWKS URI. This
is handled by a custom Hono route in `src/index.ts`.

See `signet-sdk/docs/better-auth-integration.md` for the full setup including
the on-chain `addIssuer` call.

## On-chain group setup

The Signet group contract must trust Better Auth as an OAuth issuer:

```bash
cast send <GROUP_ADDRESS> "addIssuer(string,string[])" \
  "<BETTER_AUTH_ORIGIN>" '["<BETTER_AUTH_ORIGIN>"]' \
  --rpc-url <RPC_URL> --private-key <KEY>
```

The issuer URL is your Better Auth origin (e.g. `https://app.example.com`).
The audience array contains the `aud` claim your Better Auth JWTs use — by
default also your origin.

## Session caching

`SignetSessionManager` caches Signet sessions keyed by `(userId, jwt
fingerprint)`. This matters because the per-session cost is:

- One ephemeral secp256k1 keypair (cheap).
- One ZK proof generation via the remote prover (~2–7s depending on the
  prover's hardware).
- One round of /v1/auth fan-out across the bootstrap nodes (network).

After a session is established, every keygen/sign call within its lifetime
is a single signed HTTP POST.

The cache is process-local. For multi-replica deploys you have two options:

1. Accept that each replica builds its own session per user — extra one-time
   cost per replica per JWT lifetime.
2. Externalize the session cache (Redis) — but then you also need to
   externalize the *session private key*, which is sensitive. Don't do this
   without thinking through the threat model first.

For v0, option 1 is fine.

## Sign safety

The v1 tool surface is scope-first by design. All unsafe tools from the
original skeleton (`sign_message`, `sign_transaction`, `raw_hash` mode)
have been removed. The agent can only sign `TransferWithAuthorization`
(EIP-3009) messages through scoped sub-keys. See `DESIGN-V1.md` for the
full rationale.

Remaining safety work:
- **Elicitation** — consent dialogs before destructive tool calls
- **Scope enforcement** — gate tools behind OAuth scopes
- **Audit logging** — per-call recording

## Scope model (not yet enforced)

```
signet:read       list_keys
signet:keygen     create_payment_key
signet:sign       sign_payment, pay_x402_request
signet:delegate   mint_delegation
signet:manage     disable_key, enable_key
```

## Open questions

1. ~~**Where does Better Auth run?**~~ **Resolved**: in-process, same
   service. Auth routes at `/api/auth/*`, MCP OAuth at `/mcp/*`.
2. **One Signet group, or many?** This skeleton targets exactly one group
   (`SIGNET_GROUP_ID` env). To target multiple groups, the env becomes a
   map and tools take a `group_id` parameter. Defer until needed.
3. **Identity = `iss:sub`, or a Better-Auth-internal user ID?** The SDK
   derives the Signet key_id from `claims.iss:claims.sub` by default. Since
   Better Auth's `sub` is its own stable user ID, this maps cleanly:
   `<better-auth-origin>:<better-auth-user-id>`. Good enough for v0.
4. **What happens when a Better Auth token is refreshed?** The new JWT has
   a different signature → new fingerprint → SignetSessionManager rebuilds
   the Signet session (new keypair + new ZK proof + new /v1/auth round).
   The old session sits in cache until evicted by `expiresAt`. We could
   tighten this with explicit eviction; not urgent.
5. **Dynamic Client Registration policy on Better Auth.** Open for
   `signet:read`; allow-list (or human-review) for any signing scope.
6. **Multi-replica session cache.** Default-deny until someone needs it.

## What's NOT done yet

- No elicitation (consent dialogs before destructive tool calls).
- No scope enforcement (every valid token can call every tool).
- No rate limiting.
- No audit logging.
- No tests.

## TODO — suggested order

1. ~~**Stand up Better Auth**~~ Done.
2. ~~**Add Better Auth as trusted issuer**~~ Done (testnet).
3. ~~**Run prover service**~~ Done (signet-min-bundler on Railway).
4. ~~**End-to-end smoke test**~~ Done — list_keys, create_payment_key,
   pay_x402_request all verified via Claude.
5. ~~**Wire Claude**~~ Done — OAuth flow works via ngrok / production URL.
6. ~~**V1 tool surface**~~ Done — 7 scope-first tools with annotations.
7. ~~**Remove unsafe tools**~~ Done — sign_message, sign_transaction,
   raw_hash mode all removed. Only TransferWithAuthorization signing.
8. **Elicitation** — consent dialogs on destructive tool calls.
9. **Audit logging** — per-call recording to DB.
10. **Scope enforcement** — gate tools behind OAuth scopes.
11. **Deploy to Railway** — persistent disk for SQLite, custom domain.
12. **Tests** — vitest setup.

## Pointers into the wider stack

- Signet SDK: `/Users/pauloleary/code/oleary-labs/signet-sdk` — start with
  `src/index.ts` (barrel exports), then `docs/better-auth-integration.md`.
- Signet protocol (Go nodes + Solidity contracts):
  `/Users/pauloleary/code/oleary-labs/signet-protocol` — for understanding
  what's happening on the node side; you shouldn't need to modify it.
- The SFLUV MCP server uses a similar MCP pattern (without signing) —
  `/Users/pauloleary/code/SFLuv/mcp/`.

## Pointers out

- MCP plugin (Better Auth): https://better-auth.com/docs/plugins/mcp
- OAuth Provider plugin (replacement coming):
  https://better-auth.com/docs/plugins/oauth-provider
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP authorization spec:
  https://modelcontextprotocol.io/specification/draft/basic/authorization
- Signet design docs (in signet-protocol/docs/): DESIGN-ZK-AUTH.md,
  SECURITY-ANALYSIS.md, DESIGN-BARRETENBERG-WASM-GO.md.
