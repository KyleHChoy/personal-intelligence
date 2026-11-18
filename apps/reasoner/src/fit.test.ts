import { compactResult, EntityView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fitResult } from "./fit.ts";
import { runLoop } from "./loop.ts";
import {
  answer,
  bigEntity,
  bigSelfPage,
  calls,
  fakeAgentApi,
  fakeTurnModel,
  IGNORE,
  memoryLogger,
  runRequest,
} from "./test-support/run-doubles.ts";

// get_self and get_entity over the reasoner's cap, cut to fit (fit.ts). get_entity's compiled
// facts are of the size a live profile reaches: about seventy beliefs from agents' findings the
// owner confirmed and sixty from the owner's own mail, each citing three facts. get_self's page is
// its worst case: 66 long lines, 20 contacts and 30 meetings.

const CAP = 70_000;
const codePoints = (text: string): number => [...text].length;
type Sent = { names: unknown[]; facts: { beliefs: Record<string, unknown>[]; claims?: unknown[]; more: boolean } };
type SentSelf = {
  contacts: unknown[];
  upcoming: unknown[];
  sections: { domain: string; lines: { fact: string }[]; more?: boolean }[];
};

describe("a card's facts cut to fit", () => {
  it("a card with the agents' beliefs comes back with every belief, cut to its latest cite, and without the facts in no belief", () => {
    const entity = bigEntity();
    expect(codePoints(JSON.stringify(entity))).toBeGreaterThan(5 * CAP);
    const fitted = fitResult("get_entity", entity, CAP);
    expect(fitted).not.toBeNull();
    expect(codePoints(fitted?.text ?? "")).toBeLessThanOrEqual(CAP);
    const sent = JSON.parse(fitted?.text ?? "null") as Sent;
    expect(sent.facts.beliefs).toHaveLength(130);
    // The twenty facts that rest in no belief went, so more says a list was cut.
    expect(sent.facts.claims).toBeUndefined();
    expect(fitted?.dropped).toBe(20);
    expect(sent.facts.more).toBe(true);
    const whole = compactResult("get_entity", entity) as Sent;
    expect(sent.names).toEqual(whole.names);
    // Each belief is its wire form (compactResult) with its latest cite alone.
    whole.facts.beliefs.forEach((source, index) => {
      const { id: _id, ...latest } = (source.cites as Record<string, unknown>[])[0] ?? {};
      expect(sent.facts.beliefs[index]).toEqual({ ...source, cites: [latest] });
    });
    // No belief's fingerprint or claim id reaches the model, nor a default below the top level.
    for (const hidden of ['"fact":', '"state":', '"stated_fact"']) expect(fitted?.text).not.toContain(hidden);
    expect(fitted?.text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("a card too large even so keeps its most recently confirmed beliefs, in order, and says more", () => {
    const entity = bigEntity({ agent: 120, mail: 80 });
    const fitted = fitResult("get_entity", entity, CAP);
    const sent = JSON.parse(fitted?.text ?? "null") as Sent;
    expect(codePoints(fitted?.text ?? "")).toBeLessThanOrEqual(CAP);
    expect(sent.facts.more).toBe(true);
    expect(sent.facts.claims).toBeUndefined();
    const kept = sent.facts.beliefs.map((belief) => belief.confirmedAt);
    expect(kept.length).toBeGreaterThan(100);
    expect(kept).toEqual(entity.facts!.beliefs.slice(-kept.length).map((belief) => belief.confirmedAt));
    expect(fitted?.dropped).toBe(20 + 200 - kept.length);
  });

  it("a smaller card keeps its facts in no belief", () => {
    const entity = bigEntity({ agent: 20, mail: 20 });
    const cap = 60_000;
    expect(codePoints(JSON.stringify(entity))).toBeGreaterThan(cap);
    const fitted = fitResult("get_entity", entity, cap);
    const sent = JSON.parse(fitted?.text ?? "null") as Sent;
    expect(fitted?.dropped).toBe(0);
    expect(sent.facts.more).toBe(false);
    expect(sent.facts.claims).toEqual((compactResult("get_entity", entity) as Sent).facts.claims);
  });

  it("any other tool's result, or one that is not its tool's, is not cut", () => {
    const entity = bigEntity();
    expect(fitResult("get_beliefs", { beliefs: entity.facts!.beliefs, more: false }, CAP)).toBeNull();
    expect(fitResult("get_self", { text: "x".repeat(2 * CAP) }, CAP)).toBeNull();
    expect(fitResult("get_entity", { text: "x".repeat(2 * CAP) }, CAP)).toBeNull();
    expect(EntityView.safeParse(bigEntity({ agent: 0, mail: 1 })).success).toBe(true);
  });
});

// get_self serves sections, so its fit cuts lines.
describe("get_self's page cut to fit", () => {
  const RESULT = 40_000;

  it("the worst case is cut to fit, not refused: lines go from the largest section, last first, and a cut section says more", () => {
    const self = bigSelfPage();
    expect(codePoints(JSON.stringify(compactResult("get_self", self)))).toBeGreaterThan(RESULT);
    const fitted = fitResult("get_self", self, RESULT);
    expect(fitted).not.toBeNull();
    expect(codePoints(fitted?.text ?? "")).toBeLessThanOrEqual(RESULT);
    const sent = JSON.parse(fitted?.text ?? "null") as SentSelf;
    const whole = compactResult("get_self", self) as SentSelf;
    expect(sent.contacts).toEqual(whole.contacts);
    expect(sent.upcoming).toEqual(whole.upcoming);
    // Each section keeps a leading run of its lines, in order; career, the largest, lost the most.
    const lost = (domain: string) =>
      (whole.sections.find((one) => one.domain === domain)?.lines.length ?? 0) -
      (sent.sections.find((one) => one.domain === domain)?.lines.length ?? 0);
    for (const section of sent.sections) {
      const source = whole.sections.find((one) => one.domain === section.domain);
      expect(section.lines).toEqual(source?.lines.slice(0, section.lines.length));
      expect(section.more === true).toBe(section.lines.length < (source?.lines.length ?? 0));
    }
    expect(lost("career")).toBeGreaterThan(0);
    expect(Math.max(...sent.sections.map((one) => lost(one.domain)))).toBe(lost("career"));
    expect(fitted?.dropped).toBe(
      whole.sections.reduce((sum, one) => sum + one.lines.length, 0) -
        sent.sections.reduce((sum, one) => sum + one.lines.length, 0),
    );
  });

  it("automated notices go first, the oldest first, and their part says more", () => {
    const self = bigSelfPage();
    const [first] = self.sections?.[0]?.lines ?? [];
    if (first === undefined) throw new Error("no line");
    const notice = {
      ...first,
      tier: "system_notice" as const,
      notice: { from: null, subject: null, sentAt: first.at },
    };
    const noticed = { ...self, housekeeping: { lines: [notice, { ...notice, fact: "f".repeat(64) }], more: false } };
    const size = codePoints(JSON.stringify(compactResult("get_self", noticed)));
    const one =
      (JSON.stringify(compactResult("get_self", noticed)).length -
        JSON.stringify(compactResult("get_self", self)).length) /
      3;
    const fitted = fitResult("get_self", noticed, Math.floor(size - one));
    const sent = JSON.parse(fitted?.text ?? "null") as SentSelf & {
      housekeeping: { lines: unknown[]; more?: boolean };
    };
    expect(sent.housekeeping.lines).toHaveLength(1);
    expect(sent.housekeeping.more).toBe(true);
    expect(sent.sections.map((one) => one.lines)).toEqual(
      (compactResult("get_self", self) as SentSelf).sections.map((one) => one.lines),
    );
  });

  it("with every line gone and still too large, the latest meetings go", () => {
    const self = bigSelfPage({ lines: 6, length: 100, meetings: 30 });
    const bare = { ...self, sections: (self.sections ?? []).map((one) => ({ ...one, lines: [], more: true })) };
    const cap = codePoints(
      JSON.stringify(compactResult("get_self", { ...bare, upcoming: bare.upcoming.slice(0, 10) })),
    );
    const fitted = fitResult("get_self", self, cap);
    expect(codePoints(fitted?.text ?? "")).toBeLessThanOrEqual(cap);
    const sent = JSON.parse(fitted?.text ?? "null") as SentSelf;
    expect(sent.sections.every((one) => one.lines.length === 0 && one.more === true)).toBe(true);
    expect(sent.upcoming.length).toBeGreaterThan(5);
    expect(sent.upcoming.length).toBeLessThan(30);
    expect(sent.upcoming).toEqual(
      (compactResult("get_self", self) as SentSelf).upcoming.slice(0, sent.upcoming.length),
    );
    expect(fitResult("get_self", self, 100)).toBeNull();
  });

  it("the loop sends the fitted page, records the call ok, and logs the cut by count", async () => {
    const self = bigSelfPage();
    const api = fakeAgentApi({ get_self: () => ({ ok: true, value: self }) });
    const model = fakeTurnModel([calls({ name: "get_self" }), answer(IGNORE)]);
    const log = memoryLogger();
    const result = await runLoop(runRequest(), { api: api.api, model, log });
    expect(result).toEqual({ outcome: "finished" });
    const [tool] = model.requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
    // The loop's cap is 40 000 code points: what fitResult keeps under it.
    const expected = fitResult("get_self", self, RESULT);
    expect(expected).not.toBeNull();
    expect(tool?.role === "tool" ? tool.result : null).toBe(expected?.text);
    expect(api.steps().filter((step) => step.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "get_self", status: "ok", resultCodePoints: expect.any(Number) },
    ]);
    expect(log.events.filter((event) => event.event === "result_fitted")).toEqual([
      { event: "result_fitted", ids: { run: runRequest().id }, counts: { dropped: expected?.dropped } },
    ]);
  });
});
