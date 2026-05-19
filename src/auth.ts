import { Database } from "bun:sqlite"
import { betterAuth } from "better-auth"
import { jwt, signJWT } from "better-auth/plugins/jwt"
import { mcp } from "better-auth/plugins"
import { env } from "./env.js"

const jwksConfig = {
  keyPairConfig: {
    alg: "RS256" as const,
    modulusLength: 2048, // required by Signet ZK circuit
  },
}

export const db = new Database(env.DATABASE_URL.replace(/^file:/, ""), { create: true })

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.PUBLIC_URL,
  basePath: "/api/auth",
  database: db,
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  plugins: [
    jwt({
      jwks: jwksConfig,
    }),
    mcp({
      loginPage: `${env.PUBLIC_URL}/login`,
    }),
  ],
})

/**
 * Mint an RS256 JWT for a user, cached for its lifetime.
 *
 * Each JWT is valid for 900s. We cache it so that multiple MCP requests
 * within that window reuse the same token — which means the session
 * manager's fingerprint-based cache also hits, avoiding redundant ZK
 * proof generation + /v1/auth round trips.
 */
const jwtCache = new Map<string, { token: string; expiresAt: number }>()

export async function mintJwtForUser(userId: string): Promise<string> {
  const cached = jwtCache.get(userId)
  if (cached && cached.expiresAt * 1000 > Date.now() + 60_000) {
    return cached.token
  }

  const ctx = await auth.$context
  const user = await ctx.internalAdapter.findUserById(userId)
  if (!user) throw new Error(`User ${userId} not found`)

  const now = Math.floor(Date.now() / 1000)
  const exp = now + 900
  const token = await signJWT({ context: ctx } as any, {
    options: { jwks: jwksConfig },
    payload: {
      sub: user.id,
      iat: now,
      exp,
      name: user.name,
      email: user.email,
    },
  })

  jwtCache.set(userId, { token, expiresAt: exp })
  return token
}
