export interface SeccompFilter {
  addAllowedSyscall(name: string): void;
  apply(): void;
}

export function createSeccompFilter(): SeccompFilter {
  // Stub — native implementation in future
  const allowed: string[] = [];
  return {
    addAllowedSyscall(name: string): void {
      allowed.push(name);
    },
    apply(): void {
      /* Native binding will go here */
    },
  };
}
