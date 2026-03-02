export interface NamespaceConfig {
  create(): { pid: number };
}

export function createNamespaceConfig(options: {
  pid: boolean;
  net: boolean;
  mnt: boolean;
  user: boolean;
}): NamespaceConfig {
  // Stub — native implementation in future
  const _options = options;
  return {
    create(): { pid: number } {
      void _options;
      /* Native binding will go here */
      return { pid: -1 };
    },
  };
}
