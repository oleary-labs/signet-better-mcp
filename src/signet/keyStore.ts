import type { Database } from "bun:sqlite"

/**
 * "retired" marks a sub-key whose scope predates the method-bound (0x03,
 * 61-byte) format. The nodes recompute the scope from the payload and derive a
 * different key suffix, so such a key can never sign again. The row is kept
 * rather than deleted: it is the only record of an address that may hold funds.
 */
export type KeyStatus = "active" | "disabled" | "retired"

/** Hex length of a method-bound 0x03 scope: "0x" + 61 bytes. */
const SCOPE_HEX_LENGTH = 2 + 61 * 2

export interface StoredKey {
  id: string
  user_id: string
  ethereum_address: string
  group_public_key: string
  curve: string
  scope: string | null
  scope_chain_id: number | null
  scope_contract: string | null
  label: string | null
  kind: "parent" | "scoped_eip712"
  status: KeyStatus
  created_at: string
}

export function initKeyStore(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS signet_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ethereum_address TEXT NOT NULL,
      group_public_key TEXT NOT NULL,
      curve TEXT NOT NULL,
      scope TEXT,
      scope_chain_id INTEGER,
      scope_contract TEXT,
      label TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_signet_keys_user ON signet_keys(user_id)`)
  retireLegacyScopes(db)
}

/**
 * Retire sub-keys stored with a pre-method-binding scope. Idempotent, and
 * deliberately non-destructive — create_payment_key mints a replacement at a
 * new address, and the retired row keeps the old address visible in list_keys.
 */
export function retireLegacyScopes(db: Database): number {
  const { changes } = db.run(
    `UPDATE signet_keys SET status = 'retired'
      WHERE kind = 'scoped_eip712' AND status != 'retired'
        AND (scope IS NULL OR length(scope) != ?1)`,
    [SCOPE_HEX_LENGTH],
  )
  if (changes > 0) {
    console.log(`[keystore] retired ${changes} sub-key(s) with a pre-method-binding scope`)
  }
  return changes
}

export function upsertKey(db: Database, key: Omit<StoredKey, "created_at">) {
  db.run(
    `INSERT INTO signet_keys (id, user_id, ethereum_address, group_public_key, curve, scope, scope_chain_id, scope_contract, label, kind, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(id) DO UPDATE SET
       ethereum_address = excluded.ethereum_address,
       group_public_key = excluded.group_public_key,
       status = excluded.status`,
    [
      key.id,
      key.user_id,
      key.ethereum_address,
      key.group_public_key,
      key.curve,
      key.scope,
      key.scope_chain_id,
      key.scope_contract,
      key.label,
      key.kind,
      key.status,
    ],
  )
}

export function getKeysByUser(db: Database, userId: string): StoredKey[] {
  return db
    .query("SELECT * FROM signet_keys WHERE user_id = ?1 ORDER BY kind, created_at")
    .all(userId) as StoredKey[]
}

export function getKeyByAddress(db: Database, address: string): StoredKey | null {
  return (
    db.query("SELECT * FROM signet_keys WHERE ethereum_address = ?1").get(address) as StoredKey | null
  )
}

/**
 * Find a usable sub-key for a scope. Retired rows are skipped, so
 * create_payment_key mints a replacement instead of handing back a key the
 * nodes will refuse to sign with.
 */
export function getKeyByScope(
  db: Database,
  userId: string,
  chainId: number,
  contract: string,
): StoredKey | null {
  return (
    db
      .query(
        `SELECT * FROM signet_keys
          WHERE user_id = ?1 AND scope_chain_id = ?2 AND scope_contract = ?3
            AND status != 'retired'`,
      )
      .get(userId, chainId, contract.toLowerCase()) as StoredKey | null
  )
}

/** Retire one key by id — used when a stored scope disagrees with the current format. */
export function retireKey(db: Database, keyId: string) {
  db.run("UPDATE signet_keys SET status = 'retired' WHERE id = ?1", [keyId])
}

export function updateKeyStatus(db: Database, keyId: string, status: "active" | "disabled") {
  db.run("UPDATE signet_keys SET status = ?1 WHERE id = ?2", [status, keyId])
}
