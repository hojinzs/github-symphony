import { randomUUID } from "node:crypto";
import type { FleetStore } from "../src/store.js";
import {
  createEnrollmentService,
  type AgentSessionCredential,
} from "../src/enrollment.js";
import type { CommandPeers, CommandTarget } from "../src/commands.js";

/** Independent peer tables; fixture owns enrollment and session/project truth. */
export async function commandPeers(store: FleetStore, now: () => Date) {
  const db = store.database;
  db.exec(`CREATE TABLE IF NOT EXISTS fixture_sessions (
    environment_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fixture_projects (
    project_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, local_id TEXT NOT NULL,
    managed INTEGER NOT NULL DEFAULT 1, online INTEGER NOT NULL DEFAULT 1,
    valid INTEGER NOT NULL DEFAULT 1, supported INTEGER NOT NULL DEFAULT 1);`);
  const enrollment = createEnrollmentService(store, {
    now,
    invalidateManagementAccess(database, environmentId) {
      database
        .prepare("DELETE FROM fixture_sessions WHERE environment_id = ?")
        .run(environmentId);
      return undefined;
    },
  });
  const token = await enrollment.createEnvironment({ name: "C07 host" });
  const enrolled = await enrollment.enroll({
    protocolVersion: 1,
    requestId: randomUUID(),
    token: token.token,
  });
  const identity: AgentSessionCredential = {
    ...enrolled,
    sessionId: randomUUID(),
  };
  db.prepare("INSERT INTO fixture_sessions VALUES (?,?,?)").run(
    identity.environmentId,
    identity.agentId,
    identity.sessionId
  );
  const peers: CommandPeers = {
    resolveTarget(database, projectId) {
      const row = database
        .prepare(
          `SELECT p.*,s.agent_id,s.session_id FROM fixture_projects p
        JOIN fixture_sessions s ON s.environment_id=p.environment_id WHERE project_id=?`
        )
        .get(projectId);
      if (!row) return undefined;
      return {
        projectId,
        environmentId: String(row.environment_id),
        localProjectId: String(row.local_id),
        agentId: String(row.agent_id),
        sessionId: String(row.session_id),
        managed: row.managed === 1,
        online: row.online === 1,
        valid: row.valid === 1,
        supported: row.supported === 1,
      } satisfies CommandTarget;
    },
    verifyAgent(database, candidate) {
      createEnrollmentService(
        { ...store, database },
        { now, invalidateManagementAccess: () => undefined }
      ).authenticate(candidate);
      return !!database
        .prepare(
          "SELECT 1 FROM fixture_sessions WHERE environment_id=? AND agent_id=? AND session_id=?"
        )
        .get(candidate.environmentId, candidate.agentId, candidate.sessionId);
    },
  };
  function project() {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO fixture_projects(project_id,environment_id,local_id) VALUES (?,?,?)"
    ).run(id, identity.environmentId, randomUUID());
    return id;
  }
  return { peers, identity, project, enrollment };
}
