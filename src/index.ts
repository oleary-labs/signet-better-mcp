import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { html } from "hono/html"
import { cors } from "hono/cors"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { toReqRes, toFetchResponse } from "fetch-to-node"
import { env } from "./env.js"
import { auth, db, mintJwtForUser } from "./auth.js"
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins"
import { buildMcpServer } from "./server.js"
import { SignetSessionManager } from "./signet/sessionManager.js"
import { initKeyStore } from "./signet/keyStore.js"

const app = new Hono()

app.use("*", cors())

// Process-lifetime session cache — survives across MCP requests so a single
// JWT generates the heavy ZK-proof + /v1/auth round trip only once.
const sessionManager = new SignetSessionManager()
sessionManager.setDatabase(db)

app.get("/healthz", (c) => c.json({ ok: true }))

// ---- Login page -------------------------------------------------------------
app.get("/login", (c) => {
  const callbackURL = c.req.query("callbackURL") || "/"
  return c.html(html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — Signet</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1.5rem; text-align: center; }
    label { display: block; font-size: 0.875rem; color: #a3a3a3; margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; background: #0a0a0a; border: 1px solid #333; border-radius: 6px; color: #e5e5e5; font-size: 0.875rem; margin-bottom: 0.75rem; }
    input:focus { outline: none; border-color: #555; }
    button { width: 100%; padding: 0.6rem; border: none; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; }
    .btn-primary { background: #e5e5e5; color: #0a0a0a; margin-bottom: 0.5rem; }
    .btn-primary:hover { background: #fff; }
    .btn-google { background: transparent; border: 1px solid #333; color: #e5e5e5; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
    .btn-google:hover { border-color: #555; }
    .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1rem 0; color: #555; font-size: 0.75rem; }
    .divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid #262626; }
    .error { background: #2d1111; border: 1px solid #5c2020; color: #f87171; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.8rem; margin-bottom: 0.75rem; display: none; }
    .toggle { text-align: center; margin-top: 1rem; font-size: 0.8rem; color: #a3a3a3; }
    .toggle a { color: #e5e5e5; text-decoration: underline; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1 id="title">Sign in</h1>
    <div class="error" id="error"></div>
    <form id="form">
      <div id="name-field" style="display:none">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" />
      </div>
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required minlength="8" />
      <button type="submit" class="btn-primary" id="submit-btn">Sign in</button>
    </form>
    <div class="divider">or</div>
    <button class="btn-google" id="google-btn">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.97 23.97 0 0 0 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Continue with Google
    </button>
    <div class="toggle" id="toggle">
      Don't have an account? <a onclick="toggleMode()">Sign up</a>
    </div>
  </div>
  <script>
    const API = "${env.PUBLIC_URL}/api/auth";
    const callbackURL = "${callbackURL}";
    let isSignUp = false;

    function toggleMode() {
      isSignUp = !isSignUp;
      document.getElementById("title").textContent = isSignUp ? "Sign up" : "Sign in";
      document.getElementById("submit-btn").textContent = isSignUp ? "Sign up" : "Sign in";
      document.getElementById("name-field").style.display = isSignUp ? "block" : "none";
      document.getElementById("toggle").innerHTML = isSignUp
        ? 'Already have an account? <a onclick="toggleMode()">Sign in</a>'
        : 'Don\\'t have an account? <a onclick="toggleMode()">Sign up</a>';
      document.getElementById("error").style.display = "none";
    }

    function showError(msg) {
      const el = document.getElementById("error");
      el.textContent = msg;
      el.style.display = "block";
    }

    document.getElementById("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      const name = document.getElementById("name").value;
      const endpoint = isSignUp ? "/sign-up/email" : "/sign-in/email";
      const body = isSignUp ? { email, password, name } : { email, password };
      try {
        const res = await fetch(API + endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          showError(data?.message || "Authentication failed");
          return;
        }
        window.location.href = callbackURL;
      } catch (err) {
        showError("Network error");
      }
    });

    document.getElementById("google-btn").addEventListener("click", async () => {
      try {
        const res = await fetch(API + "/sign-in/social", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "google", callbackURL }),
          credentials: "include",
        });
        const data = await res.json();
        if (data.url) window.location.href = data.url;
        else showError("Failed to start Google sign-in");
      } catch (err) {
        showError("Network error");
      }
    });
  </script>
</body>
</html>`)
})

app.get("/", (c) => c.html(html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signet MCP</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 12px; padding: 2rem; width: 100%; max-width: 420px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; }
    .info { font-size: 0.875rem; color: #a3a3a3; margin-bottom: 0.5rem; }
    .info strong { color: #e5e5e5; }
    .loading { color: #555; font-size: 0.875rem; }
    button { padding: 0.5rem 1rem; background: transparent; border: 1px solid #333; border-radius: 6px; color: #e5e5e5; font-size: 0.8rem; cursor: pointer; margin-top: 1rem; }
    button:hover { border-color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Signet MCP</h1>
    <div id="content"><span class="loading">Loading session...</span></div>
  </div>
  <script>
    (async () => {
      try {
        const res = await fetch("${env.PUBLIC_URL}/api/auth/get-session", { credentials: "include" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!data?.user) throw new Error();
        document.getElementById("content").innerHTML =
          '<div class="info"><strong>' + data.user.name + '</strong></div>' +
          '<div class="info">' + data.user.email + '</div>' +
          '<div class="info" style="margin-top:0.75rem;color:#555;font-size:0.75rem">User ID: ' + data.user.id + '</div>' +
          '<button onclick="signOut()">Sign out</button>';
      } catch {
        window.location.href = "/login";
      }
    })();
    async function signOut() {
      await fetch("${env.PUBLIC_URL}/api/auth/sign-out", { method: "POST", credentials: "include" });
      window.location.href = "/login";
    }
  </script>
</body>
</html>`))

// ---- Better Auth routes -----------------------------------------------------
app.all("/api/auth/*", (c) => auth.handler(c.req.raw))

// ---- OIDC discovery (needed by Signet prover to find JWKS) ------------------
app.get("/.well-known/openid-configuration", (c) =>
  c.json({
    issuer: env.PUBLIC_URL,
    jwks_uri: `${env.PUBLIC_URL}/api/auth/jwks`,
    id_token_signing_alg_values_supported: ["RS256"],
  }),
)

// ---- OAuth / MCP discovery --------------------------------------------------
const discoveryHandler = oAuthDiscoveryMetadata(auth)
const protectedResourceHandler = oAuthProtectedResourceMetadata(auth)
app.get("/.well-known/oauth-authorization-server", (c) => discoveryHandler(c.req.raw))
app.get("/.well-known/oauth-protected-resource", (c) => protectedResourceHandler(c.req.raw))

// ---- MCP endpoint -----------------------------------------------------------
// Stateless StreamableHTTP transport: each POST creates its own transport +
// McpServer. Bridge from Fetch → Node req/res via fetch-to-node because the
// MCP SDK uses Node http, not Fetch.
//
// We handle auth manually instead of using withMcpAuth because withMcpAuth
// generates a WWW-Authenticate URL under the /api/auth basePath, but the MCP
// spec requires resource_metadata at /.well-known/oauth-protected-resource
// on the resource server root.
const wwwAuthenticate = (error?: string) => {
  const params = [`Bearer realm="${env.PUBLIC_URL}"`]
  if (error) params.push(`error="${error}"`)
  params.push(`resource_metadata="${env.PUBLIC_URL}/.well-known/oauth-protected-resource"`)
  return params.join(", ")
}

app.post("/mcp", async (c) => {
  console.log("[mcp] incoming request")
  const authHeader = c.req.header("authorization") ?? ""
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : ""
  if (!token) {
    console.log("[mcp] no bearer token")
    return c.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": wwwAuthenticate(),
    })
  }

  console.log("[mcp] validating OAuth token...")
  const session = await auth.api.getMcpSession({ headers: c.req.raw.headers }).catch((e) => {
    console.error("[mcp] getMcpSession error:", e)
    return null
  })
  if (!session?.userId) {
    console.log("[mcp] invalid token, no session")
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": wwwAuthenticate("invalid_token"),
    })
  }
  console.log("[mcp] authenticated user:", session.userId)

  // Mint a real RS256 JWT for the authenticated user — the MCP OAuth access
  // token is opaque, but generateServerProof needs a proper JWT to produce
  // a ZK proof against the Signet group.
  console.log("[mcp] minting JWT...")
  let userJwt: string
  try {
    userJwt = await mintJwtForUser(session.userId)
  } catch (e) {
    console.error("[mcp] mintJwt error:", e)
    return c.json({ error: "failed to mint JWT" }, 500)
  }
  console.log("[mcp] JWT minted, bootstrapping session + parent key...")
  // Eagerly bootstrap Signet session + parent key on first request
  await sessionManager.getOrCreate({ userId: session.userId, jwt: userJwt })
  console.log("[mcp] session ready, forwarding to MCP server")

  const body = await c.req.json().catch(() => undefined)
  // Reconstruct the request with the already-consumed body so toReqRes
  // can pipe it into the Node IncomingMessage that the MCP SDK expects.
  const reqWithBody = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })
  const { req: nodeReq, res: nodeRes } = toReqRes(reqWithBody)
  const server = buildMcpServer({ userId: session.userId, jwt: userJwt, sessionManager, db })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  try {
    await server.connect(transport)
    await transport.handleRequest(nodeReq, nodeRes, body)
    return toFetchResponse(nodeRes)
  } finally {
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
})
app.on(["GET", "DELETE"], "/mcp", () => new Response(null, { status: 405 }))

// Run database migrations before accepting traffic
const ctx = await auth.$context
await ctx.runMigrations()
initKeyStore(db)

export default {
  fetch: app.fetch,
  port: env.PORT,
}

console.log(`signet-better-mcp listening on http://localhost:${env.PORT}`)
