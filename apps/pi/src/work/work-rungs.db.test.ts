import { spawn } from "node:child_process";
import {
  currentDefinition,
  DECISION_POINT_PINS,
  DECISION_POINTS,
  type DecisionPointDefinition,
  EFFECT_CLASS,
  type EffectName,
  type EventId,
  OWNER_ONLY_EFFECTS,
  PROMPT_PINS,
} from "@intelligence/contracts/personal";
import { FOLD_SETUP } from "@intelligence/personal-core/testing";
import { loadRegistry, REGISTRY, RegistryRefused } from "@intelligence/personal-ladder";
import { describe, expect, it } from "vitest";
import { count, evt, LONG, MAIN, NOT_PERMITTED, ok, propose, withHarness } from "../test-support/work-gate-fixtures.ts";
import {
  answer,
  type Harness,
  MINUTE,
  type Result,
  recorded,
  requested,
  requestId,
  untilClaim,
} from "../test-support/work-harness.ts";

// Shared setup is in work-gate-fixtures.ts.

describe("durable work: rungs, effects and refusals", () => {
  it(
    "W1 no definition lets rung 1, 2 or 3 cause an external effect, nor any rung but 4 an owner-only one: the registry refuses each, the one that ships has none, and a tick with a bad one cannot start",
    async () => {
      // The registry that ships, extraction's two points among the seven, every version of each.
      const shipped = REGISTRY.all().map((point) => point.definition);
      expect(shipped.map((one) => one.id).sort()).toEqual(DECISION_POINTS.map((one) => one.id).sort());
      expect(shipped.map((one) => one.id)).toEqual(expect.arrayContaining(["extract_triage", "extract_claims"]));
      for (const definition of shipped) {
        const effects = Object.values(definition.outputs) as EffectName[];
        if (definition.rungs.some((rung) => rung >= 1 && rung <= 3))
          expect(
            effects.filter((effect) => EFFECT_CLASS[effect] === "external"),
            definition.id,
          ).toEqual([]);
        if (definition.rungs.some((rung) => rung !== 4))
          expect(
            effects.filter((effect) => (OWNER_ONLY_EFFECTS as readonly string[]).includes(effect)),
            definition.id,
          ).toEqual([]);
      }

      // The registry refuses each.
      const moveClear = currentDefinition("move_clear");
      const refusal = (definition: DecisionPointDefinition): string => {
        try {
          loadRegistry([definition], DECISION_POINT_PINS, PROMPT_PINS);
          return "loaded";
        } catch (error) {
          return error instanceof RegistryRefused ? error.code : "other";
        }
      };
      expect(refusal({ ...moveClear, rungs: [3], outputs: { clear: "clear_external_move", refuse: "hold" } })).toBe(
        "model_external",
      );
      expect(refusal({ ...moveClear, outputs: { clear: "give_consent", refuse: "hold" } })).toBe("owner_only");
      expect(refusal(moveClear)).toBe("loaded");

      // The hook is registered before anything else is imported, the fold setup included, which
      // loads the contracts too; a process the hook never changed exits 2.
      await withHarness({}, async (h) => {
        const MOVE_CLEAR =
          'freeze({ id: "move_clear", version: 1, rungs: [0], outputs: { clear: "clear_internal_move", refuse: "hold" } })';
        const BROKEN =
          'freeze({ id: "move_clear", version: 1, rungs: [3], outputs: { clear: "clear_external_move", refuse: "hold" } })';
        const hookOf = (replacement: string): string =>
          `data:text/javascript,${encodeURIComponent(
            [
              'import { registerHooks } from "node:module";',
              `const target = ${JSON.stringify(MOVE_CLEAR)};`,
              `const replacement = ${JSON.stringify(replacement)};`,
              "let changed = false;",
              'process.on("exit", () => { if (!changed) process.exitCode = 2; });',
              "registerHooks({ load(url, context, next) {",
              "  const loaded = next(url, context);",
              '  if (!url.endsWith("/packages/contracts/src/personal/ladder.ts")) return loaded;',
              '  const text = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");',
              '  if (!text.includes(target)) throw new Error("the hook found no definition to change");',
              "  changed = true;",
              "  return { ...loaded, source: text.replace(target, replacement) };",
              "} });",
            ].join("\n"),
          )}`;
        const tickWith = (hook: string): Promise<Result> =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, ["--import", hook, "--import", FOLD_SETUP, MAIN, "work", "tick"], {
              env: { PATH: process.env.PATH ?? "", ...h.env.work },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
            child.on("close", (exit) => resolve({ exit, stdout, stderr }));
          });
        // A new goal, so a tick that started would queue a run for its wake.
        ok(await h.owner(["goal", "add", "--domain", "interests"], "Read one book a month\n"), "goal add");
        const runs = await count(h, "ledger.runs");
        expect(await tickWith(hookOf(BROKEN))).toEqual({
          exit: 1,
          stdout: "",
          stderr: '{"event":"command_failed","code":"model_external"}\n',
        });
        expect(await count(h, "ledger.runs")).toBe(runs);
        // The positive control: the same hook, changing nothing, and the tick runs.
        expect(await tickWith(hookOf(MOVE_CLEAR))).toMatchObject({ exit: 0 });
        expect(await count(h, "ledger.runs")).toBe(runs + 1);
      });
    },
    LONG,
  );

  const LINKS: [name: string, remove: (h: Harness) => Promise<void>][] = [
    ["intent revoke", async (h) => void ok(await h.owner(["intent", "revoke", h.ids.intent ?? ""]))],
    ["harness revoke", async (h) => void ok(await h.owner(["harness", "revoke", h.ids.harnessModes[0] ?? ""]))],
    ["veto add", async (h) => void ok(await h.owner(["veto", "add", "--kind", "meeting_prep"]))],
    ["work stop", async (h) => void ok(await h.owner(["work", "stop"]))],
    // A tick after the lease's 30 minutes returns the opportunity to go. The lease runs from the
    // claim, by the database's clock, and the claim comes as late after the harness started as
    // the setup takes under load: the tick is a minute after the lease's end, never before.
    [
      "the lease let run out",
      async (h) => {
        const [lease] = await h.rows<{ until: Date }>(
          "select lease_until as until from queue.leases where resource_kind = 'opportunity'",
        );
        const after = Math.max(31 * MINUTE, (lease?.until.getTime() ?? 0) + MINUTE - h.now.getTime());
        await h.tick(h.at(after));
      },
    ],
    [
      "the cited message deleted at the source and synced",
      async (h) => {
        h.sources[0]?.gmail.deletePermanently(h.ids.citedGmail);
        await h.sync();
      },
    ],
  ];
  const refusals: string[] = [];
  for (const [name, remove] of LINKS) {
    it(
      `W2 with one link of the chain removed (${name}), plan_move answers not_permitted and no move exists`,
      () =>
        withHarness({}, async (h) => {
          const { opportunity, worker } = await untilClaim(h);
          await remove(h);
          const refused = await worker.tool("plan_move", { opportunity, stage: "prepare", requestId: requestId() });
          expect(refused).toEqual(NOT_PERMITTED);
          refusals.push(JSON.stringify(refused));
          expect(await count(h, "ledger.moves")).toBe(0);
          expect(await h.rows("select output from ledger.decision_point_calls where point = 'move_clear'")).toEqual([
            { output: "refuse" },
          ]);
        }),
      LONG,
    );
  }
  it("W2 the refusals are equal as JSON", () => {
    expect(refusals).toHaveLength(LINKS.length);
    expect(new Set(refusals).size).toBe(1);
  });

  it(
    "at plan_move: a basis that gains an event the owner did not accept, which it is not about, clears no move under a go policy decided",
    () =>
      withHarness({}, async (h) => {
        const { opportunity, worker } = await untilClaim(h);
        const [invited, ...more] = await h.rows<{ id: EventId }>(
          "select e.id from knowledge.events e where e.compartments = '{own}' and not ledger.owner_backed('event', e.id)",
        );
        expect(more).toEqual([]);
        if (invited === undefined) throw new Error("the world has an invitation the owner has not answered");
        // A later run proposes the same case, so its ref joins the claimed opportunity's basis.
        const model = recorded([answer({ actions: [propose("meeting_prep", evt(h.ids.event), [evt(invited.id)])] })]);
        expect((await requested(h, model)).exit).toBe(0);
        expect(
          await h.rows(
            "select ref_id, owner_backed from ledger.basis where row_kind = 'opportunity' and row_id = $1 order by id",
            [opportunity],
          ),
        ).toEqual([
          { ref_id: h.ids.event, owner_backed: true },
          { ref_id: h.ids.cited, owner_backed: true },
          { ref_id: invited.id, owner_backed: false },
        ]);
        expect(await worker.tool("plan_move", { opportunity, stage: "prepare", requestId: requestId() })).toEqual(
          NOT_PERMITTED,
        );
        expect(await count(h, "ledger.moves")).toBe(0);
      }),
    LONG,
  );
});
