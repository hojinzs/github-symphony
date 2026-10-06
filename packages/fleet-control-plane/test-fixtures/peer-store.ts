import type { DatabaseSync } from "node:sqlite";
import type {
  RevocationInvalidator,
  SessionVerifier,
} from "../src/enrollment.js";

/** Independent peer-owned schema; C04 never assumes these table names. */
export function attachPeerStore(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS fixture_sessions (
      environment_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT PRIMARY KEY, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS fixture_commands (
      environment_id TEXT NOT NULL, id TEXT PRIMARY KEY, state TEXT NOT NULL
    );
  `);
  const invalidate: RevocationInvalidator = (transaction, environmentId) => {
    transaction
      .prepare(
        "UPDATE fixture_sessions SET revoked = 1 WHERE environment_id = ?"
      )
      .run(environmentId);
    transaction
      .prepare(
        "UPDATE fixture_commands SET state = 'expired' WHERE environment_id = ? AND state = 'accepted'"
      )
      .run(environmentId);
    return undefined;
  };
  const verifySession: SessionVerifier = (transaction, identity) =>
    Boolean(
      transaction
        .prepare(
          "SELECT session_id FROM fixture_sessions WHERE environment_id = ? AND agent_id = ? AND session_id = ? AND revoked = 0"
        )
        .get(identity.environmentId, identity.agentId, identity.sessionId)
    );
  return { invalidate, verifySession };
}
