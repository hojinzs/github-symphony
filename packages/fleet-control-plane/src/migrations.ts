import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  sql: string;
}
export const FLEET_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE environments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enrollment TEXT NOT NULL CHECK (enrollment IN ('pending', 'enrolled', 'revoked')),
        connection TEXT NOT NULL CHECK (connection IN ('awaiting-signal', 'online', 'offline')),
        last_contact_at TEXT
      );
      CREATE TABLE enrollment_tokens (
        environment_id TEXT PRIMARY KEY REFERENCES environments(id),
        verifier TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE agent_credentials (
        environment_id TEXT PRIMARY KEY REFERENCES environments(id),
        agent_id TEXT NOT NULL UNIQUE,
        verifier TEXT NOT NULL UNIQUE
      );
      CREATE TABLE audit_records (
        id INTEGER PRIMARY KEY,
        actor TEXT NOT NULL,
        target TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_id TEXT,
        occurred_at TEXT NOT NULL,
        outcome TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE agent_sessions (
        environment_id TEXT PRIMARY KEY REFERENCES environments(id),
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT -1,
        agent_version TEXT NOT NULL,
        hostname TEXT NOT NULL,
        os TEXT NOT NULL CHECK (os IN ('linux', 'darwin'))
      );
    `,
  },
];

/** A whole migration batch and its schema version commit together. */
export function applyMigrations(
  database: DatabaseSync,
  migrations = FLEET_MIGRATIONS
): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1)
      throw new Error("Fleet migrations must be contiguous from version 1");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("PRAGMA user_version").get()!;
    const version = Number(row.user_version);
    if (version > migrations.length)
      throw new Error("Fleet database schema is newer than this service");
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
