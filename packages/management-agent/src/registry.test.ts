import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  observationRequestSchema,
  type EnrollmentResponse,
} from "@gh-symphony/management-protocol";
import {
  AgentRegistry,
  localProjectId,
  type LocalInventoryReader,
} from "./registry.js";

const enrollment: EnrollmentResponse = {
  protocolVersion: 1,
  requestId: "66666666-6666-4666-8666-666666666666",
  environmentId: "11111111-1111-4111-8111-111111111111",
  agentId: "55555555-5555-4555-8555-555555555555",
  credential: "fixture-only-management-secret",
};
const reader: LocalInventoryReader = {
  async inspect() {
    const observedAt = new Date().toISOString();
    return {
      validation: {
        state: "invalid",
        diagnostic: {
          code: "project_invalid",
          message: "Workflow unavailable",
        },
      },
      process: { state: "stopped", observedAt },
      runs: [],
      // Independent adapter fixture deliberately carries a field that must not upload.
      credential: "fixture-only-leak-canary",
    };
  },
};
let root: string;
let registry: AgentRegistry;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "management-agent-test-"))
  );
  registry = await AgentRegistry.open(join(root, "agent"));
});
afterEach(async () => {
  await registry.close();
  await rm(root, { recursive: true, force: true });
});

describe("local management registry", () => {
  it("deduplicates canonical folders and aliases, retaining the canonical CLI ID", async () => {
    expect(localProjectId("/srv/Prepared Project")).toBe(
      "prepared-project-016f786a"
    );
    const folder = join(root, "prepared-project");
    const alias = join(root, "alias");
    await mkdir(folder);
    await symlink(folder, alias);
    const canonical = await registry.add(folder);
    expect(await registry.add(alias)).toEqual(canonical);
    expect(registry.list()).toHaveLength(1);
    expect(canonical.localProjectId).toBe(localProjectId(folder));
    expect(localProjectId(alias)).not.toBe(canonical.localProjectId);
    await expect(registry.add(join(root, "missing"))).rejects.toThrow();
    await writeFile(join(root, "file"), "fixture");
    await expect(registry.add(join(root, "file"))).rejects.toThrow("directory");
  });

  it("rejects alias retargeting, folder moves and commands after removal without effects", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    const alias = join(root, "alias");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, alias);
    const project = await registry.add(alias);
    await rm(alias);
    await symlink(second, alias);
    await expect(
      registry.resolveManaged(project.localProjectId)
    ).rejects.toThrow("project_unmanaged");
    const inventory = await registry.inventory(reader, "3.0.0");
    expect(inventory[0].validation.state).toBe("invalid");
    expect(inventory[0].process.state).toBe("unknown");
    await registry.remove(project.localProjectId);
    expect(registry.list()).toEqual([]);
    await expect(
      registry.resolveManaged(project.localProjectId)
    ).rejects.toThrow("project_unmanaged");
    expect((await stat(first)).isDirectory()).toBe(true);
    const moved = await registry.add(second);
    await rm(second, { recursive: true });
    await expect(
      registry.resolveManaged(moved.localProjectId)
    ).rejects.toThrow();
  });

  it("persists user-only identity and allowlist, refuses cross-environment replacement", async () => {
    await registry.add(root);
    await registry.saveIdentity("https://control.example", enrollment);
    await expect(
      registry.saveIdentity("https://control.example", {
        ...enrollment,
        environmentId: "22222222-2222-4222-8222-222222222222",
      })
    ).rejects.toThrow("replace");
    await expect(
      registry.saveIdentity("http://control.example", enrollment)
    ).rejects.toThrow("HTTPS");
    await expect(
      registry.saveIdentity("https://user:password@control.example", enrollment)
    ).rejects.toThrow("HTTPS");
    const file = join(root, "agent", "registry.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "agent"))).mode & 0o777).toBe(0o700);
    await registry.close();
    registry = await AgentRegistry.open(join(root, "agent"));
    expect(registry.identity?.credential).toBe(enrollment.credential);
    expect(registry.list()).toHaveLength(1);
    const copy = registry.identity!;
    copy.credential = "changed";
    expect(registry.identity?.credential).toBe(enrollment.credential);
  });

  it("rejects a second live owner and resumes after release", async () => {
    await expect(AgentRegistry.open(join(root, "agent"))).rejects.toThrow(
      "already running"
    );
    await registry.close();
    registry = await AgentRegistry.open(join(root, "agent"));
    expect(registry.list()).toEqual([]);
  });

  it("retains unstarted invalid inventory, excludes credentials and exercises the peer wire schema", async () => {
    await registry.saveIdentity("https://control.example", enrollment);
    const project = await registry.add(root);
    const inventory = await registry.inventory(reader, "3.0.0");
    expect(inventory).toHaveLength(1);
    expect(inventory[0].validation.state).toBe("invalid");
    expect(inventory[0].process.state).toBe("stopped");
    expect(JSON.stringify(inventory)).not.toContain("fixture-only");
    const wire = {
      protocolVersion: 1,
      environmentId: enrollment.environmentId,
      sessionId: "33333333-3333-4333-8333-333333333333",
      requestId: enrollment.requestId,
      sequence: 1,
      observedAt: new Date().toISOString(),
      inventory: {
        revisionId: "88888888-8888-4888-8888-888888888888",
        pageIndex: 0,
        pageCount: 1,
        projects: inventory.map((entry) => ({
          ...entry,
          projectId: "44444444-4444-4444-8444-444444444444",
        })),
      },
    };
    expect(
      observationRequestSchema.parse(wire).inventory.projects[0].localProjectId
    ).toBe(project.localProjectId);
    // A second environment may use the same local ID; environment qualification is external.
    expect(
      observationRequestSchema.parse({
        ...wire,
        environmentId: "22222222-2222-4222-8222-222222222222",
      }).environmentId
    ).not.toBe(wire.environmentId);
  });

  it("fails closed on malformed persisted configuration and serializes concurrent writes", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await Promise.all([registry.add(first), registry.add(second)]);
    expect(registry.list()).toHaveLength(2);
    const file = join(root, "agent", "registry.json");
    expect(JSON.parse(await readFile(file, "utf8")).projects).toHaveLength(2);
    await registry.close();
    await writeFile(file, '{"version":2,"identity":null,"projects":[]}');
    await expect(AgentRegistry.open(join(root, "agent"))).rejects.toThrow(
      "Invalid agent registry"
    );
    await writeFile(file, '{"version":1,"identity":null,"projects":[]}');
    registry = await AgentRegistry.open(join(root, "agent"));
  });
});
