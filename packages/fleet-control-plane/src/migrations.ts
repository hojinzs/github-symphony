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
      CREATE TABLE lifecycle_commands (
        command_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        environment_id TEXT NOT NULL REFERENCES environments(id),
        local_project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('start', 'stop')),
        actor TEXT NOT NULL CHECK (actor = 'local-owner'),
        idempotency_key TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'executing', 'succeeded', 'failed', 'expired', 'unknown')),
        claimed_at TEXT,
        owner_agent_id TEXT,
        owner_session_id TEXT,
        completed_at TEXT,
        evidence TEXT,
        diagnostic TEXT,
        closed_at TEXT,
        closed_actor TEXT,
        closed_reason TEXT,
        UNIQUE (actor, idempotency_key),
        CHECK (
          (state IN ('accepted', 'expired') AND claimed_at IS NULL AND owner_agent_id IS NULL AND owner_session_id IS NULL)
          OR (state IN ('executing', 'succeeded', 'failed', 'unknown') AND claimed_at IS NOT NULL AND owner_agent_id IS NOT NULL AND owner_session_id IS NOT NULL)
        ),
        CHECK ((state IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
        CHECK (
          (closed_at IS NULL AND closed_actor IS NULL AND closed_reason IS NULL)
          OR (state = 'unknown' AND closed_at IS NOT NULL AND closed_actor = 'local-owner' AND length(trim(closed_reason)) > 0)
        )
      );
      CREATE UNIQUE INDEX lifecycle_project_fence ON lifecycle_commands(project_id)
        WHERE state IN ('accepted', 'executing') OR (state = 'unknown' AND closed_at IS NULL);
      CREATE INDEX lifecycle_environment_state ON lifecycle_commands(environment_id, state);
      CREATE INDEX lifecycle_project_history ON lifecycle_commands(project_id, submitted_at, command_id);
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
