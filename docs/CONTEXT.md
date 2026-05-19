# signet-better-mcp — handoff context

This document is the developer handoff for the MCP service skeleton in this
directory. It exists so the first engineer who picks this up doesn't have to
re-derive the design from chat scrollback.

## What this service is

An HTTP service that exposes Signet's threshold-signing operations (list
keys, run distributed key generation, sign messages, sign transactions) to
AI agents (Claude, ChatGPT, Cursor, etc.) over the Model Context Protocol.

Each end user connects an MCP client to this service via OAuth. From then on
the AI can call signing tools on the user's behalf within the scopes the
user approved.

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

## Sign safety — read this before exposing `sign_message` / `sign_transaction`

These tools can move funds. Treat them like a treasury console. Required
before turning them on for real users:

1. **Scope enforcement.** The Better Auth token's `scopes` must include
   `signet:sign` (or `signet:keygen` for `create_key`). This is NOT wired
   yet — the skeleton runs every tool on any valid token.
2. **Audit log.** Every tool call records `(timestamp, userId, tool, args
   summary, signet key_id, outcome)` to a persistent store. Build the
   weekly "what the agent did" digest before, not after, the first user.
3. **Pre-sign policy checks for `sign_transaction`:**
   - Chain allow-list.
   - Destination allow-list (per chain) OR per-day cumulative value cap.
   - Function-selector allow-list for contract calls (so the AI can't
     `approve(infinite, attacker)`).
   - Off-chain simulation (e.g., Tenderly or a local fork) and surface the
     simulation result back to the AI in the tool response, so the model has
     visibility into what it just authorized.
4. **`raw_hash` mode of `sign_message`.** Never expose this to AI agents.
   It signs an arbitrary 32-byte digest with no preimage validation, which
   is the universal "drain my wallet" footgun. Either remove that mode or
   gate it behind a separate `signet:sign-raw-hash` scope that's never
   granted in OAuth consent.
5. **`sign_message` personal_sign.** Safer than raw, but still trivially
   abused (sign an arbitrary string that's actually a serialized intent).
   Pair with a content policy: regex against the message before signing.

The skeleton does **none** of these. The tool descriptions are written so a
well-behaved AI reads them and understands the risk, but that's not a
defense.

## Scope model — bake in from day one

OAuth scopes for the Better Auth consent screen:

```
signet:read       list_keys
signet:keygen     create_key
signet:sign       sign_message (personal_sign mode), sign_transaction
signet:sign-raw   sign_message (raw_hash mode) — never grant from default consent
```

The skeleton does NOT enforce these. Wire `session.scopes` into a small
wrapper in `tools/index.ts` before adding any new caller.

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

## What's NOT in the skeleton

- No scope enforcement (every valid token can call every tool).
- No rate limiting.
- No audit logging.
- No pre-sign simulation or policy checks.
- No `sign_typed_data` (EIP-712) — the SDK has `signTypedData` in
  `scopedSign.ts`; wire it in when scoped keys are in scope.
- No delegation flow (the SDK has `requestDelegation` /
  `authenticateWithDelegation`). Useful for per-AI-agent sub-keys with
  bounded permissions; add when scopes need finer granularity than what
  OAuth scopes give.
- No tests. Add a `vitest` setup before the second tool round.
- ~~The stub files at `src/signet/{crypto,canonicalHash,zk}.ts`~~ Deleted.

## TODO — suggested order

1. ~~**Stand up Better Auth**~~ Done — runs in-process with JWT (RS256,
   RSA-2048), OIDC discovery, and MCP plugin.
2. **Add Better Auth as a trusted issuer** on the Signet group
   (`addIssuer(origin, [origin])`).
3. **Run a prover service** that exposes `/v1/prove`. Point
   `SIGNET_PROVER_URL` at it. This is the only piece that needs ZK
   tooling (nargo + bb).
4. **End-to-end smoke test.** Get a Better Auth JWT manually, hit `POST
   /mcp` with `list_keys`, confirm 200. Then `create_key`, confirm a key
   is returned. Don't wire Claude yet.
5. **Wire Claude / ChatGPT** by adding the MCP server URL in their
   client UI. The OAuth flow auto-redirects through Better Auth.
6. **Scope enforcement** wrapper. Block `create_key` and `sign_*` if the
   required scope isn't on the token. Update Better Auth consent UI to
   surface the scopes clearly.
7. **Audit log** to Postgres / Loki / your existing log pipeline.
8. **Pre-sign policy checks** for `sign_transaction`.
9. **Remove the `raw_hash` mode** of `sign_message` (or gate it).
10. ~~**Delete the obsolete stub files**~~ Done.

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
