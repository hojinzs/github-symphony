import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveFleetConfig } from "./config.js";
import { openFleetStore } from "./store.js";
import { applyMigrations } from "./migrations.js";
import { preparePersistence } from "./persistence.js";

const dirs: string[] = [];
function directory() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-foundation-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe("fleet configuration", () => {
  it("defaults to loopback and canonicalizes an HTTPS origin", () => {
    expect(
      resolveFleetConfig({
        dataDir: "/private/fleet",
        publicOrigin: "https://SYMPHONY.lan:443/",
      })
    ).toEqual({
      dataDir: "/private/fleet",
      publicOrigin: "https://symphony.lan",
      bindAddress: "127.0.0.1",
    });
  });
  it("rejects insecure origins, non-origins and relative persistence", () => {
    for (const publicOrigin of [
      "http://symphony.lan",
      " https://symphony.lan",
      "https://symphony.lan/a/..",
      "https://user@symphony.lan",
      "https://symphony.lan/path",
      "https://symphony.lan?x=1",
      "https://symphony.lan#x",
    ]) {
      expect(() =>
        resolveFleetConfig({ dataDir: "/private/fleet", publicOrigin })
      ).toThrow();
    }
    expect(() =>
      resolveFleetConfig({
        dataDir: "./fleet",
        publicOrigin: "https://symphony.lan",
      })
    ).toThrow();
    expect(() =>
      resolveFleetConfig({
        dataDir: "/private/fleet",
        publicOrigin: "https://symphony.lan",
        bindAddress: "",
      })
    ).toThrow();
  });
});
describe("user-owned SQLite", () => {
  it("creates private storage and reopens durable data without remigrating", () => {
    const dir = join(directory(), "data");
    const store = openFleetStore(dir);
    store.database
      .prepare(
        "INSERT INTO environments (id, name, enrollment, connection) VALUES (?, ?, ?, ?)"
      )
      .run("env", "Host", "pending", "awaiting-signal");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "fleet.sqlite")).mode & 0o777).toBe(0o600);
    store.close();
    const reopened = openFleetStore(dir);
    expect(
      reopened.database.prepare("SELECT name FROM environments").get()
    ).toEqual({ name: "Host" });
    expect(reopened.database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 2,
    });
    reopened.close();
  });
  it("rejects unsafe directory, database and sidecar modes or symlinks", () => {
    const dir = directory();
    chmodSync(dir, 0o755);
    expect(() => openFleetStore(dir)).toThrow(/private/);
    chmodSync(dir, 0o700);
    const target = join(dir, "target");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, join(dir, "fleet.sqlite"));
    expect(() => openFleetStore(dir)).toThrow(/regular/);
    rmSync(join(dir, "fleet.sqlite"));
    writeFileSync(join(dir, "fleet.sqlite"), "", { mode: 0o644 });
    expect(() => openFleetStore(dir)).toThrow(/private/);
    chmodSync(join(dir, "fleet.sqlite"), 0o600);
    symlinkSync(target, join(dir, "fleet.sqlite-wal"));
    expect(() => openFleetStore(dir)).toThrow(/regular/);
  });
  it("rejects directory symlinks and foreign ownership", () => {
    const parent = directory();
    const dir = join(parent, "data");
    symlinkSync(parent, dir);
    expect(() => openFleetStore(dir)).toThrow(/directory/);
    expect(() =>
      preparePersistence(parent, (process.getuid?.() ?? 0) + 1)
    ).toThrow(/owner/);
  });
});
describe("transaction boundary", () => {
  it("preserves the original error after SQLite automatically rolls back", () => {
    const store = openFleetStore(directory());
    try {
      store.database.exec("CREATE TABLE unique_values (id INTEGER UNIQUE)");
      expect(() =>
        store.transaction(() => {
          store.database.exec(
            "INSERT INTO unique_values VALUES (1); INSERT OR ROLLBACK INTO unique_values VALUES (1)"
          );
        })
      ).toThrow("UNIQUE constraint failed: unique_values.id");
      expect(store.database.isTransaction).toBe(false);
      expect(
        store.database.prepare("SELECT * FROM unique_values").all()
      ).toEqual([]);
      store.transaction(() =>
        store.database.exec("INSERT INTO unique_values VALUES (2)")
      );
      expect(
        store.database.prepare("SELECT id FROM unique_values").get()
      ).toEqual({ id: 2 });
    } finally {
      store.close();
    }
  });
  it("commits successful work, rolls back errors and rejects asynchronous work", () => {
    const store = openFleetStore(directory());
    const insert = () =>
      store.database
        .prepare(
          "INSERT INTO environments (id, name, enrollment, connection) VALUES ('env', 'Host', 'pending', 'awaiting-signal')"
        )
        .run();
    expect(() =>
      store.transaction(() => {
        insert();
        throw new Error("peer failed");
      })
    ).toThrow("peer failed");
    expect(
      store.database.prepare("SELECT id FROM environments").get()
    ).toBeUndefined();
    expect(() =>
      store.transaction(() => {
        insert();
        return Promise.resolve();
      })
    ).toThrow(/synchronous/);
    expect(
      store.database.prepare("SELECT id FROM environments").get()
    ).toBeUndefined();
    store.transaction(insert);
    expect(store.database.prepare("SELECT id FROM environments").get()).toEqual(
      { id: "env" }
    );
    store.close();
  });
});
describe("migrations", () => {
  it("preserves an automatic migration rollback error and permits retry", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        applyMigrations(db, [
          {
            version: 1,
            sql: "CREATE TABLE unique_values (id INTEGER UNIQUE); INSERT INTO unique_values VALUES (1); INSERT OR ROLLBACK INTO unique_values VALUES (1)",
          },
        ])
      ).toThrow("UNIQUE constraint failed: unique_values.id");
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 0,
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'unique_values'"
          )
          .get()
      ).toBeUndefined();
      applyMigrations(db);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 2,
      });
    } finally {
      db.close();
    }
  });
  it("rolls back failed migrations and rejects newer schemas", () => {
    const db = new DatabaseSync(":memory:");
    expect(() =>
      applyMigrations(db, [
        { version: 1, sql: "CREATE TABLE partial (id TEXT); INVALID SQL;" },
      ])
    ).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get()
    ).toBeUndefined();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    });
    db.exec("PRAGMA user_version = 99");
    expect(() => applyMigrations(db)).toThrow(/newer/);
    db.close();
  });
  it("rejects unordered migration definitions before modifying storage", () => {
    const db = new DatabaseSync(":memory:");
    expect(() =>
      applyMigrations(db, [{ version: 2, sql: "CREATE TABLE bad (id TEXT)" }])
    ).toThrow(/contiguous/);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'bad'").get()
    ).toBeUndefined();
    db.close();
  });
});
