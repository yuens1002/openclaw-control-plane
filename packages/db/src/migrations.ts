import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Pool, PoolClient } from "pg";

export interface AppliedMigration {
  name: string;
  digest: string;
}

export async function runSqlMigrations(
  pool: Pool,
  migrationsDirectory: string
): Promise<AppliedMigration[]> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_plane_migrations (
      name text PRIMARY KEY,
      digest text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied: AppliedMigration[] = [];
  for (const name of names) {
    const sql = await readFile(join(migrationsDirectory, name), "utf8");
    const digest = createHash("sha256").update(sql, "utf8").digest("hex");
    await applyMigration(pool, { name, digest }, sql);
    applied.push({ name, digest });
  }
  return applied;
}

async function applyMigration(
  pool: Pool,
  migration: AppliedMigration,
  sql: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ digest: string }>(
      "SELECT digest FROM control_plane_migrations WHERE name = $1 FOR UPDATE",
      [migration.name]
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0]!.digest !== migration.digest) {
        throw new Error(`Migration ${migration.name} changed after it was applied.`);
      }
      await client.query("COMMIT");
      return;
    }

    await executeMigrationSql(client, sql);
    await client.query(
      "INSERT INTO control_plane_migrations (name, digest) VALUES ($1, $2)",
      [migration.name, migration.digest]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function executeMigrationSql(client: PoolClient, sql: string): Promise<void> {
  await client.query(sql);
}
