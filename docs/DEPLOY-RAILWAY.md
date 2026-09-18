# Deploying to Railway (alpha)

The MCP server runs as the **`signet-mcp-alpha`** service in the Railway
project **`signet-platform`** (account `ops@oleary.com`), next to
`signet-min-bundler` and `signet-platform`. It must live in that project and
environment, because `SIGNET_PROVER_URL` uses the
`signet-min-bundler.railway.internal` private hostname, which only resolves
within the project's private network.

| | |
|---|---|
| Public URL | `https://signet-mcp.oleary.com` |
| Signet deployment | alpha, Ethereum mainnet (factory `0x86EB99D569AaD51c3160C5C50ec3093e6771c07a`) |
| Group | `0x641B8f6c932bE48084D6d28Fbb0be18A2410d753` (oll1–3, T=2) |
| Group manager | `0x00c1B5da8822fE11B1e2930112C73F581D5737FB` (Foundry keystore `signet-group-manager`) |
| Deploy source | GitHub `oleary-labs/signet-better-mcp`, branch `main` (autodeploys on push) |

The group has three nodes at T=2. ECDSA needs `2T-1 = 3` signers, so **every
node must be up** for a payment to sign.

The repo is build-ready:
- `Dockerfile` — Bun runtime, runs `bun src/index.ts`.
- `railway.toml` — pins the Dockerfile builder, `/healthz` healthcheck, and
  restart policy.

---

## Order matters

Do these in order. The last step is the one that bites:

1. Service, volume, variables (no source connected yet).
2. Custom domain + DNS.
3. Google OAuth client.
4. Connect the repo and deploy. **Confirm the OIDC discovery endpoint answers.**
5. Only then: `addIssuer` on the group.

Nodes run OIDC discovery for an issuer **once**, when they process the
`IssuerAdded` event (`signet-protocol/node/chain.go`). If the service isn't
serving `/.well-known/openid-configuration` at that moment, the node stores the
issuer with no JWKS URI and rejects every login with a bare
`401 {"error":"unauthorized"}` until it restarts. See
[Recovery](#recovery-nodes-loaded-the-issuer-before-the-service-was-live).

---

## 1. Create the service

With the CLI, from this repo (`railway link --project signet-platform`):

```sh
railway add --service signet-mcp-alpha \
  --variables "DATABASE_URL=file:/data/auth.db" \
  --variables "PUBLIC_URL=https://signet-mcp.oleary.com" \
  ...                                # see variables below
railway service link signet-mcp-alpha
railway volume add --mount-path /data
```

Creating it as an empty service (no repo) keeps it from crash-looping on
missing variables while you finish setup. `env.ts` exits on any missing
required variable.

Generate `BETTER_AUTH_SECRET` without echoing it. `railway add --variables`
prints values back, so set secrets separately:

```sh
railway variables --service signet-mcp-alpha --skip-deploys \
  --set "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" >/dev/null
```

### Persistent volume (required)

The container filesystem is ephemeral. The `/data` volume holds SQLite: users,
sessions, OAuth clients, JWKS keys, and the per-user key index. Without it
every redeploy wipes all of them, and **rotating the JWKS key changes the RSA
modulus the nodes verify against**.

### Variables

| Variable | Value | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | *(generated 32-byte hex)* | Secret. Also encrypts the JWKS private key at rest, so changing it breaks existing keys. |
| `DATABASE_URL` | `file:/data/auth.db` | Must point at the volume. |
| `PUBLIC_URL` | `https://signet-mcp.oleary.com` | Better Auth `baseURL`, **and the JWT `iss` and `aud`**. Must match the on-chain issuer exactly. |
| `PORT` | `4100` | Must equal the custom domain's target port (step 2). |
| `GOOGLE_CLIENT_ID` | *(from Google Cloud Console)* | |
| `GOOGLE_CLIENT_SECRET` | *(from Google Cloud Console)* | Secret. |
| `SIGNET_GROUP_ID` | `0x641b8f6c932be48084d6d28fbb0be18a2410d753` | |
| `SIGNET_NODE_URLS` | `https://oll1.nodes.oleary.com,https://oll2.nodes.oleary.com,https://oll3.nodes.oleary.com` | TLS endpoints. Never use `http://<ip>:8080`, which leaks session tokens. |
| `SIGNET_PROVER_URL` | `http://signet-min-bundler.railway.internal:4337/v1/prove` | Private hostname, only works inside this project. |
| `SIGNET_BUNDLER_API_KEY` | `${{signet-min-bundler.BUNDLER_PROVER_API_KEY}}` | Railway reference variable. Sent as `X-API-Key`. |
| `SIGNET_RPC_URLS` | `{"8453":"https://mainnet.base.org","5042":"https://rpc.mainnet.arc.io"}` | Optional. Base and Arc have built-in defaults. JSON map chainId→URL. |

**Why `PORT` is pinned.** When `railway domain` is given `--port`, Railway
routes the domain to that port. It also injects its own `PORT` if you don't set
one, and the app listens on `process.env.PORT`. Pin `PORT` to the same value as
the domain's target port so the two can't drift apart.

## 2. Public domain

```sh
railway domain signet-mcp.oleary.com --port 4100 --json
```

The output lists two DNS records to add in Cloudflare (`oleary.com` zone),
both **DNS only (grey cloud)**:

| Type | Name | Value |
|---|---|---|
| CNAME | `signet-mcp` | *(the `*.up.railway.app` target Railway prints)* |
| TXT | `_railway-verify.signet-mcp` | *(the `railway-verify=…` token Railway prints)* |

Cloudflare proxying in front of Railway's own TLS causes 522 errors.
`oleary.com` has a proxied wildcard record, so an unconfigured subdomain still
resolves and serves a page. That doesn't mean the name is taken. The specific
CNAME overrides the wildcard.

TLS (Let's Encrypt) is issued automatically once the TXT record verifies.

## 3. Google OAuth client

Signet platform OAuth clients are managed under **admin@oleary.com** in
[Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).

- Type: **Web application**.
- Authorized redirect URI:
  `https://signet-mcp.oleary.com/api/auth/callback/google`
  (Better Auth: `{baseURL}{basePath}/callback/google`, `basePath` = `/api/auth`).
- Authorized JavaScript origins: **not required**. The login page uses the
  redirect-based Authorization Code flow with a server-side secret.
- The OAuth consent screen must be **In production**, not Testing, or only
  listed test users can sign in.

The Google client ID does **not** go on the Signet group. Google's ID token
only authenticates the user to Better Auth. The nodes only ever see the MCP's
own RS256 JWT (`iss` = `aud` = `PUBLIC_URL`).

## 4. Connect the repo and deploy

```sh
railway service source connect --repo oleary-labs/signet-better-mcp \
  --branch main --service signet-mcp-alpha
```

Then verify, **before step 5**:

```sh
B=https://signet-mcp.oleary.com
curl $B/healthz                                   # {"ok":true}
curl $B/.well-known/openid-configuration          # issuer == PUBLIC_URL (nodes need this)
curl $B/.well-known/oauth-authorization-server    # MCP clients
curl $B/.well-known/oauth-protected-resource
curl $B/api/auth/jwks                             # RS256, 2048-bit modulus (ZK circuit requirement)
curl -i -X POST $B/mcp                            # 401 + WWW-Authenticate: Bearer resource_metadata=…
```

## 5. Trust the issuer on the group

Signed by the group manager, on Ethereum mainnet, **after step 4 passes**:

```sh
cast send 0x641B8f6c932bE48084D6d28Fbb0be18A2410d753 \
  "addIssuer(string,string[])" \
  "https://signet-mcp.oleary.com" '["https://signet-mcp.oleary.com"]' \
  --account signet-group-manager --rpc-url <mainnet rpc>
```

The client ID list holds the JWT `aud`, which Better Auth sets to the origin.
Confirm:

```sh
cast call 0x641B8f6c932bE48084D6d28Fbb0be18A2410d753 \
  'getIssuers()((string,string[])[])' --rpc-url <mainnet rpc>
```

Nodes poll chain events every 60s. Wait about 90s, then sign in from an MCP
client and call any tool. Success in the service logs looks like:

```
[session] parent key: 0x… (new DKG) — user=… iss=https://signet-mcp.oleary.com
```

That line means the whole path worked: Better Auth JWT → `generateServerProof`
(bundler over `railway.internal`) → `/v1/auth` on the nodes → keygen.

---

## Recovery: nodes loaded the issuer before the service was live

Symptom: the service logs show

```
All bootstrap nodes rejected auth: https://oll1…: 401 — {"error":"unauthorized"} …
```

and `addIssuer` was mined before the service answered
`/.well-known/openid-configuration`. Compare the `IssuerAdded` block time with
the deploy time.

Fix, either way:
- **Restart `signetd`** on oll1–3, one at a time. The nodes also serve SFLuv's
  group, which tolerates exactly one node down. At startup each node re-reads
  issuers with `getIssuers()` and redoes discovery.
- **Remove and re-add the issuer** (two manager transactions, no node access
  needed):
  ```sh
  cast send <group> "removeIssuer(bytes32)" $(cast keccak "https://signet-mcp.oleary.com") ...
  cast send <group> "addIssuer(string,string[])" "https://signet-mcp.oleary.com" '["https://signet-mcp.oleary.com"]' ...
  ```

A node-side fix is in progress in signet-protocol: retry discovery when
`JwksURI` is empty, rather than rejecting.

## Redeploys

Push to `main` → autodeploy. Migrations run on boot (`ctx.runMigrations()` in
`src/index.ts`). The volume persists across deploys.

**Changing `PUBLIC_URL` is a migration, not a redeploy.** It changes the JWT
issuer, so it needs `addIssuer` for the new URL (and `removeIssuer` for the
old). Every user's Signet identity (`oauth:<iss>:<sub>`) changes too, which
means new parent and payment keys at new addresses. Funds on the old addresses
stay under the old identity.
