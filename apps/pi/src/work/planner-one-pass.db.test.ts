import { RUN_PROMPT, STAGE_PROMPTS } from "@intelligence/personal-ladder";
import { scanForPlaintext } from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it } from "vitest";
import { answer, type Harness, type Recorded, recorded, requested, workHarness } from "../test-support/work-harness.ts";

// End to end under the one-pass planner: the run `pi work run` queues is
// personal_run 4 at run_outcome 13, given the owner's mission; the owner's answers on its proposals
// raise a lessons run, which runs the lessons prompt; and once the owner confirms its lesson, the next
// personal_run is given it. The real `pi`, `pi mcp` and runOnce; a recorded model; made-up words only.

const LONG = 600_000;
const MISSION = "Help me meet the people behind the lab CANARY-MISSION-Q4V8";
const LESSON = "Prefers a named introduction to a cold note CANARY-LESSON-M2D5";
const NOTE = "not now CANARY-NOTE-W9K1";

const unescapeEntities = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// One block of a run's first user message, and every block's name, in order.
const firstText = (model: Recorded): string => {
  const first = model.requests[0]?.messages[0];
  return first?.role === "user" ? first.text : "";
};
function block(model: Recorded, slot: string): unknown {
  const found = new RegExp(`<data slot="${slot}">\\n(.*)\\n</data>`).exec(firstText(model))?.[1];
  if (found === undefined) throw new Error(`no ${slot} block`);
  return JSON.parse(unescapeEntities(found));
}
const slots = (model: Recorded): string[] =>
  [...firstText(model).matchAll(/<data slot="([a-z]+)">/g)].map((match) => match[1] as string);

describe("the one-pass planner reads the mission and lessons, and learns lessons", () => {
  let h: Harness | undefined;
  afterAll(async () => {
    await h?.cleanup();
  });

  it(
    "personal_run 4 is given the mission, the owner's answers on its work raise a lessons run under one_pass, and the lesson the owner confirms reaches the next run",
    async () => {
      const harness = await workHarness({ worker: false, queue: "request", planner: "one_pass" });
      h = harness;
      const { ids } = harness;
      const run = async (
        what: string,
        result: Promise<{ exit: number | null; stdout: string; stderr: string }>,
      ): Promise<{ stdout: string }> => {
        const done = await result;
        expect(done.exit, `${what}: ${done.stderr}`).toBe(0);
        return done;
      };
      await run("mission set", harness.terminal(["work", "mission", "set"], MISSION));

      // 1. The run `pi work run` queued: personal_run 4 at run_outcome 13, sent version 4's text,
      // with the mission and an empty lessons block after the anchors.
      expect(
        await harness.rows(
          "select wake_source, definition_version, prompt_id, prompt_version from ledger.runs where id = $1",
          [ids.run],
        ),
      ).toEqual([
        { wake_source: "owner_request", definition_version: 13, prompt_id: "personal_run", prompt_version: "4" },
      ]);
      const basis = [{ kind: "message", id: ids.cited }];
      const about = { kind: "entity", id: ids.participant };
      const actions = [
        {
          do: "investigate",
          kind: "open_loop",
          about,
          summary: "You seem to be looking for a way into the lab through the person you met.",
          basis,
        },
        {
          do: "propose",
          kind: "investigate",
          about,
          hypothesis: 0,
          summary: "Research the lab's founders and who could introduce you to them.",
          basis,
        },
        {
          do: "propose",
          kind: "follow_up",
          about,
          hypothesis: 0,
          summary: "Draft a note to the person you met asking about the lab's founders.",
          basis,
        },
      ];
      const firstModel = recorded([answer({ actions })]);
      expect(await harness.reason(firstModel)).toMatchObject({ exit: 0, run: ids.run });
      expect(firstModel.requests[0]?.system).toBe(RUN_PROMPT.text);
      expect(slots(firstModel)).toEqual([
        "source",
        "anchors",
        "mission",
        "lessons",
        "goals",
        "open",
        "closed",
        "intentions",
      ]);
      expect(block(firstModel, "mission")).toEqual({ untrusted: MISSION });
      expect(block(firstModel, "lessons")).toEqual([]);
      const work = await harness.rows<{ id: string; kind: string }>(
        "select id, kind from ledger.opportunities where run_id = $1 order by kind",
        [ids.run],
      );
      expect(work.map((one) => one.kind)).toEqual(["follow_up", "investigate"]);

      // 2. The tick raises a card for each piece of work; the owner says go to one and no_go, with a
      // note, to the other. The runs the tick queued for the meeting and the goal are taken first.
      await run("work tick", harness.tickProcess());
      await harness.drain();
      const cards = await harness.rows<{ id: string; target_id: string }>(
        "select id, target_id from ledger.cards where kind = 'opportunity_decision' order by target_id",
      );
      expect(cards.map((card) => card.target_id).sort()).toEqual(work.map((one) => one.id).sort());
      const cardOf = (kind: string): string =>
        cards.find((card) => card.target_id === work.find((one) => one.kind === kind)?.id)?.id ?? "";
      await run("decide go", harness.owner(["decide", cardOf("investigate"), "--answer", "go"]));
      await run("decide no_go", harness.owner(["decide", cardOf("follow_up"), "--answer", "no_go", "--note", NOTE]));

      // 3. Two answers, with N set to 2: under one_pass the tick queues one lessons run, which runs
      // the lessons prompt, given the decided work with the owner's answers and note.
      await run("work budget", harness.owner(["work", "budget", "--lessons-every", "2"]));
      await harness.tick(harness.at(1_000));
      const lessonsRuns = await harness.rows<{
        id: string;
        wake_key: string;
        definition_version: number;
        prompt_id: string;
        prompt_version: string;
      }>(
        "select id, wake_key, definition_version, prompt_id, prompt_version from ledger.runs where wake_source = 'lessons_due'",
      );
      expect(lessonsRuns.map(({ id: _id, ...rest }) => rest)).toEqual([
        { wake_key: "lessons:1", definition_version: 13, prompt_id: "personal_lessons", prompt_version: "4" },
      ]);
      const decided = work.map((one) => ({ kind: "opportunity", id: one.id }));
      const lessonsModel = recorded([answer({ lessons: [{ lesson: LESSON, basis: decided }] })]);
      expect(await harness.reason(lessonsModel)).toMatchObject({ exit: 0, run: lessonsRuns[0]?.id });
      expect(lessonsModel.requests[0]?.system).toBe(STAGE_PROMPTS.lessons.text);
      expect(block(lessonsModel, "closed")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rowKind: "opportunity",
            id: work.find((one) => one.kind === "investigate")?.id,
            decision: "go",
          }),
          expect.objectContaining({
            rowKind: "opportunity",
            id: work.find((one) => one.kind === "follow_up")?.id,
            decision: "no_go",
            note: { untrusted: NOTE },
          }),
        ]),
      );
      const [lesson] = await harness.rows<{ id: string }>("select id from ledger.hypotheses where kind = 'lesson'");

      // 4. The lesson's card; the owner confirms it.
      await harness.tick(harness.at(2_000));
      const lessonCards = await harness.rows<{ id: string }>(
        "select id from ledger.cards where kind = 'lesson' and target_id = $1",
        [lesson?.id],
      );
      expect(lessonCards).toHaveLength(1);
      await run("decide confirm", harness.owner(["decide", lessonCards[0]?.id ?? "", "--answer", "confirm"]));

      // 5. The next personal_run is given the lesson and the mission.
      const nextModel = recorded([answer({ actions: [{ do: "ignore", reason: "nothing_to_do" }] })]);
      const next = await requested(harness, nextModel);
      expect(next.exit).toBe(0);
      expect(await harness.rows("select prompt_id, prompt_version from ledger.runs where id = $1", [next.run])).toEqual(
        [{ prompt_id: "personal_run", prompt_version: "4" }],
      );
      expect(nextModel.requests[0]?.system).toBe(RUN_PROMPT.text);
      expect(block(nextModel, "lessons")).toEqual([{ id: lesson?.id, lesson: { untrusted: LESSON } }]);
      expect(block(nextModel, "mission")).toEqual({ untrusted: MISSION });

      // The mission, the note and the lesson are sealed everywhere.
      expect(
        await scanForPlaintext(harness.db.urls.admin, [
          "CANARY-MISSION-Q4V8",
          "CANARY-LESSON-M2D5",
          "CANARY-NOTE-W9K1",
        ]),
      ).toEqual([]);
    },
    LONG,
  );
});
