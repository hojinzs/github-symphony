import {
  AgentCredentialProvider,
  AgentCredentialStatus,
  WorkspaceAgentCredentialSource,
  WorkspaceStatus
} from "@prisma/client";
import { db } from "./db";

type MemoryRepository = {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  cloneUrl: string;
  createdAt: Date;
};

type MemoryAgentCredential = {
  id: string;
  label: string;
  provider: AgentCredentialProvider;
  encryptedSecret: string;
  secretFingerprint: string;
  status: AgentCredentialStatus;
  lastValidatedAt: Date | null;
  degradedReason: string | null;
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
  agentCredentialSource: WorkspaceAgentCredentialSource;
  agentCredentialId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type MemorySymphonyInstance = {
  id: string;
  workspaceId: string;
  runtimeDriver: "docker" | "local";
  runtimeId: string;
  runtimeName: string;
  endpointHost: string;
  port: number;
  workflowPath: string;
  runtimePath: string;
  processId: number | null;
  status: "provisioning" | "running" | "stopped" | "failed" | "degraded";
  degradedReason: string | null;
  lastHeartbeat: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function createMemoryDatabase() {
  const state = {
    workspaces: [] as MemoryWorkspace[],
    repositories: [] as MemoryRepository[],
    agentCredentials: [] as MemoryAgentCredential[],
    instances: [] as MemorySymphonyInstance[],
    platformDefaultCredentialId: null as string | null
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
          agentCredentialSource: WorkspaceAgentCredentialSource;
          agentCredential?: {
            connect: {
              id?: string;
            };
          };
          repositories: {
            create: Array<Pick<MemoryRepository, "owner" | "name" | "cloneUrl">>;
          };
        };
      }) => {
        const now = new Date(`2026-03-07T09:00:${String(sequence).padStart(2, "0")}.000Z`);
        const workspace: MemoryWorkspace = {
          id: `workspace-${sequence}`,
          slug: args.data.slug,
          name: args.data.name,
          promptGuidelines: args.data.promptGuidelines,
          status: args.data.status,
          githubOwnerLogin: args.data.githubOwnerLogin,
          githubProjectId: null,
          githubProjectUrl: null,
          agentCredentialSource: args.data.agentCredentialSource,
          agentCredentialId: args.data.agentCredential?.connect.id ?? null,
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
          repositories
        };
      },
      update: async (args: {
        where: { id: string };
        data: Partial<
          Pick<
            MemoryWorkspace,
            | "githubProjectId"
            | "githubProjectUrl"
            | "status"
            | "agentCredentialSource"
            | "agentCredentialId"
          >
        >;
      }) => {
        const workspace = mustFindWorkspace(state.workspaces, args.where.id);
        Object.assign(workspace, args.data, {
          updatedAt: new Date("2026-03-07T10:00:00.000Z")
        });
        return materializeWorkspace(state, workspace);
      },
      findUnique: async (args: { where: { id: string } }) => {
        const workspace = state.workspaces.find((entry) => entry.id === args.where.id);
        return workspace ? materializeWorkspace(state, workspace) : null;
      },
      findMany: async () => {
        return [...state.workspaces]
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map((workspace) => ({
            ...materializeWorkspace(state, workspace),
            symphonyInstance:
              state.instances.find((instance) => instance.workspaceId === workspace.id) ??
              null
          }));
      }
    },
    agentCredential: {
      create: async (args: {
        data: Omit<MemoryAgentCredential, "id" | "createdAt" | "updatedAt">;
      }) => {
        const now = new Date(`2026-03-07T09:10:${String(sequence).padStart(2, "0")}.000Z`);
        const credential: MemoryAgentCredential = {
          id: `agent-credential-${sequence}`,
          ...args.data,
          createdAt: now,
          updatedAt: now
        };
        state.agentCredentials.push(credential);
        sequence += 1;
        return credential;
      },
      findUnique: async (args: { where: { id: string } }) => {
        return (
          state.agentCredentials.find((entry) => entry.id === args.where.id) ?? null
        );
      },
      findMany: async () => {
        return [...state.agentCredentials].sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
        );
      },
      update: async (args: {
        where: { id: string };
        data: Partial<
          Pick<
            MemoryAgentCredential,
            | "label"
            | "encryptedSecret"
            | "secretFingerprint"
            | "status"
            | "lastValidatedAt"
            | "degradedReason"
          >
        >;
      }) => {
        const credential = mustFindAgentCredential(state.agentCredentials, args.where.id);
        Object.assign(credential, args.data, {
          updatedAt: new Date("2026-03-07T10:02:00.000Z")
        });
        return credential;
      }
    },
    platformAgentCredentialConfig: {
      findUnique: async () => {
        return {
          singletonKey: "system",
          defaultAgentCredentialId: state.platformDefaultCredentialId,
          defaultAgentCredential: state.platformDefaultCredentialId
            ? mustFindAgentCredential(state.agentCredentials, state.platformDefaultCredentialId)
            : null,
          createdAt: new Date("2026-03-07T08:00:00.000Z"),
          updatedAt: new Date("2026-03-07T08:00:00.000Z")
        };
      },
      upsert: async (args: {
        update: {
          defaultAgentCredentialId: string;
        };
        create: {
          defaultAgentCredentialId: string;
        };
      }) => {
        state.platformDefaultCredentialId =
          args.update.defaultAgentCredentialId ?? args.create.defaultAgentCredentialId;

        return {
          singletonKey: "system",
          defaultAgentCredentialId: state.platformDefaultCredentialId,
          createdAt: new Date("2026-03-07T08:00:00.000Z"),
          updatedAt: new Date("2026-03-07T10:03:00.000Z")
        };
      }
    },
    symphonyInstance: {
      upsert: async (args: {
        where: { workspaceId: string };
        update: Omit<
          MemorySymphonyInstance,
          "id" | "workspaceId" | "createdAt" | "updatedAt" | "lastHeartbeat" | "degradedReason"
        >;
        create: Omit<
          MemorySymphonyInstance,
          "id" | "createdAt" | "updatedAt" | "lastHeartbeat" | "degradedReason"
        >;
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
          degradedReason: null,
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
          Pick<MemorySymphonyInstance, "status" | "lastHeartbeat" | "degradedReason">
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
    db: database as unknown as Pick<
      typeof db,
      "workspace" | "symphonyInstance" | "agentCredential" | "platformAgentCredentialConfig"
    >,
    state
  };
}

function materializeWorkspace(
  state: {
    repositories: MemoryRepository[];
    agentCredentials: MemoryAgentCredential[];
  },
  workspace: MemoryWorkspace
) {
  return {
    ...workspace,
    repositories: state.repositories.filter(
      (repository) => repository.workspaceId === workspace.id
    ),
    agentCredential: workspace.agentCredentialId
      ? state.agentCredentials.find(
          (credential) => credential.id === workspace.agentCredentialId
        ) ?? null
      : null
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

function mustFindAgentCredential(
  credentials: MemoryAgentCredential[],
  credentialId: string
): MemoryAgentCredential {
  const credential = credentials.find((entry) => entry.id === credentialId);

  if (!credential) {
    throw new Error(`Agent credential not found: ${credentialId}`);
  }

  return credential;
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
