declare module "dockerode" {
  export type ContainerCreateOptions = {
    Image: string;
    name: string;
    Env?: string[];
    ExposedPorts?: Record<string, object>;
    HostConfig?: {
      Binds?: string[];
      PortBindings?: Record<string, Array<{ HostPort: string }>>;
    };
  };

  export type Container = {
    id?: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    remove(options?: { force?: boolean }): Promise<void>;
    inspect(): Promise<{
      State?: {
        Running?: boolean;
        Status?: string;
      };
    }>;
  };

  export default class Docker {
    createContainer(options: ContainerCreateOptions): Promise<Container>;
    getContainer(id: string): Container;
  }
}
