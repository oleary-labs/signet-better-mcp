# signet-better-mcp

MCP server for [Signet](https://github.com/oleary-labs/signet-protocol).
Exposes scoped threshold-signing operations to AI agents over the Model
Context Protocol. Primary use case: **x402 micropayments** — signing
EIP-3009 `TransferWithAuthorization` messages so agents can pay for
HTTP APIs that require payment.

[Better Auth](https://better-auth.com) runs in-process as the OAuth
authorization server — user signup/login (email+password, Google), JWT
issuance (RS256/RSA-2048 for Signet ZK), and the MCP OAuth flow (dynamic
client registration, authorize, token, consent).

## Quick start

```
bun install
cp .env.example .env
# fill in BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#         SIGNET_NODE_URLS, SIGNET_GROUP_ID, SIGNET_PROVER_URL, PUBLIC_URL
bun dev
```

Server runs on `http://localhost:4100`.

- `GET /healthz` — liveness check
- `POST /mcp` — MCP endpoint (requires OAuth Bearer token)
- `GET /login` — login page (email/password + Google)
- `GET /.well-known/oauth-authorization-server` — OAuth discovery
- `GET /.well-known/openid-configuration` — OIDC discovery (for Signet prover)
- `GET /api/auth/*` — Better Auth routes

## Tools

Seven scope-first tools. All sub-key operations use `ecdsa_secp256k1` +
EIP-712 scoped keys. Parent key is read-only from the agent's perspective.

| Tool | Description | Risk |
|---|---|---|
| `list_keys` | Inventory + on-chain balance + active/disabled status | read-only |
| `create_payment_key` | Mint a scoped sub-key for (chainId, contract) | idempotent |
| `sign_payment` | Sign TransferWithAuthorization typed data | destructive |
| `pay_x402_request` | Full x402 dance: fetch → 402 → sign → retry | destructive |
| `disable_key` | Kill switch — blocks signing + delegations | destructive, idempotent |
| `enable_key` | Reverse disable | idempotent |
| `mint_delegation` | Create delegation JWT for autonomous agents | destructive |

## Key model

```
PARENT KEY  (unscoped, ecdsa_secp256k1)
  │   - user's Ethereum identity, auto-created on first connection
  │   - read-only from agent perspective
  │
  ├── PAYMENT KEY  (scoped: eip712, ecdsa_secp256k1)
  │     - bound to one (chainId, verifyingContract) pair
  │     - can ONLY sign TransferWithAuthorization (EIP-3009)
  │     - must be funded by user before payments work
  │
  └── PAYMENT KEY  (scoped: eip712, ecdsa_secp256k1)
        - e.g., USDC on Base
```

## Layout

```
src/
  index.ts              Hono entrypoint, MCP route, OAuth discovery, login page
  auth.ts               Better Auth server (JWT + MCP plugins, SQLite, Google + email/password)
  env.ts                Env validation (zod)
  server.ts             buildMcpServer factory + server instructions
  signet/
    client.ts           Signet node wrappers (sign, disable, enable)
    sessionManager.ts   Per-user session cache + parent key bootstrap
    keyStore.ts         SQLite CRUD for signet_keys table
  chain/
    balance.ts          ERC-20 balance fetching with caching (viem)
  tools/
    index.ts            Tool registration + ToolContext type
    list_keys.ts        list_keys
    create_payment_key.ts  create_payment_key
    sign_payment.ts     sign_payment
    pay_x402.ts         pay_x402_request
    disable_key.ts      disable_key
    enable_key.ts       enable_key
    mint_delegation.ts  mint_delegation
docs/
  CONTEXT.md            Architecture + handoff doc
  DESIGN-V1.md          V1 design spec (scoped keys, tool surface, MCP affordances)
```

## Stack

- **Bun** runtime with native SQLite
- **Hono** — HTTP framework (Fetch-native, no Node adapter needed for auth)
- **`better-auth`** — in-process OAuth server (JWT RS256/RSA-2048, MCP plugin)
- **`@modelcontextprotocol/sdk`** — official MCP TypeScript SDK
- **`@oleary-labs/signet-sdk`** — threshold signing, scoped keys, x402, delegation
- **`viem`** — ERC-20 balance reads, chain definitions
- **`zod`** — env + tool input validation

## Deployment

Dockerfile included (Bun runtime). Designed for Railway with persistent
disk for SQLite. See `.env.example` for production env var template.

## What's NOT done yet

- **Elicitation** — consent dialogs before destructive tool calls
- **Audit logging** — per-call recording of who/what/when
- **Scope enforcement** — gating tools behind OAuth scopes (`signet:sign`, `signet:keygen`)
- **MCP Resources** — `signet://group/info`, `signet://docs/scoped-keys`
- **Tests** — no vitest setup yet
