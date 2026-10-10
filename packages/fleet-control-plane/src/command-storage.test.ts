import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, FLEET_MIGRATIONS } from "./migrations.js";

describe("command ledger storage", () => {
  it("upgrades C04 storage without losing enrollment or audit records", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, FLEET_MIGRATIONS.slice(0, 1));
      db.exec(
        "INSERT INTO environments VALUES ('env', 'Host', 'enrolled', 'online', NULL)"
      );
      db.exec(
        "INSERT INTO audit_records (actor,target,operation,occurred_at,outcome) VALUES ('local-owner','env','environment.create','2026-10-09','success')"
      );
      applyMigrations(db);
      applyMigrations(db);
      expect(db.prepare("SELECT name FROM environments").get()).toEqual({
        name: "Host",
      });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM audit_records").get()
      ).toEqual({ n: 1 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM lifecycle_commands").get()
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("enforces actor idempotency and project fence including unresolved unknown", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      db.exec(
        "INSERT INTO environments VALUES ('env', 'Host', 'enrolled', 'online', NULL)"
      );
      const insert = db.prepare(`INSERT INTO lifecycle_commands
        (command_id,project_id,environment_id,local_project_id,session_id,operation,actor,idempotency_key,submitted_at,expires_at,state)
        VALUES (?,?,'env','folder','session','start','local-owner',?,'2026-10-09T11:00:00Z','2026-10-09T11:00:30Z','accepted')`);
      insert.run("first", "project", "key");
      expect(() => insert.run("second", "other", "key")).toThrow(/UNIQUE/);
      expect(() => insert.run("second", "project", "other-key")).toThrow(
        /UNIQUE/
      );
      db.exec(
        "UPDATE lifecycle_commands SET state='unknown',claimed_at='2026-10-09T11:00:01Z',owner_agent_id='agent',owner_session_id='session'"
      );
      expect(() => insert.run("second", "project", "other-key")).toThrow(
        /UNIQUE/
      );
      db.exec(
        "UPDATE lifecycle_commands SET closed_at='2026-10-09T11:01:00Z',closed_actor='local-owner',closed_reason='insufficient evidence'"
      );
      insert.run("second", "project", "other-key");
      expect(
        db
          .prepare(
            "SELECT state,closed_reason FROM lifecycle_commands WHERE command_id='first'"
          )
          .get()
      ).toEqual({ state: "unknown", closed_reason: "insufficient evidence" });
    } finally {
      db.close();
    }
  });

  it("rejects unclaimed unknown, incomplete terminal records and false closure", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      db.exec(
        "INSERT INTO environments VALUES ('env', 'Host', 'enrolled', 'online', NULL)"
      );
      db.exec(`INSERT INTO lifecycle_commands
        (command_id,project_id,environment_id,local_project_id,session_id,operation,actor,idempotency_key,submitted_at,expires_at,state)
        VALUES ('first','project','env','folder','session','stop','local-owner','key','2026-10-09T11:00:00Z','2026-10-09T11:00:30Z','accepted')`);
      expect(() =>
        db.exec("UPDATE lifecycle_commands SET state='unknown'")
      ).toThrow(/CHECK/);
      expect(() =>
        db.exec(
          "UPDATE lifecycle_commands SET state='succeeded',claimed_at='2026-10-09T11:00:01Z',owner_agent_id='agent',owner_session_id='session'"
        )
      ).toThrow(/CHECK/);
      expect(() =>
        db.exec(
          "UPDATE lifecycle_commands SET closed_at='2026-10-09T11:01:00Z',closed_actor='local-owner',closed_reason='close'"
        )
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
