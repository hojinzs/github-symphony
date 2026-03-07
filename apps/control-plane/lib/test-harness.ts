import { GitHubAuthType, WorkspaceStatus } from "@prisma/client";
import { db } from "./db";

type MemoryRepository = {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  cloneUrl: string;
  createdAt: Date;
};

type MemoryCredential = {
  id: string;
  authType: GitHubAuthType;
  githubUserId: string | null;
  githubLogin: string;
  tokenFingerprint: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
};

type MemoryWorkspace = {
  id: string;
  slug: string;
  name: string;
  promptGuidelines: string;
  status: WorkspaceStatus;
  githubOwnerLogin: string;
  githubProjectId: string | null;
  githubProjectUrl: string | null;
  githubCredentialId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type MemorySymphonyInstance = {
  id: string;
  workspaceId: string;
  containerId: string;
  containerName: string;
  port: number;
  workflowPath: string;
  status: "provisioning" | "running" | "stopped" | "failed" | "degraded";
  lastHeartbeat: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function createMemoryDatabase() {
  const state = {
    workspaces: [] as MemoryWorkspace[],
    repositories: [] as MemoryRepository[],
    credentials: [] as MemoryCredential[],
    instances: [] as MemorySymphonyInstance[]
  };

  let sequence = 1;

  const database = {
    workspace: {
      create: async (args: {
        data: {
          slug: string;
          name: string;
          promptGuidelines: string;
          status: WorkspaceStatus;
          githubOwnerLogin: string;
          githubCredential?: {
            connectOrCreate: {
              where: { tokenFingerprint: string };
              create: Omit<MemoryCredential, "id" | "createdAt" | "updatedAt">;
            };
          };
          repositories: {
            create: Array<Pick<MemoryRepository, "owner" | "name" | "cloneUrl">>;
          };
        };
      }) => {
        const now = new Date(`2026-03-07T09:00:${String(sequence).padStart(2, "0")}.000Z`);
        let credential: MemoryCredential | undefined;

        if (args.data.githubCredential) {
          const credentialFingerprint =
            args.data.githubCredential.connectOrCreate.where.tokenFingerprint;
          credential = state.credentials.find(
            (entry) => entry.tokenFingerprint === credentialFingerprint
          );

          if (!credential) {
            credential = {
              id: `credential-${sequence}`,
              ...args.data.githubCredential.connectOrCreate.create,
              createdAt: now,
              updatedAt: now
            };
            state.credentials.push(credential);
          }
        }

        const workspace: MemoryWorkspace = {
          id: `workspace-${sequence}`,
          slug: args.data.slug,
          name: args.data.name,
          promptGuidelines: args.data.promptGuidelines,
          status: args.data.status,
          githubOwnerLogin: args.data.githubOwnerLogin,
          githubProjectId: null,
          githubProjectUrl: null,
          githubCredentialId: credential?.id ?? null,
          createdAt: now,
          updatedAt: now
        };
        state.workspaces.push(workspace);

        const repositories = args.data.repositories.create.map((repository, index) => {
          const created: MemoryRepository = {
            id: `repository-${sequence}-${index + 1}`,
            workspaceId: workspace.id,
            owner: repository.owner,
            name: repository.name,
            cloneUrl: repository.cloneUrl,
            createdAt: now
          };
          state.repositories.push(created);
          return created;
        });

        sequence += 1;

        return {
          ...workspace,
          githubCredential: credential
            ? {
                githubLogin: credential.githubLogin,
                authType: credential.authType
              }
            : null,
          repositories
        };
      },
      update: async (args: {
        where: { id: string };
        data: Partial<
          Pick<
            MemoryWorkspace,
            "githubProjectId" | "githubProjectUrl" | "status" | "updatedAt"
          >
        >;
      }) => {
        const workspace = mustFindWorkspace(state.workspaces, args.where.id);
        Object.assign(workspace, args.data, {
          updatedAt: new Date("2026-03-07T10:00:00.000Z")
        });
        return workspace;
      },
      findUnique: async (args: { where: { id: string } }) => {
        const workspace = state.workspaces.find((entry) => entry.id === args.where.id);

        if (!workspace) {
          return null;
        }

        return {
          ...workspace,
          repositories: state.repositories.filter(
            (repository) => repository.workspaceId === workspace.id
          )
        };
      },
      findMany: async () => {
        return [...state.workspaces]
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map((workspace) => ({
            ...workspace,
            repositories: state.repositories.filter(
              (repository) => repository.workspaceId === workspace.id
            ),
            symphonyInstance:
              state.instances.find((instance) => instance.workspaceId === workspace.id) ?? null
          }));
      }
    },
    symphonyInstance: {
      upsert: async (args: {
        where: { workspaceId: string };
        update: Omit<MemorySymphonyInstance, "id" | "workspaceId" | "createdAt" | "updatedAt" | "lastHeartbeat">;
        create: Omit<MemorySymphonyInstance, "id" | "createdAt" | "updatedAt" | "lastHeartbeat">;
      }) => {
        const existing = state.instances.find(
          (entry) => entry.workspaceId === args.where.workspaceId
        );

        if (existing) {
          Object.assign(existing, args.update, {
            updatedAt: new Date("2026-03-07T10:05:00.000Z")
          });
          return existing;
        }

        const created: MemorySymphonyInstance = {
          id: `instance-${sequence}`,
          ...args.create,
          lastHeartbeat: null,
          createdAt: new Date("2026-03-07T10:05:00.000Z"),
          updatedAt: new Date("2026-03-07T10:05:00.000Z")
        };

        state.instances.push(created);
        sequence += 1;

        return created;
      },
      update: async (args: {
        where: { workspaceId: string };
        data: Partial<
          Pick<MemorySymphonyInstance, "status" | "lastHeartbeat">
        >;
      }) => {
        const instance = mustFindInstance(state.instances, args.where.workspaceId);
        Object.assign(instance, args.data, {
          updatedAt: new Date("2026-03-07T10:10:00.000Z")
        });
        return instance;
      }
    }
  };

  return {
    db: database as unknown as Pick<typeof db, "workspace" | "symphonyInstance">,
    state
  };
}

function mustFindWorkspace(
  workspaces: MemoryWorkspace[],
  workspaceId: string
): MemoryWorkspace {
  const workspace = workspaces.find((entry) => entry.id === workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return workspace;
}

function mustFindInstance(
  instances: MemorySymphonyInstance[],
  workspaceId: string
): MemorySymphonyInstance {
  const instance = instances.find((entry) => entry.workspaceId === workspaceId);

  if (!instance) {
    throw new Error(`Symphony instance not found: ${workspaceId}`);
  }

  return instance;
}
