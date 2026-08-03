// Public API for user loops: `import { t } from "etium"` plus the types.
import type { PromptSpec } from "./types.ts";

/** Prompt template marker: resolved relative to the loop file, then the
 * workspace, with {{param}} interpolation. */
export function t(file: string): PromptSpec {
  return { __template: file };
}

export type {
  Run,
  LoopFn,
  StepOptions,
  StepResult,
  GateResult,
  BudgetSpec,
  PromptSpec,
  HarnessAdapter,
  HarnessEvent,
  Surface,
  SurfaceTask,
  SurfaceDecision,
  SurfacePollResult,
  RunView,
  AnyEnvelope,
  EventMap,
  EventType,
} from "./types.ts";
