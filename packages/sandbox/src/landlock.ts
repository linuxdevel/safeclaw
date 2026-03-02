import type { PathRule } from "./types.js";

export interface LandlockRuleset {
  addRule(rule: PathRule): void;
  enforce(): void;
}

export function createLandlockRuleset(): LandlockRuleset {
  // Stub — native implementation in future
  const rules: PathRule[] = [];
  return {
    addRule(rule: PathRule): void {
      rules.push(rule);
    },
    enforce(): void {
      /* Native binding will go here */
    },
  };
}
