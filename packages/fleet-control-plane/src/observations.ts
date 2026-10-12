import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  LIMITS,
  observationRequestSchema,
  projectFilterSchema,
  uuidSchema,
  type AggregateProject,
  type ObservationRequest,
  type Page,
  type ProjectFilter,
  type ProjectObservation,
  type ScopeWarning,
} from "@gh-symphony/management-protocol";
import { FleetError } from "./enrollment.js";
import type { CommandTarget } from "./commands.js";
import type { FleetStore } from "./store.js";
import { SESSION_LIFETIME_MS } from "./sessions.js";

export type { ScopeWarning } from "@gh-symphony/management-protocol";
export interface ObservedProject extends AggregateProject {
  /** Receipt time, never the agent's wall clock, controls freshness. */
  fresh: boolean;
  snapshotStale: boolean;
  warnings: ScopeWarning[];
}
export interface ObservationOptions {
  now?: () => Date;
  /** C07 must expire unclaimed commands here, on the shared transaction. */
  invalidateProject: (database: DatabaseSync, projectId: string) => undefined;
}
export interface ObservationService {
  /** Trusted enrollment/session composition allocates UUIDs before publication.
   * Browser/agent routes must authenticate the environment before calling. */
  identifyProjects(environmentId: string, localProjectIds: string[]): string[];
  receiveObservation(
    database: DatabaseSync,
    request: ObservationRequest
  ): undefined;
  listProjects(
    request?: Partial<ProjectFilter>
  ): Promise<Page<ObservedProject>>;
  getProject(projectId: string): Promise<ObservedProject>;
  summary(): { freshRunning: number; stale: number };
  resolveTarget(
    database: DatabaseSync,
    projectId: string
  ): CommandTarget | undefined;
}
interface ProjectRow {
  project_id: string;
  environment_id: string;
  local_project_id: string;
  managed: number;
  observation: string | null;
  received_at: string | null;
}
interface RevisionRow {
  session_id: string;
  revision_id: string;
  page_count: number;
  complete: number;
}
interface EnvironmentRow {
  enrollment: string;
  connection: string;
  last_contact_at: string | null;
  agent_id: string | null;
  session_id: string | null;
  expires_at: string | null;
}
function invalid(): never {
  throw new FleetError(
    "invalid_input",
    "Invalid inventory revision or identity"
  );
}
/** Compare only adapter-owned non-secret metadata; never infer eligibility. */
function scopeKey(
  observation: ProjectObservation
): { identity: string; key: string } | undefined {
  const snapshot = observation.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return undefined;
  const scope = snapshot.trackerScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    return undefined;
  const {
    adapter,
    bindingId,
    repository,
    activeStates,
    includeLabels,
    excludeLabels,
  } = scope;
  if (
    ![adapter, bindingId, repository].every(
      (v) => typeof v === "string" && v.trim()
    )
  )
    return undefined;
  const sets = [activeStates, includeLabels, excludeLabels];
  if (
    !sets.every(
      (v) =>
        Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim())
    )
  )
    return undefined;
  const identity = JSON.stringify([
    (adapter as string).trim().toLowerCase(),
    (bindingId as string).trim(),
    (repository as string).trim(),
  ]);
  return {
    identity,
    key: JSON.stringify([
      identity,
      ...sets.map((v) =>
        [...new Set((v as string[]).map((s) => s.trim()))].sort()
      ),
    ]),
  };
}

export function createObservationService(
  store: FleetStore,
  options: ObservationOptions
): ObservationService {
  const db = store.database;
  const now = options.now ?? (() => new Date());
  if (typeof options.invalidateProject !== "function")
    throw new Error("Observation service requires a project invalidation peer");
  function shared(database: DatabaseSync) {
    if (database !== db || !database.isTransaction)
      throw new Error("Projection requires the shared active transaction");
  }
  function rows(): ProjectRow[] {
    return db
      .prepare(
        "SELECT * FROM observed_projects WHERE observation IS NOT NULL AND published=1 ORDER BY project_id"
      )
      .all() as unknown as ProjectRow[];
  }
  function environment(id: string): EnvironmentRow | undefined {
    return db
      .prepare(
        `SELECT e.enrollment,e.connection,e.last_contact_at,s.agent_id,s.session_id,s.expires_at
      FROM environments e LEFT JOIN agent_sessions s ON s.environment_id=e.id WHERE e.id=?`
      )
      .get(id) as unknown as EnvironmentRow | undefined;
  }
  function online(env: EnvironmentRow) {
    return (
      env.enrollment === "enrolled" &&
      env.connection === "online" &&
      env.last_contact_at !== null &&
      Date.parse(env.last_contact_at) + SESSION_LIFETIME_MS > now().getTime() &&
      env.expires_at !== null &&
      Date.parse(env.expires_at) > now().getTime()
    );
  }
  function project(
    row: ProjectRow,
    env = environment(row.environment_id)!
  ): ObservedProject {
    const observation = JSON.parse(row.observation!) as ProjectObservation;
    const connection = online(env) ? "online" : "offline";
    const fresh =
      connection === "online" &&
      Date.parse(row.received_at!) + SESSION_LIFETIME_MS > now().getTime();
    return {
      projectId: row.project_id,
      environmentId: row.environment_id,
      localProjectId: row.local_project_id,
      managed:
        row.managed === 1 &&
        !(
          observation.validation.state === "invalid" &&
          observation.validation.diagnostic.code === "project_unmanaged"
        ),
      connection,
      lastReceivedAt: row.received_at!,
      observation,
      fresh,
      snapshotStale:
        !fresh ||
        !!observation.snapshotError ||
        observation.snapshot === undefined,
      warnings: [],
    };
  }
  function projected() {
    // Normalize once and query each environment once, including retained history.
    const environments = new Map<string, EnvironmentRow>();
    const items = rows().map((row) => {
      let env = environments.get(row.environment_id);
      if (!env) {
        env = environment(row.environment_id)!;
        environments.set(row.environment_id, env);
      }
      return project(row, env);
    });
    type Counts = { total: number; environments: Map<string, number> };
    const unknown: Counts = { total: 0, environments: new Map() };
    const identities = new Map<string, Counts>();
    const groups = new Map<
      string,
      { counts: Counts; projects: ObservedProject[] }
    >();
    const scopes = new Map<string, ReturnType<typeof scopeKey>>();
    function add(counts: Counts, item: ObservedProject) {
      counts.total++;
      counts.environments.set(
        item.environmentId,
        (counts.environments.get(item.environmentId) ?? 0) + 1
      );
    }
    function outside(counts: Counts, environmentId: string) {
      return counts.total - (counts.environments.get(environmentId) ?? 0);
    }
    for (const item of items) {
      if (!item.managed) continue;
      const scope =
        item.fresh && !item.snapshotStale
          ? scopeKey(item.observation)
          : undefined;
      scopes.set(item.projectId, scope);
      if (!scope) {
        add(unknown, item);
        continue;
      }
      let identity = identities.get(scope.identity);
      if (!identity) {
        identity = { total: 0, environments: new Map() };
        identities.set(scope.identity, identity);
      }
      add(identity, item);
      let group = groups.get(scope.key);
      if (!group) {
        group = { counts: { total: 0, environments: new Map() }, projects: [] };
        groups.set(scope.key, group);
      }
      add(group.counts, item);
      group.projects.push(item);
    }
    for (const item of items) {
      if (!item.managed) continue;
      const scope = scopes.get(item.projectId);
      if (!scope) {
        item.warnings.push({
          state: "unverified",
          projectIds: [item.projectId],
        });
        continue;
      }
      const group = groups.get(scope.key)!;
      if (outside(group.counts, item.environmentId)) {
        // Rows are already UUID ordered. Stop at the wire warning limit.
        const related: string[] = [];
        for (const other of group.projects) {
          if (other.environmentId !== item.environmentId)
            related.push(other.projectId);
          if (related.length === LIMITS.maximumPageSize - 1) break;
        }
        item.warnings.push({
          state: "identical",
          projectIds: [item.projectId, ...related].sort(),
        });
      }
      if (
        outside(unknown, item.environmentId) ||
        outside(identities.get(scope.identity)!, item.environmentId) >
          outside(group.counts, item.environmentId)
      )
        item.warnings.push({
          state: "unverified",
          projectIds: [item.projectId],
        });
    }
    return items;
  }
  return {
    identifyProjects(environmentId, ids) {
      uuidSchema.parse(environmentId);
      if (
        ids.length > LIMITS.managedProjectsPerAgent ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id) =>
            typeof id !== "string" || !id.trim() || Buffer.byteLength(id) > 4096
        )
      )
        invalid();
      return store.transaction(() => {
        if (environment(environmentId)?.enrollment !== "enrolled")
          throw new FleetError(
            "unauthenticated",
            "Enrolled environment required"
          );
        return ids.map((id) => {
          const existing = db
            .prepare(
              "SELECT project_id FROM observed_projects WHERE environment_id=? AND local_project_id=?"
            )
            .get(environmentId, id);
          if (existing) return String(existing.project_id);
          const projectId = randomUUID();
          db.prepare(
            "INSERT INTO observed_projects(project_id,environment_id,local_project_id) VALUES (?,?,?)"
          ).run(projectId, environmentId, id);
          return projectId;
        });
      });
    },
    receiveObservation(database, input) {
      shared(database);
      const request = observationRequestSchema.parse(input);
      for (const observation of request.inventory.projects)
        observation.runs.sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            a.runId.localeCompare(b.runId)
        );
      const { environmentId, sessionId, inventory } = request;
      const current = db
        .prepare("SELECT * FROM inventory_revisions WHERE environment_id=?")
        .get(environmentId) as unknown as RevisionRow | undefined;
      if (
        !current ||
        current.session_id !== sessionId ||
        current.revision_id !== inventory.revisionId
      ) {
        if (inventory.pageIndex !== 0) invalid();
        db.prepare("DELETE FROM inventory_pages WHERE environment_id=?").run(
          environmentId
        );
        db.prepare(
          `INSERT INTO inventory_revisions VALUES (?,?,?,?,0) ON CONFLICT(environment_id) DO UPDATE SET
          session_id=excluded.session_id,revision_id=excluded.revision_id,page_count=excluded.page_count,complete=0`
        ).run(
          environmentId,
          sessionId,
          inventory.revisionId,
          inventory.pageCount
        );
      } else if (current.complete || current.page_count !== inventory.pageCount)
        invalid();
      if (
        db
          .prepare(
            "SELECT 1 FROM inventory_pages WHERE environment_id=? AND page_index=?"
          )
          .get(environmentId, inventory.pageIndex)
      )
        invalid();
      const previousIds = db
        .prepare(
          "SELECT project_ids FROM inventory_pages WHERE environment_id=?"
        )
        .all(environmentId)
        .flatMap((row) => JSON.parse(String(row.project_ids)) as string[]);
      const ids = inventory.projects.map((p) => p.projectId);
      if (
        previousIds.length + ids.length > LIMITS.managedProjectsPerAgent ||
        ids.some((id) => previousIds.includes(id))
      )
        invalid();
      for (const observation of inventory.projects) {
        const row = db
          .prepare("SELECT * FROM observed_projects WHERE project_id=?")
          .get(observation.projectId) as unknown as ProjectRow | undefined;
        if (
          !row ||
          row.environment_id !== environmentId ||
          row.local_project_id !== observation.localProjectId
        )
          invalid();
        const previous = row.observation
          ? (JSON.parse(row.observation) as ProjectObservation)
          : undefined;
        const retained =
          observation.snapshot === undefined && previous?.snapshot !== undefined
            ? {
                ...observation,
                snapshot: previous.snapshot,
                snapshotObservedAt: previous.snapshotObservedAt,
                snapshotError: observation.snapshotError ?? {
                  code: "log_unavailable" as const,
                  message: "Latest snapshot unavailable",
                },
              }
            : observation;
        db.prepare(
          "UPDATE observed_projects SET observation=?,received_at=? WHERE project_id=?"
        ).run(
          JSON.stringify(retained),
          now().toISOString(),
          observation.projectId
        );
        if (
          row.managed &&
          observation.validation.state === "invalid" &&
          observation.validation.diagnostic.code === "project_unmanaged"
        )
          options.invalidateProject(db, observation.projectId);
      }
      db.prepare("INSERT INTO inventory_pages VALUES (?,?,?)").run(
        environmentId,
        inventory.pageIndex,
        JSON.stringify(ids)
      );
      const count = db
        .prepare(
          "SELECT count(*) AS n FROM inventory_pages WHERE environment_id=?"
        )
        .get(environmentId)!;
      if (Number(count.n) === inventory.pageCount) {
        const allIds = new Set([...previousIds, ...ids]);
        for (const row of db
          .prepare(
            "SELECT project_id,managed FROM observed_projects WHERE environment_id=?"
          )
          .all(environmentId)) {
          const managed = allIds.has(String(row.project_id));
          if (row.managed === 1 && !managed)
            options.invalidateProject(db, String(row.project_id));
          db.prepare(
            "UPDATE observed_projects SET managed=?,published=CASE WHEN ?=1 THEN 1 ELSE published END WHERE project_id=?"
          ).run(managed ? 1 : 0, managed ? 1 : 0, String(row.project_id));
        }
        db.prepare(
          "UPDATE inventory_revisions SET complete=1 WHERE environment_id=?"
        ).run(environmentId);
        db.prepare("DELETE FROM inventory_pages WHERE environment_id=?").run(
          environmentId
        );
      }
      return undefined;
    },
    async listProjects(input = {}) {
      const filter = projectFilterSchema.parse({
        ...input,
        limit: input.limit ?? LIMITS.defaultPageSize,
      });
      let after = "";
      const scope = JSON.stringify([
        filter.environmentId ?? null,
        filter.process ?? null,
        filter.connection ?? null,
      ]);
      if (filter.cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(filter.cursor, "base64url").toString()
          ) as { after: string; scope: string };
          uuidSchema.parse(decoded.after);
          if (decoded.scope !== scope) throw new Error();
          after = decoded.after;
        } catch {
          throw new FleetError(
            "cursor_reset",
            "Invalid project cursor or filter changed"
          );
        }
      }
      const matches = projected().filter(
        (p) =>
          p.projectId > after &&
          (!filter.environmentId || p.environmentId === filter.environmentId) &&
          (!filter.process || p.observation.process.state === filter.process) &&
          (!filter.connection || p.connection === filter.connection)
      );
      const items = matches.slice(0, filter.limit);
      return {
        items,
        ...(matches.length > filter.limit
          ? {
              nextCursor: Buffer.from(
                JSON.stringify({
                  after: items[items.length - 1].projectId,
                  scope,
                })
              ).toString("base64url"),
            }
          : {}),
      };
    },
    async getProject(id) {
      uuidSchema.parse(id);
      const result = projected().find((p) => p.projectId === id);
      if (!result)
        throw new FleetError("not_found", "Project has no observations");
      return result;
    },
    summary() {
      const items = projected().filter((p) => p.managed);
      return {
        freshRunning: items.filter(
          (p) => p.fresh && p.observation.process.state === "running"
        ).length,
        stale: items.filter((p) => !p.fresh).length,
      };
    },
    resolveTarget(database, id) {
      shared(database);
      const row = db
        .prepare("SELECT * FROM observed_projects WHERE project_id=?")
        .get(id) as unknown as ProjectRow | undefined;
      if (!row?.observation) return undefined;
      const env = environment(row.environment_id)!;
      const value = project(row);
      return {
        projectId: id,
        environmentId: row.environment_id,
        localProjectId: row.local_project_id,
        agentId: env.agent_id ?? "",
        sessionId: env.session_id ?? "",
        managed: value.managed,
        online: value.fresh,
        valid: value.observation.validation.state === "valid",
        supported: true,
      };
    },
  };
}
