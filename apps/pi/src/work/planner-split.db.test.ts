import { ClosedCase } from "@intelligence/contracts/personal";
import { STAGE_PROMPTS } from "@intelligence/personal-ladder";
import { scanForPlaintext } from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it } from "vitest";
import { answer, type Harness, type Recorded, recorded, requested, workHarness } from "../test-support/work-harness.ts";

// The planner split, end to end: an ideas run, with the owner's mission, writes
// ideas; the tick raises an idea card for each; the owner pursues one with a note and declines the
// other; that pursue queues a translate run, given the idea, whose work rests on it; after N
// answers the tick queues a lessons run, given the decided ideas with the owner's answers and note;
// the lesson's card; and once the owner confirms it, the next ideas run is given the lesson. The real `pi`,
// `pi mcp` and runOnce; a recorded model; made-up words only.

const LONG = 600_000;
const MISSION = "Help me grow the lab and meet more founders CANARY-MISSION-H3K9";
const IDEA_A = "Ask the person you met about the trip to introduce you to the lab's founders CANARY-IDEA-P2W6";
const IDEA_B = "Plan a second trip around the conference next spring CANARY-IDEA-Z8J4";
const NOTE = "yes, and soon CANARY-NOTE-B5R1";
const LESSON = "Prefers named introductions to trips CANARY-LESSON-T7X3";

const unescapeEntities = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// One block of a run's first user message.
function block(model: Recorded, slot: string): unknown {
  const first = model.requests[0]?.messages[0];
  const found = new RegExp(`<data slot="${slot}">\\n(.*)\\n</data>`).exec(
    first?.role === "user" ? first.text : "",
  )?.[1];
  if (found === undefined) throw new Error(`no ${slot} block`);
  return JSON.parse(unescapeEntities(found));
}

describe("the planner split, end to end", () => {
  let h: Harness | undefined;
  afterAll(async () => {
    await h?.cleanup();
  });

  it(
    "ideas with the mission, the owner's pursue translated into work on the idea, and lessons the owner confirms reach the next run",
    async () => {
      const harness = await workHarness({ worker: false, queue: "request", planner: "split" });
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

      // The owner's mission, at a terminal only.
      await run("mission set", harness.terminal(["work", "mission", "set"], MISSION));
      expect(JSON.parse((await run("mission show", harness.terminal(["work", "mission", "show"]))).stdout)).toEqual({
        mission: MISSION,
        setAt: expect.any(String),
      });
      expect((await harness.owner(["work", "mission", "show"])).exit).toBe(1);

      // 1. The run `pi work run` queued is an ideas run: the ideas prompt, the mission in its block.
      expect(
        await harness.rows(
          "select wake_source, definition_version, prompt_id, prompt_version from ledger.runs where id = $1",
          [ids.run],
        ),
      ).toEqual([
        { wake_source: "owner_request", definition_version: 13, prompt_id: "personal_ideas", prompt_version: "4" },
      ]);
      const idea = (text: string, basis: unknown[]) => ({
        idea: text,
        why: "It moves the lab forward.",
        basis,
        confidence: 0.6,
        test: "Ask them.",
      });
      const ideasModel = recorded([
        answer({
          ideas: [
            idea(IDEA_A, [
              { kind: "entity", id: ids.participant },
              { kind: "message", id: ids.cited },
            ]),
            idea(IDEA_B, [{ kind: "message", id: ids.cited }]),
          ],
        }),
      ]);
      expect(await harness.reason(ideasModel)).toMatchObject({ exit: 0, run: ids.run });
      expect(ideasModel.overasked()).toBe(false);
      expect(ideasModel.requests[0]?.system).toBe(STAGE_PROMPTS.ideas.text);
      expect(block(ideasModel, "mission")).toEqual({ untrusted: MISSION });
      const ideas = await harness.rows<{
        id: string;
        kind: string;
        about_kind: string;
        about_id: string;
        case_id: string;
        about_owner: boolean;
      }>(
        "select id, kind, about_kind, about_id, case_id, about_owner from ledger.hypotheses where run_id = $1 order by about_kind",
        [ids.run],
      );
      expect(
        ideas.map(({ kind, about_kind, about_id, about_owner }) => ({ kind, about_kind, about_id, about_owner })),
      ).toEqual([
        { kind: "idea", about_kind: "entity", about_id: ids.participant, about_owner: false },
        { kind: "idea", about_kind: "message", about_id: ids.cited, about_owner: false },
      ]);
      expect(new Set(ideas.map((one) => one.case_id)).size).toBe(2);
      // An ideas run opens no work.
      expect(await harness.rows("select id from ledger.opportunities where run_id = $1", [ids.run])).toEqual([]);
      const [ideaA, ideaB] = ideas.map((one) => one.id);

      // 2. The tick raises a card for each idea; the owner pursues one with their note and says no to
      // the other. The runs the tick queued for the meeting and the goal are taken first, with an
      // ignore, which every stage takes.
      await run("work tick", harness.tickProcess());
      await harness.drain();
      const cards = await harness.rows<{ id: string; target_id: string }>(
        "select id, target_id from ledger.cards where kind = 'idea' order by target_id",
      );
      expect(cards.map((card) => card.target_id).sort()).toEqual([ideaA, ideaB].sort());
      const cardOf = (target: string | undefined): string => cards.find((card) => card.target_id === target)?.id ?? "";
      await run("decide pursue", harness.owner(["decide", cardOf(ideaA), "--answer", "pursue", "--note", NOTE]));
      await run("decide no", harness.owner(["decide", cardOf(ideaB), "--answer", "no"]));
      const status = async (id: string | undefined) =>
        (
          await harness.rows<{ event: string; by: string }>(
            "select event, by from ledger.record_events where row_kind = 'hypothesis' and row_id = $1 order by id desc limit 1",
            [id],
          )
        )[0];
      expect(await status(ideaA)).toEqual({ event: "pursued", by: "owner" });
      expect(await status(ideaB)).toEqual({ event: "rejected", by: "owner" });

      // 3. The pursue queued one translate run, anchored on the idea; it is given the idea, and its
      // work rests on it.
      const translated = await harness.rows<{ id: string; wake_key: string; prompt_id: string }>(
        "select id, wake_key, prompt_id from ledger.runs where wake_source = 'idea_pursued'",
      );
      expect(translated.map(({ wake_key, prompt_id }) => ({ wake_key, prompt_id }))).toEqual([
        { wake_key: `idea:${ideaA}`, prompt_id: "personal_translate" },
      ]);
      const proposal = {
        do: "propose",
        kind: "follow_up",
        about: { kind: "entity", id: ids.participant },
        summary: "Draft a note asking for an introduction to the lab's founders.",
        basis: [
          { kind: "hypothesis", id: ideaA },
          { kind: "message", id: ids.cited },
        ],
      };
      const translateModel = recorded([answer({ actions: [proposal] })]);
      expect(await harness.reason(translateModel)).toMatchObject({ exit: 0, run: translated[0]?.id });
      expect(translateModel.requests[0]?.system).toBe(STAGE_PROMPTS.translate.text);
      expect(block(translateModel, "idea")).toEqual({
        id: ideaA,
        about: { kind: "entity", id: ids.participant },
        summary: { untrusted: expect.stringContaining(IDEA_A) },
        basis: [
          { kind: "entity", id: ids.participant },
          { kind: "message", id: ids.cited },
        ],
      });
      expect(
        await harness.rows("select kind, hypothesis_id from ledger.opportunities where run_id = $1", [
          translated[0]?.id,
        ]),
      ).toEqual([{ kind: "follow_up", hypothesis_id: ideaA }]);

      // 4. Two answers, with N set to 2: the tick queues one lessons run, given the decided ideas
      // with the owner's answers and note.
      await run("work budget", harness.owner(["work", "budget", "--lessons-every", "2"]));
      // In this process, at a time outside the sweep's hour, so no sweep run is queued beside it.
      await harness.tick(harness.at(1_000));
      const lessonsRuns = await harness.rows<{ id: string; wake_key: string; prompt_id: string }>(
        "select id, wake_key, prompt_id from ledger.runs where wake_source = 'lessons_due'",
      );
      expect(lessonsRuns.map(({ wake_key, prompt_id }) => ({ wake_key, prompt_id }))).toEqual([
        { wake_key: "lessons:1", prompt_id: "personal_lessons" },
      ]);
      const lessonsModel = recorded([
        answer({
          lessons: [
            {
              lesson: LESSON,
              basis: [
                { kind: "hypothesis", id: ideaA },
                { kind: "hypothesis", id: ideaB },
              ],
            },
          ],
        }),
      ]);
      expect(await harness.reason(lessonsModel)).toMatchObject({ exit: 0, run: lessonsRuns[0]?.id });
      expect(lessonsModel.requests[0]?.system).toBe(STAGE_PROMPTS.lessons.text);
      const closed = block(lessonsModel, "closed") as unknown[];
      expect(closed.every((one) => ClosedCase.safeParse(one).success)).toBe(true);
      expect(closed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rowKind: "hypothesis",
            kind: "idea",
            id: ideaA,
            status: "pursued",
            decision: "pursue",
            note: { untrusted: NOTE },
          }),
          expect.objectContaining({
            rowKind: "hypothesis",
            kind: "idea",
            id: ideaB,
            status: "rejected",
            decision: "no",
          }),
        ]),
      );
      const [lesson] = await harness.rows<{ id: string; about_owner: boolean }>(
        "select id, about_owner from ledger.hypotheses where kind = 'lesson'",
      );
      expect(lesson?.about_owner).toBe(true);

      // 5. The lesson's card, and no question card, though the lesson is about the owner; the
      // owner confirms it.
      await harness.tick(harness.at(2_000));
      const lessonCards = await harness.rows<{ id: string; kind: string }>(
        "select id, kind from ledger.cards where target_id = $1",
        [lesson?.id],
      );
      expect(lessonCards.map((card) => card.kind)).toEqual(["lesson"]);
      await run("decide confirm", harness.owner(["decide", lessonCards[0]?.id ?? "", "--answer", "confirm"]));

      // 6. The next ideas run is given the lesson; no idea is a silence.
      const nextModel = recorded([answer({ ideas: [] })]);
      const next = await requested(harness, nextModel);
      expect(next.exit).toBe(0);
      expect(block(nextModel, "lessons")).toEqual([{ id: lesson?.id, lesson: { untrusted: LESSON } }]);
      expect(await harness.rows("select reason from ledger.silences where run_id = $1", [next.run])).toEqual([
        { reason: "nothing_to_do" },
      ]);

      // 7. `pi work run --idea` queues the pursued idea's translate run again, under
      // a key of its own and the current translate prompt, anchored on the idea; an idea the owner
      // did not pursue is refused.
      expect((await harness.owner(["work", "run", "--idea", ideaB ?? ""])).exit).not.toBe(0);
      const again = JSON.parse(
        (await run("work run --idea", harness.owner(["work", "run", "--idea", ideaA ?? ""]))).stdout,
      ) as { run: string };
      expect(
        await harness.rows("select wake_source, wake_key, prompt_id, prompt_version from ledger.runs where id = $1", [
          again.run,
        ]),
      ).toEqual([
        {
          wake_source: "idea_pursued",
          wake_key: `idea:${ideaA}:2`,
          prompt_id: "personal_translate",
          prompt_version: "5",
        },
      ]);
      expect(
        await harness.rows("select ref_kind, ref_id from ledger.basis where row_kind = 'run' and row_id = $1", [
          again.run,
        ]),
      ).toEqual([{ ref_kind: "hypothesis", ref_id: ideaA }]);

      // The mission, the ideas, the note and the lesson are sealed everywhere.
      expect(
        await scanForPlaintext(harness.db.urls.admin, [
          "CANARY-MISSION-H3K9",
          "CANARY-IDEA-P2W6",
          "CANARY-IDEA-Z8J4",
          "CANARY-NOTE-B5R1",
          "CANARY-LESSON-T7X3",
        ]),
      ).toEqual([]);
    },
    LONG,
  );
});
