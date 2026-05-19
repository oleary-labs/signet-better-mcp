import { z } from "zod"

const splitList = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

const EnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(1),
  DATABASE_URL: z.string().default("file:./data/auth.db"),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  SIGNET_GROUP_ID: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "SIGNET_GROUP_ID must be a 0x-prefixed 20-byte address")
    .transform((s) => s.toLowerCase()),
  SIGNET_NODE_URLS: z
    .string()
    .min(1)
    .transform(splitList)
    .pipe(z.array(z.string().url()).min(1, "at least one node URL required")),
  SIGNET_PROVER_URL: z.string().url(),
  SIGNET_BUNDLER_API_KEY: z.string().optional(),
  SIGNET_RPC_URLS: z
    .string()
    .default('{"8453":"https://mainnet.base.org"}')
    .transform((s) => JSON.parse(s) as Record<string, string>),

  PORT: z.coerce.number().int().positive().default(4100),
  PUBLIC_URL: z.string().url(),
})

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) {
  console.error("Invalid environment:")
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`)
  }
  process.exit(1)
}

export const env = parsed.data
