// project_brief's one item: the project as get_project answers it,
// by get_project's own read, so the pack and the tool can never differ and there is one query
// path to hold to invariant 6. That read's definer functions answer only an agent that holds
// get_project and the board, so the pack is refused, from the registration alone and before any
// row is read, to a client that lacks either.

import type { ClientView, EntityId, PackItem } from "@intelligence/contracts/personal";
import { getProject } from "../agent-work/work-projects.ts";
import { stamp } from "../core/db.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { functionCall } from "../core/work-refs.ts";

// The tools get_project's read is answered to: its own, and the board's for the open work's holders.
const PROJECT_BRIEF_TOOLS = ["get_project", "list_opportunities"] as const;

export type ProjectBrief = {
  sections: { project: PackItem[] };
  evidenceOf: ReadonlyMap<string, string>;
  cut: false;
  // What the project's item shows, and the goals it returns, by its id.
  shownOf: ReadonlyMap<string, string[]>;
  goalsOf: ReadonlyMap<string, string[]>;
};

// Null for a project that is not there or not visible, as get_project's not_found.
export async function projectBrief(
  ctx: Ctx,
  client: ClientView,
  section: { required: boolean },
  project: string,
  now: Date,
): Promise<ProjectBrief | "not_permitted" | null> {
  if (!PROJECT_BRIEF_TOOLS.every((tool) => client.tools.includes(tool))) return "not_permitted";
  const done = await getProject(
    { client, ctx, session: ctx.session, fn: functionCall(ctx.run) },
    { project: project as EntityId },
    () => now,
  );
  if (!done.outcome.ok) {
    if (done.outcome.code === "not_found") return null;
    if (done.outcome.code === "not_permitted") return "not_permitted";
    throw new Unavailable();
  }
  const value = done.outcome.value;
  return {
    sections: {
      project: [
        {
          id: value.id,
          section: "project",
          required: section.required,
          provenance: "source",
          asOf: stamp(now),
          kind: "project",
          project: value,
        },
      ],
    },
    evidenceOf: new Map(),
    cut: false,
    shownOf: new Map([[value.id, done.shown ?? []]]),
    goalsOf: new Map([[value.id, done.goals ?? []]]),
  };
}
