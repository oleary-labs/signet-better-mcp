# signet-better-mcp

MCP server for [Signet](https://github.com/oleary-labs/signet-protocol).
Exposes Signet's threshold-signing API (list keys, generate keys, sign
messages, sign transactions) to AI agents over the Model Context Protocol.

[Better Auth](https://better-auth.com) runs in-process as the OAuth
authorization server — user signup/login (email+password, Google), JWT
issuance (RS256/RSA-2048 for Signet ZK), and the MCP OAuth flow (dynamic
client registration, authorize, token, consent).

**This is a skeleton.** See [`docs/CONTEXT.md`](./docs/CONTEXT.md) for the
full design — the OAuth/ZK auth flow, the ZK proof provider contract, the
scope model, and the ordered TODO list.

## Quick start

```
bun install
cp .env.example .env
# fill in BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#         SIGNET_NODE_URLS, SIGNET_GROUP_ID, SIGNET_PROVER_URL, PUBLIC_URL
bun dev
```

Server runs on `http://localhost:4100`.

`GET /healthz` for liveness. `POST /mcp` is the MCP endpoint. OAuth
discovery endpoints proxy to the Better Auth instance.

## Layout

```
src/
  index.ts            Hono entrypoint, MCP route, OAuth discovery proxies
  auth.ts             Better Auth server (JWT + MCP plugins, SQLite, Google + email/password)
  env.ts              Env validation (zod)
  server.ts           buildMcpServer(userId, jwt) factory
  signet/
    client.ts         SignetClient — typed wrapper around /v1/keys, /v1/auth, /v1/keygen, /v1/sign
    session.ts        SignetSessionManager — caches per-user Signet sessions, handles auth + re-auth
  tools/
    index.ts          registers all tools
    keys.ts           list_keys
    keygen.ts         create_key
    sign.ts           sign_message, sign_transaction
docs/
  CONTEXT.md          Handoff doc
```

## Stack

- **Bun, TypeScript, ESM**.
- **Hono** (Bun native serve).
- **`better-auth`** — runs in-process with JWT plugin (RS256/RSA-2048) and
  MCP plugin (OAuth flow). SQLite via `bun:sqlite`.
- **`@modelcontextprotocol/sdk`** (official MCP TS SDK).
- **`@oleary-labs/signet-sdk`** for all Signet protocol operations.
- **`viem`** for EVM transaction serialization.
- **`zod`** for env + tool input validation.

## What it does NOT do (yet)

- Does not generate ZK proofs in-process. The MCP server delegates proof
  generation to an external command (`ZK_PROVIDER_CMD`). See
  `docs/CONTEXT.md` → "ZK proof provider" for the interface.
- No scope enforcement, no rate limiting, no audit log.
- No transaction simulation before signing — `sign_transaction` will sign
  whatever it's handed. Wire in pre-sign safety checks before exposing
  this to real users.
