import type { InterpreterOutput } from "@intelligence/contracts";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { readStored } from "../interpret.ts";
import { SECOND_DEGREE_VERSIONS } from "../lane-versions.ts";
import { momentPromptAt, promptAt } from "../prompts.ts";
import {
  checkSecondDegreeMail,
  evaluateSecondDegree,
  openSecondDegreeChat,
  openSecondDegreeMail,
  recordedOutput,
  SECOND_DEGREE_SET,
  type SecondDegreeCase,
  type SecondDegreeChat,
  type SecondDegreeMail,
  secondDegreeReportLines,
} from "./eval-second-degree.ts";

// The second-degree evaluation, on recorded outputs only: each case's answer as a model gives it,
// through the fake model.

const byId = (id: string): SecondDegreeCase => SECOND_DEGREE_SET.find((one) => one.id === id) as SecondDegreeCase;
const keyOf = (one: SecondDegreeCase): string =>
  one.kind === "mail" ? openSecondDegreeMail(one).context.evidenceId : openSecondDegreeChat(one).context.evidenceId;
const textOf = (one: SecondDegreeCase): string =>
  one.kind === "mail" ? one.text : one.lines.map(([, line]) => line).join("\n");

async function recorded(
  change: Record<string, (output: InterpreterOutput) => InterpreterOutput> = {},
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const one of SECOND_DEGREE_SET) {
    const output = await recordedOutput(one);
    out[keyOf(one)] = (change[one.id] ?? ((same) => same))(output);
  }
  return out;
}

describe("the second-degree evaluation set", () => {
  it("plants each case the plan names, on reserved domains, each recorded claim citing a line its item holds", () => {
    const text = SECOND_DEGREE_SET.map(textOf).join("\n");
    for (const planted of [
      "I know",
      "You should meet",
      "you should meet",
      "Happy to introduce you",
      "happy to introduce you",
      "My colleague",
      "Senator",
      "wrote:\n>",
      "we've met",
      "Lena Park said she would be happy to introduce you",
    ])
      expect(text, planted).toContain(planted);
    for (const one of SECOND_DEGREE_SET) {
      const addresses = one.kind === "mail" ? [one.from, ...one.to] : one.people;
      for (const address of addresses) expect(address).toMatch(/\.example$/);
      for (const claim of one.recorded) expect(textOf(one), one.id).toContain(claim.line);
    }
    // Each new kind and each negative is there: an offer to someone else in a group chat, a public
    // figure, a quoted forward, a message the owner did not receive and someone else's offer.
    const expected = SECOND_DEGREE_SET.flatMap((one) => one.expected);
    expect(
      expected.filter((fact) => fact.type === "relationship" && fact.relation === "acquaintance").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      expected.filter((fact) => fact.type === "intro_offer" && fact.offer === "offered").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      expected.filter((fact) => fact.type === "intro_offer" && fact.offer === "suggested").length,
    ).toBeGreaterThanOrEqual(2);
    for (const id of ["sd-05", "sd-06", "sd-07", "sd-08", "sd-10"]) expect(byId(id).expected, id).toEqual([]);
    expect((byId("sd-10") as SecondDegreeChat).people).toHaveLength(2);
  });

  it("the quoted forward's offer stands in a quoted segment, and the list message reaches the owner in no header", async () => {
    const forward = byId("sd-07") as SecondDegreeMail;
    const { parsed } = await readStored(openSecondDegreeMail(forward), ["own"]);
    expect(
      parsed.segments.find((segment) => segment.text.includes("Happy to introduce you to Dov Arden."))?.quoted,
    ).toBe(true);
    const list = byId("sd-05") as SecondDegreeMail;
    const { parsed: listed } = await readStored(openSecondDegreeMail(list), ["own"]);
    expect(["to", "cc", "bcc"].flatMap((name) => listed.headers[name] ?? [])).not.toContain("sam@harbor.example");
  });
});

describe("an intro_offer is a claim only first-hand, by code", () => {
  it("intro_offer from a speaker who is not its subject is unmapped not_first_hand", async () => {
    const reported = byId("sd-08") as SecondDegreeMail;
    const result = await checkSecondDegreeMail(reported, await recordedOutput(reported));
    expect(result.claims).toEqual([]);
    expect(result.unmapped.map((one) => [one.proposedType, one.reason])).toEqual([["intro_offer", "not_first_hand"]]);
  });

  it("intro_offer in a message the owner did not receive is unmapped not_first_hand", async () => {
    const list = byId("sd-05") as SecondDegreeMail;
    const result = await checkSecondDegreeMail(list, await recordedOutput(list));
    expect(result.claims).toEqual([]);
    expect(result.unmapped.map((one) => [one.proposedType, one.reason])).toEqual([["intro_offer", "not_first_hand"]]);
    // The control: the same offer by its own speaker in mail the owner received is a claim.
    const received: SecondDegreeMail = { ...list, id: "sd-05c", to: ["sam@harbor.example"] };
    const kept = await checkSecondDegreeMail(received, await recordedOutput(received));
    expect(kept.unmapped).toEqual([]);
    expect(kept.claims.map((one) => [one.claim.content.type, one.claim.content.fields.offer, one.disclosure])).toEqual([
      ["intro_offer", "offered", ["third_party"]],
    ]);
  });

  it("an earlier version's types refuse intro_offer and acquaintance: only the second-degree version offers them", async () => {
    const offer = byId("sd-03") as SecondDegreeMail;
    expect(promptAt("correspondence", "4").instructions).not.toContain("intro_offer");
    expect(promptAt("correspondence", SECOND_DEGREE_VERSIONS.correspondence).instructions).toContain("- intro_offer: ");
    expect(momentPromptAt(SECOND_DEGREE_VERSIONS.moment).instructions).toContain("acquaintance");
    expect((await checkSecondDegreeMail(offer, await recordedOutput(offer))).claims).toHaveLength(1);
  });
});

describe("evaluateSecondDegree on recorded outputs", () => {
  it("passes: each new kind found as expected, the negatives refused by code or never proposed, the third person's report builds no belief", async () => {
    const calls: string[] = [];
    const report = await evaluateSecondDegree({ model: fakeModelClient(await recorded(), calls) });
    expect(report.failed).toEqual([]);
    expect(report.kinds).toEqual([
      { kind: "acquaintance", expected: 2, found: 2, matched: 2, precision: 1, recall: 1, passed: true },
      { kind: "intro_offer", expected: 4, found: 4, matched: 4, precision: 1, recall: 1, passed: true },
    ]);
    expect(report.relationships).toEqual({ expected: 2, found: 2 });
    expect(report.reportedCounted).toBe(0);
    expect(report.unmapped).toMatchObject({ not_first_hand: 2, bad_span: 1 });
    expect(report.passed).toBe(true);
    // One call for each case the lane asks.
    expect(calls).toHaveLength(SECOND_DEGREE_SET.length);
  });

  it("an offer to someone else taken as the owner's fails intro_offer's precision; an acquaintance missed fails its recall", async () => {
    const group = byId("sd-10") as SecondDegreeChat;
    const toOmar = (output: InterpreterOutput): InterpreterOutput => ({
      ...output,
      claims: [
        {
          type: "intro_offer",
          subject: { key: { kind: "source_id", value: "speaker:P1" }, observedAt: "2026-03-02T15:00:00.000Z" },
          fields: {
            person: { key: { kind: "name", value: "Dov Arden" }, observedAt: "2026-03-02T15:00:00.000Z" },
            offer: "offered",
          },
          statementKind: "proposal",
          basis: "explicit_self",
          span: "mom:0:0-64",
        },
      ],
    });
    expect(group.lines[0]?.[1]).toHaveLength(64);
    const extra = await evaluateSecondDegree({ model: fakeModelClient(await recorded({ "sd-10": toOmar })) });
    expect(extra.kinds[1]).toMatchObject({ kind: "intro_offer", found: 5, matched: 4, passed: false });
    expect(extra.failed).toEqual(["sd-10"]);
    expect(extra.passed).toBe(false);
    const missed = await evaluateSecondDegree({
      model: fakeModelClient(await recorded({ "sd-01": (output) => ({ ...output, claims: [] }) })),
    });
    expect(missed.kinds[0]).toMatchObject({ kind: "acquaintance", matched: 1, recall: 0.5, passed: false });
    expect(missed.passed).toBe(false);
  });

  it("prints counts and the set's ids, and no text of the set", async () => {
    const lines = secondDegreeReportLines(await evaluateSecondDegree({ model: fakeModelClient(await recorded()) }));
    expect(lines.at(-1)).toBe("result: ok");
    const printed = lines.join("\n");
    for (const one of SECOND_DEGREE_SET)
      for (const line of textOf(one).split("\n")) if (line.length > 12) expect(printed).not.toContain(line);
  });
});
