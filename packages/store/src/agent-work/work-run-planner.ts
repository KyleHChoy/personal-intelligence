import { type HypothesisId, PlannerStage, type RunRequest, STAGE_PROMPT_IDS } from "@intelligence/contracts/personal";
import { servedOrNull } from "../core/read-ctx.ts";
import { MISSION_AT } from "../core/run-plan.ts";
import { LESSON_IN_FORCE } from "../core/statements.ts";
import { storedAbout, storedRef, type WorkCall } from "../core/work-refs.ts";
import { ownerActions } from "../work/owner-actions.ts";

// A planner stage's parts of a run request: the lessons the owner confirmed, their mission, a
// translate run's idea, and a lessons run's owner actions, each read under the reasoner's policies and
// served as untrusted.

const SQL = {
  // The planner's stages: the owner's mission, the lessons they confirmed (newest first), and a
  // translate run's idea with what it is about and its basis.
  mission: "select compartments, text_enc from projections.planner_mission",
  lessons: `select h.id, h.compartments, h.body_enc from ledger.hypotheses h where ${LESSON_IN_FORCE} order by h.created_at desc, h.id desc limit 50`,
  lessonsGiven: `select h.id, h.compartments, h.body_enc from ledger.hypotheses h where h.id = any($1) and ${LESSON_IN_FORCE} order by h.created_at desc, h.id desc limit 50`,
  idea: "select id, compartments, body_enc, about_kind, about_id from ledger.hypotheses where id = $1 and kind = 'idea' and tainted_at is null",
  ideaBasis: "select ref_kind, ref_id from ledger.basis where row_kind = 'hypothesis' and row_id = $1 order by id",
} as const;

type Cited = readonly [rowKind: string, id: string];

// A planner stage's parts of the request: for every stage the lessons the owner confirmed; for
// ideas and translate the owner's mission; for translate the idea its anchor names. A run of
// personal_run gets the lessons and the mission from version 4, shown
// as the ideas stage shows them and not cited, and none of them before, so its input is as it was.
// `cites` are the rows whose cited evidence the request shows.
export async function plannerParts(
  call: WorkCall,
  point: { promptId: string; promptVersion: string },
  anchors: readonly { ref_kind: string; ref_id: string }[],
  stored: { id: string; lessons: string[] | null; within: readonly string[] | null },
): Promise<{
  parts: Partial<Pick<RunRequest, "mission" | "lessons" | "idea" | "actions">>;
  cites: Cited[];
}> {
  const { promptId } = point;
  const stage = PlannerStage.options.find((one) => STAGE_PROMPT_IDS[one] === promptId);
  const runFour = stage === undefined && promptId === "personal_run" && Number(point.promptVersion) >= 4;
  if (stage === undefined && !runFour) return { parts: {}, cites: [] };
  const { ctx } = call;
  // A lessons run queued with its lessons is shown those still in force, and no other; one queued
  // before, or a trial, which writes nothing, the lessons in force now.
  const given = stage === "lessons" && stored.lessons !== null;
  // A lessons run shown the owner's actions is shown only lessons within its label.
  const { within } = stored;
  const lessons = (
    await ctx.run<{ id: HypothesisId; compartments: string[]; body_enc: unknown }>(
      given ? SQL.lessonsGiven : SQL.lessons,
      given ? [stored.lessons] : [],
    )
  ).flatMap((row) => {
    if (within !== null && !row.compartments.every((one) => within.includes(one))) return [];
    const lesson = servedOrNull(
      call.ctx.keys,
      row.compartments,
      { table: "ledger.hypotheses", id: row.id, column: "body_enc" },
      row.body_enc,
    );
    return lesson === null ? [] : [{ id: row.id, lesson }];
  });
  const lessonCites = lessons.map((one): Cited => ["hypothesis", one.id]);
  if (stage === "lessons") {
    // The owner's actions its row names, built by code; none for a run queued without them.
    if (within === null) return { parts: { lessons }, cites: lessonCites };
    const actions = await ownerActions(call, stored.id, (compartments, at, envelope) =>
      servedOrNull(call.ctx.keys, compartments, at, envelope),
    );
    return { parts: { lessons, actions }, cites: lessonCites };
  }
  const [mission] = await ctx.run<{ compartments: string[]; text_enc: unknown }>(SQL.mission, []);
  const parts = {
    lessons,
    mission:
      mission === undefined ? null : servedOrNull(call.ctx.keys, mission.compartments, MISSION_AT, mission.text_enc),
  };
  if (stage === "ideas" || stage === undefined) return { parts, cites: [] };
  const anchor = anchors.find((one) => one.ref_kind === "hypothesis");
  const [row] =
    anchor === undefined
      ? []
      : await ctx.run<{
          id: HypothesisId;
          compartments: string[];
          body_enc: unknown;
          about_kind: string;
          about_id: string | null;
        }>(SQL.idea, [anchor.ref_id]);
  if (row === undefined) return { parts: { ...parts, idea: null }, cites: [] };
  const basis = (await ctx.run<{ ref_kind: string; ref_id: string }>(SQL.ideaBasis, [row.id])).map((ref) =>
    storedRef(ref.ref_kind, ref.ref_id),
  );
  const summary = servedOrNull(
    call.ctx.keys,
    row.compartments,
    { table: "ledger.hypotheses", id: row.id, column: "body_enc" },
    row.body_enc,
  );
  return {
    parts: {
      ...parts,
      idea: { id: row.id, about: storedAbout(row.about_kind, row.about_id), summary, basis },
    },
    cites: [["hypothesis", row.id]],
  };
}
