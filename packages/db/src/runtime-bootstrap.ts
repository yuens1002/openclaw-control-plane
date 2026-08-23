import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { PostgresEventStore } from "./event-store.js";
import { runSqlMigrations } from "./migrations.js";
import {
  exampleOperationRegistrations,
  exampleTypeRegistrations,
  legacyTypeRegistrations,
  legacyOperationRegistrations,
  runtimeTypeRegistrations,
  RuntimeTypeRegistry
} from "./runtime-registry.js";
import {
  PostgresRuntimeRepository,
  type RuntimeReadiness
} from "./runtime-repository.js";

export interface PostgresRuntime {
  eventStore: PostgresEventStore;
  repository: PostgresRuntimeRepository;
  readiness: () => Promise<RuntimeReadiness>;
  close: () => Promise<void>;
}

export async function initializePostgresRuntime(
  databaseUrl: string,
  migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url))
): Promise<PostgresRuntime> {
  if (!databaseUrl.trim()) throw new Error("DATABASE_URL must not be empty.");
  const pool = new Pool({ connectionString: databaseUrl });
  const registry = new RuntimeTypeRegistry(
    [...runtimeTypeRegistrations, ...legacyTypeRegistrations, ...exampleTypeRegistrations],
    [...legacyOperationRegistrations, ...exampleOperationRegistrations]
  );
  const repository = new PostgresRuntimeRepository(pool, registry);

  try {
    await runSqlMigrations(pool, migrationsDirectory);
    await repository.synchronizeRegistry();
    const readiness = await repository.readiness();
    if (
      readiness.database !== "ready" ||
      readiness.migrations !== "ready" ||
      readiness.registry !== "ready"
    ) {
      throw new Error(`Runtime startup readiness failed: ${JSON.stringify(readiness)}`);
    }
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    eventStore: new PostgresEventStore(pool),
    repository,
    readiness: () => repository.readiness(),
    close: () => pool.end()
  };
}
