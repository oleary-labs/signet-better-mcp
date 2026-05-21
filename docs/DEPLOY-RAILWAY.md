# Deploying to Railway (GitHub-connected)

This service deploys as a **GitHub-connected service inside the existing
Railway project** that already runs the UI and the bundler. It must live in
that same project + environment, because `SIGNET_PROVER_URL` uses the
`signet-min-bundler.railway.internal` private hostname, which only resolves
within the project's private network.

Deploy source: **GitHub repo `oleary-labs/signet-better-mcp`, branch `main`**.
Every push to `main` autodeploys (same model as the UI/bundler).

The repo is already build-ready:
- `Dockerfile` — Bun runtime, runs `bun src/index.ts`.
- `railway.toml` — pins the Dockerfile builder + `/healthz` healthcheck +
  restart policy.

---

## 1. Create the service (dashboard)

In the existing Railway project:

1. **New → GitHub Repo →** `oleary-labs/signet-better-mcp`.
2. **Service → Settings → Source:**
   - Branch: `main`
   - Root directory: `/` (repo root)
3. **Settings → Build:** confirm builder is **Dockerfile** (auto-detected from
   `railway.toml`). No build command needed.

## 2. Persistent volume (REQUIRED — SQLite lives here)

The container filesystem is ephemeral. Without a volume, every redeploy wipes
all users, sessions, OAuth clients, and JWKS keys.

1. **Service → Settings → Volumes → New Volume**
2. Mount path: **`/data`**
3. Attach to this service.

Then set `DATABASE_URL=file:/data/auth.db` (see variables below).

## 3. Environment variables

**Service → Variables.** Set these:

| Variable | Value | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | *(generated 32-byte hex)* | Generate with `openssl rand -hex 32`. Secret — never commit. |
| `DATABASE_URL` | `file:/data/auth.db` | Must point at the mounted volume from step 2. |
| `PUBLIC_URL` | `https://signet-testnet-auth.olearylabs.com` | The public custom domain (step 5). Used as Better Auth `baseURL`. |
| `GOOGLE_CLIENT_ID` | *(from Google Cloud Console)* | |
| `GOOGLE_CLIENT_SECRET` | *(from Google Cloud Console)* | Secret. |
| `SIGNET_GROUP_ID` | `0x…` | Group contract address, 20-byte hex. |
| `SIGNET_NODE_URLS` | `http://54.90.227.156:8080,http://44.214.181.89:8080,http://44.205.254.164:8080` | Comma-separated bootstrap nodes. |
| `SIGNET_PROVER_URL` | `http://signet-min-bundler.railway.internal:4337/v1/prove` | Private hostname — only works inside this project. |
| `SIGNET_BUNDLER_API_KEY` | *(optional)* | Set if the bundler requires it. |
| `SIGNET_RPC_URLS` | `{"8453":"https://mainnet.base.org"}` | Optional; this is the default. JSON map chainId→URL. |

**Do NOT set `PORT`.** Railway injects it automatically and the app reads
`process.env.PORT`. Setting it manually can break ingress routing.

## 4. Private networking sanity check

`SIGNET_PROVER_URL` reaches the bundler over Railway's private network. Confirm:
- The bundler service listens on port **4337** on its private interface
  (Railway private networking requires binding to IPv6 `::` / `[::]:4337`).
- This service and the bundler are in the **same environment**.

No config needed on this service for outbound private calls — just verify the
bundler side is reachable.

## 5. Public domain

1. **Service → Settings → Networking → Custom Domain**
2. Add `signet-testnet-auth.olearylabs.com`.
3. Add the **CNAME** record Railway shows you to the `olearylabs.com` DNS zone.
   If the zone is on Cloudflare, set the record to **DNS only (grey cloud)** —
   Cloudflare proxying in front of Railway's own TLS causes 522 errors.
4. Wait for the cert to provision (TLS is automatic).

`PUBLIC_URL` must exactly match this domain.

## 6. Google OAuth redirect (do BEFORE first sign-in)

In **Google Cloud Console → APIs & Services → Credentials →** the OAuth client,
set the **Authorized redirect URI**:

`https://signet-testnet-auth.olearylabs.com/api/auth/callback/google`

(Path comes from Better Auth: `{baseURL}{basePath}/callback/google`, where
`basePath` is `/api/auth`.)

**Authorized JavaScript origins are NOT required.** The login page uses the
redirect-based Authorization Code flow — the browser is redirected to Google
and the code is exchanged server-side with the client secret. JS origins only
matter for Google's browser SDK (Identity Services / One Tap / `gapi`), which
this service does not use.

---

## 7. Verify after deploy

```sh
# health
curl https://signet-testnet-auth.olearylabs.com/healthz
# -> {"ok":true}

# OAuth discovery (MCP clients hit these)
curl https://signet-testnet-auth.olearylabs.com/.well-known/oauth-authorization-server
curl https://signet-testnet-auth.olearylabs.com/.well-known/oauth-protected-resource

# OIDC config (prover uses this to find JWKS)
curl https://signet-testnet-auth.olearylabs.com/.well-known/openid-configuration

# JWKS — must be RS256 with a 2048-bit modulus (Signet ZK circuit requirement)
curl https://signet-testnet-auth.olearylabs.com/api/auth/jwks
```

Then load `https://signet-testnet-auth.olearylabs.com/login`, sign in with
email+password and with Google, and confirm an MCP client can complete the
OAuth flow against `/mcp`. The first authenticated `/mcp` call exercises the
full path: mint JWT → `generateServerProof` → bundler over
`…railway.internal:4337` → `/v1/auth` against the configured group.

## Redeploys

Push to `main` → autodeploy. Migrations run automatically on boot
(`ctx.runMigrations()` in `src/index.ts`). The volume persists across deploys.
