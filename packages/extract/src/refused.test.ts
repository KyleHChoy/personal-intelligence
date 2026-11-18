import { createHash } from "node:crypto";
import type { ModelRequest } from "@intelligence/contracts";
import { REASK_WINDOW } from "@intelligence/personal-core/planner";
import { type ModelClient, type Prompt, promptTextHash } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { EXTRACT_GENERATION } from "./config.ts";
import { interpret, readStored } from "./interpret.ts";
import { messageData } from "./message.ts";
import { PROMPT_IDS, PROMPT_VERSIONS } from "./message-prompts.ts";
import { CALLED_PROMPTS, EXTRACT_PROMPTS, promptFor, REPLAYED_VERSIONS } from "./prompts.ts";
import { REASK_NOTE, REASK_SUFFIX } from "./reask-prompt.ts";
import { REFUSALS_SHOW_CHARS, refusalsReportLines, runRefusals, shownSegment } from "./refusals.ts";
import { narrowingAfter } from "./refused.ts";
import { dueOf, MODEL_ID, processOne, recordsOf, type Setup, setup, unmappedOf } from "./test-support/support.ts";

// What becomes of a refused candidate: the codes its row keeps, the repair behind PI_EXTRACT_REPAIR,
// the one re-ask behind PI_EXTRACT_REASK, and the read that measures both, on the memory store.

type Claim = { fields: Record<string, unknown>; [key: string]: unknown };
type Output = { claims: Claim[]; narrowing: string };

// A plan whose `what` is the source's sentence, and the model's answers with that `what` changed.
function planOf(s: Setup): { id: string; output: Output; what: string } {
  const id = s.w.handles.planMessageId;
  const output = structuredClone(s.store.outputs[s.store.evidenceIdOf(id)]) as Output;
  return { id, output, what: output.claims[0]?.fields.what as string };
}
const answerWith = (output: Output, what: string): Output => ({
  ...output,
  claims: output.claims.map((claim) => ({ ...claim, fields: { ...claim.fields, what } })),
});

// Answers the first ask and the re-ask apart, and keeps every request.
function answers(s: Setup, id: string, first: unknown, again?: unknown): ModelRequest[] {
  const evidence = s.store.evidenceIdOf(id);
  const asked: ModelRequest[] = [];
  const one = fakeModelClient({ ...s.store.outputs, [evidence]: first });
  const two = fakeModelClient({ ...s.store.outputs, [evidence]: again ?? first });
  const model: ModelClient = {
    complete: (request) => {
      asked.push(request);
      return (request.promptId.endsWith(REASK_SUFFIX) ? two : one).complete(request);
    },
    embed: (request) => one.embed(request),
  };
  s.deps.model = model;
  return asked;
}

// The wording the correspondence lane's re-ask is counted under.
const REASK_PROMPT = CALLED_PROMPTS.find(
  (one) => one.id === `${PROMPT_IDS.correspondence}${REASK_SUFFIX}` && one.version === PROMPT_VERSIONS.correspondence,
) as Prompt;
const WORDING = `${REASK_PROMPT.id}@${REASK_PROMPT.version}#${REASK_PROMPT.textHash.slice(0, 12)}`;

const itemStatus = (s: Setup, id: string) => s.store.item(s.store.evidenceIdOf(id))?.status;
const REWORDED = (what: string) => what.replace("at the harbour", "at a harbour").replace(/\.$/u, "");
const INVENTED = "Lunch at the station is booked for everyone";

describe("a refused candidate's row", () => {
  it("names the field and what failed of it, in code's words, never the value", async () => {
    const s = await setup();
    const { id, output } = planOf(s);
    answers(s, id, answerWith(output, INVENTED));
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
    const [row] = unmappedOf(s, id);
    expect(row).toMatchObject({ proposedType: "plan", reason: "bad_fields", field: "what", issue: "not_in_passage" });
    expect(JSON.stringify(row)).not.toContain("station");
  });

  it("names what the type's schema refused, which the shared check does not say", async () => {
    const s = await setup();
    const { id, output } = planOf(s);
    const [claim] = output.claims;
    answers(s, id, { ...output, claims: [{ ...claim, fields: { ...claim?.fields, made_up: "x" } }] });
    await processOne(s, id);
    expect(unmappedOf(s, id)[0]).toMatchObject({ reason: "bad_fields", issue: "unknown_field" });
  });
});

describe("the repair, PI_EXTRACT_REPAIR", () => {
  it("is off by default: a reworded value stays refused", async () => {
    const s = await setup();
    const { id, output, what } = planOf(s);
    answers(s, id, answerWith(output, REWORDED(what)));
    expect(await processOne(s, id)).toMatchObject({ claims: 0, unmapped: 1 });
    expect(itemStatus(s, id)).not.toHaveProperty("repaired");
  });

  it("on, a near miss is kept in the source's own words, and counted by rule with no value", async () => {
    const s = await setup({ repair: true });
    const { id, output, what } = planOf(s);
    answers(s, id, answerWith(output, REWORDED(what)));
    expect(await processOne(s, id)).toMatchObject({ claims: 1, unmapped: 0 });
    const [record] = recordsOf(s, id);
    expect(record?.claim.content.fields.what).toBe(what.replace(/\.$/u, ""));
    expect(JSON.stringify(record?.claim)).not.toContain("at a harbour");
    const line = s.log.lines.find((one) => one.event.event === "extract_repaired");
    expect(line?.event).toMatchObject({ counts: { word_window: 1 } });
    expect(JSON.stringify(line)).not.toContain("harbour");
  });

  it("gives the fact key the exact copy gets, so a repaired claim joins that fact", async () => {
    const exact = await setup();
    const plan = planOf(exact);
    await processOne(exact, plan.id);
    const repaired = await setup({ repair: true });
    answers(repaired, plan.id, answerWith(plan.output, REWORDED(plan.what)));
    await processOne(repaired, plan.id);
    expect(recordsOf(repaired, plan.id)[0]?.factKey).toBe(recordsOf(exact, plan.id)[0]?.factKey);
  });

  it("on, an invented value stays refused", async () => {
    const s = await setup({ repair: true });
    const { id, output } = planOf(s);
    answers(s, id, answerWith(output, INVENTED));
    expect(await processOne(s, id)).toMatchObject({ claims: 0, unmapped: 1 });
    expect(unmappedOf(s, id)[0]).toMatchObject({ field: "what", issue: "not_in_passage" });
  });

  it("replays to the same claim, with no request; the claim id is the candidate's whichever way the switch stands", async () => {
    const s = await setup();
    const { id, output, what } = planOf(s);
    const asked = answers(s, id, answerWith(output, REWORDED(what)));
    await processOne(s, id);
    const refusedId = unmappedOf(s, id)[0]?.id;
    // The same saved answer, due again, with the switch now on.
    s.deps.repair = true;
    s.deps.generation = EXTRACT_GENERATION;
    await s.store.defer(s.store.evidenceIdOf(id) as never, EXTRACT_GENERATION, {
      code: "commit_failed",
      lane: "correspondence",
    });
    expect(await processOne(s, id)).toMatchObject({ claims: 1, unmapped: 0 });
    expect(asked).toHaveLength(1);
    expect(recordsOf(s, id)[0]?.claim.id).toBe(refusedId);
  });
});

describe("the re-ask, PI_EXTRACT_REASK", () => {
  it("is off by default: one call", async () => {
    const s = await setup();
    const { id, output } = planOf(s);
    const asked = answers(s, id, answerWith(output, INVENTED));
    await processOne(s, id);
    expect(asked).toHaveLength(1);
  });

  it("asks once, the reason as a code alone, and keeps the second answer beside the first's refusal", async () => {
    const s = await setup({ reask: true });
    const { id, output, what } = planOf(s);
    const asked = answers(s, id, answerWith(output, INVENTED), output);
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1, unmapped: 1 });
    expect(asked.map((one) => one.promptId)).toEqual([
      PROMPT_IDS.correspondence,
      `${PROMPT_IDS.correspondence}${REASK_SUFFIX}`,
    ]);
    const [, again] = asked;
    // Codes alone in its own slot; the first answer's words nowhere in the request.
    expect(again?.data.refused).toBe('{"refused":["not_in_passage"]}');
    expect(JSON.stringify(again?.data)).not.toContain("station");
    expect(Object.keys(again?.data ?? {}).sort()).toEqual(["message", "refused"]);
    expect(recordsOf(s, id)[0]?.claim.content.fields.what).toBe(what);
    expect(itemStatus(s, id)).toMatchObject({ reasked: true });
  });

  it("never asks a third time, however the second answer is refused", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    const asked = answers(s, id, answerWith(output, INVENTED), answerWith(output, `${INVENTED} too`));
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 2 });
    expect(asked).toHaveLength(2);
  });

  it("a saved second answer's claims stay when the re-ask is switched off", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    const asked = answers(s, id, answerWith(output, INVENTED), output);
    await processOne(s, id);
    expect(recordsOf(s, id)).toHaveLength(1);
    delete s.deps.reask;
    await s.store.defer(s.store.evidenceIdOf(id) as never, EXTRACT_GENERATION, {
      code: "commit_failed",
      lane: "correspondence",
    });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1, unmapped: 1 });
    expect(asked).toHaveLength(2);
    expect(itemStatus(s, id)).toMatchObject({ reasked: true });
  });

  it("a saved second answer's claim stays when the repair is switched on, with no second claim for its fact", async () => {
    const s = await setup({ reask: true });
    const { id, output, what } = planOf(s);
    const asked = answers(s, id, answerWith(output, REWORDED(what)), output);
    await processOne(s, id);
    const kept = recordsOf(s, id).map((one) => one.claim.id);
    expect(kept).toHaveLength(1);
    s.deps.repair = true;
    await s.store.defer(s.store.evidenceIdOf(id) as never, EXTRACT_GENERATION, {
      code: "commit_failed",
      lane: "correspondence",
    });
    await processOne(s, id);
    expect(asked).toHaveLength(2);
    // One statement, one claim: the second answer's stands, and the repaired copy of it joins none.
    expect(recordsOf(s, id).map((one) => one.claim.id)).toEqual(kept);
  });

  it("codes that change buy no second re-ask: the saved call is the mark", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    const asked = answers(s, id, answerWith(output, INVENTED), output);
    // A re-ask saved under another code than today's check gives.
    const evidence = s.store.evidenceIdOf(id) as never;
    const opened = await s.store.open(evidence);
    const due = await dueOf(s.store, id);
    if (opened === null) throw new Error("no item");
    const { parsed, read } = await readStored(opened, due.compartments);
    const prompt = CALLED_PROMPTS.find(
      (one) =>
        one.id === `${PROMPT_IDS.correspondence}${REASK_SUFFIX}` && one.version === PROMPT_VERSIONS.correspondence,
    ) as Prompt;
    const data = { ...messageData(parsed, due.sentAt), refused: JSON.stringify({ refused: ["part_of_line"] }) };
    await interpret(prompt, data, parsed, read, { model: s.deps.model, calls: s.store.calls(MODEL_ID) });
    expect(asked).toHaveLength(1);
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(asked.map((one) => one.promptId)).toEqual([prompt.id, PROMPT_IDS.correspondence]);
  });

  it("a replay asks nothing and ends the same", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    const asked = answers(s, id, answerWith(output, INVENTED), output);
    await processOne(s, id);
    await s.store.defer(s.store.evidenceIdOf(id) as never, EXTRACT_GENERATION, {
      code: "commit_failed",
      lane: "correspondence",
    });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1, unmapped: 1 });
    expect(asked).toHaveLength(2);
  });

  it("is not asked of an item with a claim kept, or refused for anything but wording", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    const [claim] = output.claims;
    const asked = answers(s, id, {
      ...output,
      claims: [claim, { ...claim, fields: { ...claim?.fields, what: INVENTED } }],
    });
    await processOne(s, id);
    expect(asked).toHaveLength(1);

    const other = await setup({ reask: true });
    const asked2 = answers(other, id, {
      ...output,
      claims: [{ ...claim, fields: { ...claim?.fields, made_up: "x" } }],
    });
    await processOne(other, id);
    expect(asked2).toHaveLength(1);
  });

  it("a second answer that withholds withholds the item: a model can only narrow", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    answers(s, id, answerWith(output, INVENTED), { claims: [], narrowing: "quarantine" });
    expect(await processOne(s, id)).toMatchObject({ status: "withheld", code: "quarantine", claims: 0 });
  });

  it("a second answer never undoes the first's narrowing", () => {
    expect(narrowingAfter("participants_only", "none")).toBe("participants_only");
    expect(narrowingAfter("none", "participants_only")).toBe("participants_only");
    expect(narrowingAfter("none", "none")).toBe("none");
  });

  it("a second answer refused by its schema leaves the first's refusal, and the item done", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    answers(s, id, answerWith(output, INVENTED), "not json");
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
    expect(itemStatus(s, id)).not.toHaveProperty("reasked");
  });

  it("a commit records what its re-ask named and whether it rescued a claim", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    answers(s, id, answerWith(output, INVENTED), output);
    await processOne(s, id);
    const [rescued] = await s.store.reaskRates(WORDING);
    expect(rescued).toEqual({ code: "not_in_passage", asked: 1, rescued: 1 });

    const other = await setup({ reask: true });
    answers(other, id, answerWith(output, INVENTED), answerWith(output, `${INVENTED} too`));
    await processOne(other, id);
    expect(await other.store.reaskRates(WORDING)).toEqual([{ code: "not_in_passage", asked: 1, rescued: 0 }]);
    // A second answer with nothing to use was still asked, and rescued nothing.
    const unusable = await setup({ reask: true });
    answers(unusable, id, answerWith(output, INVENTED), "not json");
    await processOne(unusable, id);
    expect(await unusable.store.reaskRates(WORDING)).toEqual([{ code: "not_in_passage", asked: 1, rescued: 0 }]);
  });

  it("stops asking for a code whose last window of re-asks rescued nothing, and says so by code", async () => {
    const none = { codes: ["not_in_passage"], wording: WORDING, rescued: false };
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    s.store.noteReasks(Array.from({ length: REASK_WINDOW }, () => none));
    const asked = answers(s, id, answerWith(output, INVENTED), output);
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
    expect(asked).toHaveLength(1);
    expect(s.log.lines.map((line) => line.event)).toContainEqual(
      expect.objectContaining({ event: "extract_reask_stopped", code: "no_rescue" }),
    );
    // Not a re-ask: the stop adds nothing to the count.
    expect(await s.store.reaskRates(WORDING)).toEqual([{ code: "not_in_passage", asked: REASK_WINDOW, rescued: 0 }]);
  });

  it("goes on asking one short of a window, with one rescue in it, and under another wording", async () => {
    const none = { codes: ["not_in_passage"], wording: WORDING, rescued: false };
    const cases = [
      Array.from({ length: REASK_WINDOW - 1 }, () => none),
      [{ ...none, rescued: true }, ...Array.from({ length: REASK_WINDOW - 1 }, () => none)],
      // The wording changed: the old wording's count is not this one's.
      Array.from({ length: REASK_WINDOW }, () => ({ ...none, wording: WORDING.replace(/#.*/u, "#000000000000") })),
    ];
    for (const noted of cases) {
      const s = await setup({ reask: true });
      const { id, output } = planOf(s);
      s.store.noteReasks(noted);
      const asked = answers(s, id, answerWith(output, INVENTED), output);
      expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1 });
      expect(asked).toHaveLength(2);
    }
  });

  it("a re-ask saved before the stop still replays: its claim never goes by a replay", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    const asked = answers(s, id, answerWith(output, INVENTED), output);
    await processOne(s, id);
    s.store.noteReasks(
      Array.from({ length: REASK_WINDOW }, () => ({ codes: ["not_in_passage"], wording: WORDING, rescued: false })),
    );
    await s.store.defer(s.store.evidenceIdOf(id) as never, EXTRACT_GENERATION, {
      code: "commit_failed",
      lane: "correspondence",
    });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1, unmapped: 1 });
    expect(asked).toHaveLength(2);
  });

  it("the budget ends the run and commits nothing, so the item stays due", async () => {
    const s = await setup({ reask: true });
    const { id, output } = planOf(s);
    answers(s, id, answerWith(output, INVENTED));
    const model = s.deps.model;
    s.deps.model = {
      ...model,
      complete: (request) =>
        request.promptId.endsWith(REASK_SUFFIX)
          ? Promise.reject(Object.assign(new Error("budget_reached"), { code: "budget_reached" }))
          : model.complete(request),
    };
    await expect(processOne(s, id)).rejects.toThrow("budget_reached");
    expect(unmappedOf(s, id)).toEqual([]);
  });

  it("every message and finding version has its re-ask: the version's text, the pinned note and one slot more", () => {
    const base = promptFor("correspondence");
    const again = CALLED_PROMPTS.find(
      (one) => one.id === `${base.id}${REASK_SUFFIX}` && one.version === PROMPT_VERSIONS.correspondence,
    );
    expect(again?.instructions).toBe(`${base.instructions}\n\n${REASK_NOTE}`);
    expect(again?.slots).toEqual([...base.slots, "refused"]);
    const { textHash, ...rest } = again as NonNullable<typeof again>;
    expect(promptTextHash(rest)).toBe(textHash);
    for (const one of EXTRACT_PROMPTS.filter((prompt) =>
      [PROMPT_IDS.correspondence, PROMPT_IDS.transaction, PROMPT_IDS.agent].includes(prompt.id),
    ))
      expect(CALLED_PROMPTS.some((p) => p.id === `${one.id}${REASK_SUFFIX}` && p.version === one.version)).toBe(true);
    // A change of the note is a change of every re-ask's call key: it is pinned.
    expect(createHash("sha256").update(REASK_NOTE).digest("hex")).toBe(
      "e1e601236a2f5a64553e524b00946504703c3cf9219ae93dc5640c8fefc9db8f",
    );
  });
});

describe("what a replay may reach", () => {
  it("names no document's version: triage reads a document's age at the run, so a replay could delete its claims", () => {
    expect(Object.keys(REPLAYED_VERSIONS).sort()).toEqual(["agent", "correspondence", "transaction"]);
  });
});

describe("`pi extract refusals`", () => {
  it("replays what was refused, repair off and on, with no request and nothing written; code words only", async () => {
    const s = await setup();
    const { id, output, what } = planOf(s);
    const asked = answers(s, id, {
      ...output,
      claims: [
        { ...output.claims[0], fields: { ...output.claims[0]?.fields, what: REWORDED(what) } },
        { ...output.claims[0], fields: { ...output.claims[0]?.fields, what: INVENTED } },
      ],
    });
    await processOne(s, id);
    expect(asked).toHaveLength(1);
    const before = JSON.stringify([s.store.claims(), s.store.unmapped()]);
    const report = await runRefusals(s.deps, 10);
    expect(asked).toHaveLength(1);
    expect(JSON.stringify([s.store.claims(), s.store.unmapped()])).toBe(before);
    expect(report).toMatchObject({
      items: 1,
      candidates: 2,
      refused: { "bad_fields plan.what:not_in_passage": 2 },
      stillRefused: { "bad_fields plan.what:not_in_passage": 1 },
      repaired: { word_window: 1 },
      reask: { repairOff: 1, repairOn: 0 },
    });
    const lines = refusalsReportLines(report);
    expect(lines.join("\n")).not.toMatch(/station|harbour/);
    expect(lines).toContain("repair_would_keep: 1 by word_window 1");
  });

  it("--show prints what each said", async () => {
    const s = await setup();
    const { id, output } = planOf(s);
    answers(s, id, answerWith(output, INVENTED));
    await processOne(s, id);
    const lines = refusalsReportLines(await runRefusals(s.deps, 10, { show: true }));
    const shown = lines.filter((one) => one.startsWith("show: "));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("station");
    expect(shown[0]).toContain("harbour");
    expect(shown[0]).toContain("repaired=null");
  });
});

describe("what `--show` prints of a segment", () => {
  const long = `${"filler ".repeat(100)}the station is closed ${"tail ".repeat(100)}`;

  it("is what stands around the value's longest word, within its cap, so a long message can be judged", () => {
    const shown = shownSegment(long, "the Station is closed");
    expect(shown.length).toBe(REFUSALS_SHOW_CHARS);
    expect(shown).toContain("the station is closed");
  });

  it("is the start when it fits, when the word is not there, or for a value with no text", () => {
    expect(shownSegment("short text", "absent")).toBe("short text");
    expect(shownSegment(long, "absent")).toBe(long.slice(0, REFUSALS_SHOW_CHARS));
    expect(shownSegment(long, { domain: "admin" })).toBe(long.slice(0, REFUSALS_SHOW_CHARS));
  });
});
