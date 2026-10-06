import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.js";
import { preparePersistence } from "./persistence.js";

export interface FleetStore {
  /** Peer persistence owners can transact on this same connection. */
  database: DatabaseSync;
  transaction<T>(operation: () => T): T;
  close(): void;
}
export function openFleetStore(dataDir: string): FleetStore {
  const path = preparePersistence(dataDir);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    applyMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }
  return {
    database,
    transaction<T>(operation: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        if (
          result &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          throw new Error(
            "Fleet transactions require synchronous database work"
          );
        }
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}
