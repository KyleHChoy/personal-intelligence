import { IdeasOutput, LessonsOutput, type PlannerStage, ReasoningOutput } from "./work.ts";

// What each stage answers: the form of its output, and the key that holds its list.
export const STAGE_OUTPUTS = Object.freeze({
  ideas: { schema: IdeasOutput, key: "ideas" },
  translate: { schema: ReasoningOutput, key: "actions" },
  lessons: { schema: LessonsOutput, key: "lessons" },
} as const satisfies Record<PlannerStage, { schema: unknown; key: string }>);
