// Independent session/project fixture, exposing the compiled library over IPC.
// This is not a shipped management server or agent implementation.
import { randomUUID } from "node:crypto";
import {
  openFleetStore,
  createEnrollmentService,
  createCommandService,
} from "../packages/fleet-control-plane/dist/index.js";

const store = openFleetStore(process.env.C07_DATA);
let time = Number(process.env.C07_TIME);
store.database.exec(`CREATE TABLE IF NOT EXISTS c07_sessions (
  environment_id TEXT PRIMARY KEY,agent_id TEXT,session_id TEXT);
  CREATE TABLE IF NOT EXISTS c07_projects (
  project_id TEXT PRIMARY KEY,environment_id TEXT,local_id TEXT,online INTEGER,managed INTEGER);`);
let commands;
const enrollment = createEnrollmentService(store, {
  now: () => new Date(time),
  invalidateManagementAccess(database, environmentId) {
    commands.invalidateEnvironment(database, environmentId);
    database
      .prepare("DELETE FROM c07_sessions WHERE environment_id=?")
      .run(environmentId);
    return undefined;
  },
});
commands = createCommandService(store, {
  now: () => new Date(time),
  peers: {
    verifyAgent(database, identity) {
      enrollment.authenticate(identity);
      return !!database
        .prepare(
          "SELECT 1 FROM c07_sessions WHERE environment_id=? AND agent_id=? AND session_id=?"
        )
        .get(identity.environmentId, identity.agentId, identity.sessionId);
    },
    resolveTarget(database, projectId) {
      const row = database
        .prepare(
          `SELECT p.*,s.agent_id,s.session_id FROM c07_projects p
        JOIN c07_sessions s ON p.environment_id=s.environment_id WHERE project_id=?`
        )
        .get(projectId);
      return row
        ? {
            projectId,
            environmentId: row.environment_id,
            localProjectId: row.local_id,
            agentId: row.agent_id,
            sessionId: row.session_id,
            online: row.online === 1,
            managed: row.managed === 1,
            valid: true,
            supported: true,
          }
        : undefined;
    },
  },
});
async function dispatch(method, args) {
  switch (method) {
    case "initialize": {
      const token = await enrollment.createEnvironment({
        name: "C07 fault-injection host",
      });
      const agent = await enrollment.enroll({
        protocolVersion: 1,
        requestId: randomUUID(),
        token: token.token,
      });
      const identity = { ...agent, sessionId: randomUUID() };
      const projectId = randomUUID();
      store.transaction(() => {
        store.database
          .prepare("INSERT INTO c07_sessions VALUES (?,?,?)")
          .run(agent.environmentId, agent.agentId, identity.sessionId);
        store.database
          .prepare("INSERT INTO c07_projects VALUES (?,?,?,1,1)")
          .run(projectId, agent.environmentId, "prepared-folder");
      });
      return { identity, projectId };
    }
    case "clock":
      time = args[0];
      return null;
    case "offline":
      store.database
        .prepare("UPDATE c07_projects SET online=? WHERE project_id=?")
        .run(args[1] ? 0 : 1, args[0]);
      return null;
    case "reconnect": {
      const identity = { ...args[0], sessionId: randomUUID() };
      enrollment.authenticate(identity);
      store.database
        .prepare("UPDATE c07_sessions SET session_id=? WHERE environment_id=?")
        .run(identity.sessionId, identity.environmentId);
      return identity;
    }
    case "audits":
      return store.database
        .prepare(
          "SELECT operation,actor,target,outcome FROM audit_records ORDER BY id"
        )
        .all();
    case "revoke":
      return enrollment.revoke(...args);
    case "recover":
      commands.recover();
      return null;
    case "prune":
      return commands.prune();
    case "submit":
      return commands.submitCommand(...args);
    case "get":
      return commands.getCommand(...args);
    case "claim":
      return commands.claim(...args);
    case "result":
      return commands.publishResult(...args);
    case "transfer":
      return commands.transferOwnership(...args);
    case "close":
      return commands.closeUnresolved(...args);
    case "history":
      return commands.listCommands(...args);
    default:
      throw new Error("Unknown fixture method");
  }
}
process.on("message", async ({ id, method, args }) => {
  try {
    process.send({ id, value: await dispatch(method, args) });
  } catch (error) {
    process.send({
      id,
      error: { code: error.code ?? "fixture_error", message: error.message },
    });
  }
});
process.on("disconnect", () => {
  store.close();
  process.exit(0);
});
process.send({ ready: true });
