import {
  BELIEF_TYPES,
  claimTierOf,
  type EmailDueItem,
  isSystemNotice,
  LIFE_DOMAINS,
  noticeTypesFor,
} from "@intelligence/contracts/personal";
import {
  BELIEF_RULES,
  type BeliefRule,
  buildBelief,
  noticeFactKey,
  noticeSource,
  PERSONAL_ONTOLOGY,
  personalFactKey,
  settle,
} from "@intelligence/personal-beliefs";
import { ownStatement } from "@intelligence/personal-core/views";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { readStored } from "../interpret.ts";
import { meetingDetailLines } from "./eval-meetings-report.ts";
import { EVAL_OWNER } from "./eval-set.ts";
import {
  checkNotice,
  EVAL_NOTICE_OWNER,
  EVAL_NOTICES,
  type EvalNotice,
  type EvalNoticeFact,
  evaluateTransactions,
  openEvalNotice,
  transactionReportLines,
} from "./eval-transactions.ts";

// The transaction lane's evaluation, on the fake model only. The live check is
// `pi extract check --world --lane transaction`, which the owner runs.

const mention = (address: string, at: string) => ({ key: { kind: "address", value: address }, observedAt: at });

// The span of the notice's plain text that holds a paragraph.
async function spanOf(notice: EvalNotice, paragraph: string): Promise<string> {
  const { parsed } = await readStored(openEvalNotice(notice), ["own"]);
  const text = parsed.texts[""] ?? "";
  const at = text.indexOf(paragraph);
  return `chars:${at}-${at + paragraph.length}`;
}

// The claim a model that finds a fact answers for it, from the notice's own words.
async function claimFor(notice: EvalNotice, fact: EvalNoticeFact, over: Record<string, unknown> = {}) {
  const base = { subject: mention(EVAL_OWNER, notice.sentAt), statementKind: "stated_fact", basis: "third_party" };
  if (fact.type === "situation") {
    const paragraph = notice.paragraphs.find((one) =>
      fact.words.every((word) => one.toLowerCase().includes(word)),
    ) as string;
    // The state as the prompt asks it: the status and what it is of, without "Your" or the end mark.
    const state = paragraph.replace(/^Your /, "").replace(/\.$/, "");
    return {
      ...base,
      type: "situation",
      fields: { state, domain: fact.domains[0] },
      span: await spanOf(notice, paragraph),
      ...over,
    };
  }
  if (fact.type === "plan") {
    const paragraph = notice.paragraphs.find((one) => one.includes("scheduled")) as string;
    return {
      ...base,
      type: "plan",
      fields: { what: paragraph, when: fact.when },
      span: await spanOf(notice, paragraph),
      ...over,
    };
  }
  // The merchant is named in the first paragraph, which the claim cites.
  return {
    ...base,
    type: "transaction.receipt",
    fields: { merchant: "Alder Books", amount: fact.amount, currency: fact.currency },
    span: await spanOf(notice, notice.paragraphs[0] as string),
    ...over,
  };
}

async function outputs(extra: Record<string, unknown[]> = {}): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const notice of EVAL_NOTICES) {
    const claims = await Promise.all(notice.expected.map((fact) => claimFor(notice, fact)));
    out[openEvalNotice(notice).context.evidenceId] = {
      claims: [...claims, ...(extra[notice.id] ?? [])],
      narrowing: "none",
    };
  }
  return out;
}

const byId = (id: string): EvalNotice => EVAL_NOTICES.find((one) => one.id === id) as EvalNotice;

describe("the transaction evaluation", () => {
  it("holds six synthetic notices on reserved domains: two passport statuses, a license office's, a shipment, a receipt and marketing", () => {
    expect(EVAL_NOTICES.map((one) => one.id)).toEqual(["tx-01", "tx-02", "tx-03", "tx-04", "tx-05", "tx-06"]);
    for (const notice of EVAL_NOTICES) {
      expect(notice.from).toMatch(/@[a-z-]+\.example$/);
      for (const fact of notice.expected)
        if (fact.type === "situation") for (const domain of fact.domains) expect(LIFE_DOMAINS).toContain(domain);
    }
    expect(byId("tx-01").expected).toEqual([
      { type: "situation", domains: ["travel"], words: ["passport", "process"] },
    ]);
    expect(byId("tx-03").expected.map((one) => one.type)).toEqual(["situation", "plan"]);
    expect(byId("tx-05").expected.map((one) => one.type)).toEqual(["transaction.receipt"]);
    expect(byId("tx-06").expected).toEqual([]);
  });

  it("through a fake model that finds each fact, every notice lands in the transaction lane and the set passes", async () => {
    const calls: string[] = [];
    const report = await evaluateTransactions({ model: fakeModelClient(await outputs(), calls) });
    expect(report).toMatchObject({
      notices: 6,
      expected: 6,
      found: 6,
      extra: 0,
      misrouted: [],
      unmapped: {},
      failed: [],
      withheld: [],
      passed: true,
    });
    expect(calls).toHaveLength(EVAL_NOTICES.length);
    expect(transactionReportLines(report)).toEqual([
      "transaction.receipt: expected 1 found 1 extra 0",
      "situation: expected 4 found 4 extra 0",
      "plan: expected 1 found 1 extra 0",
      "notices: 6 expected 6 found 6 extra 0",
      "misrouted: none",
      "unmapped: none",
      "failed: none",
      "withheld: none",
      "result: ok",
    ]);
    expect(meetingDetailLines(report, new Map(), 1).some((one) => one.includes("tx-03"))).toBe(true);
  });

  it("a receipt that also gives a situation fails, and so does marketing that gives anything", async () => {
    const receipt = byId("tx-05");
    const shipped = {
      subject: mention(EVAL_OWNER, receipt.sentAt),
      type: "situation",
      fields: { state: "order has shipped", domain: "admin" },
      statementKind: "stated_fact",
      basis: "third_party",
      span: await spanOf(receipt, "Your order has shipped."),
    };
    const sale = byId("tx-06");
    const promo = {
      subject: mention(EVAL_OWNER, sale.sentAt),
      type: "situation",
      fields: { state: "fall sale ends Sunday", domain: "money" },
      statementKind: "stated_fact",
      basis: "third_party",
      span: await spanOf(sale, "Our fall sale ends Sunday."),
    };
    const report = await evaluateTransactions({
      model: fakeModelClient(await outputs({ "tx-05": [shipped], "tx-06": [promo] }), []),
    });
    expect(report).toMatchObject({ extra: 2, failed: ["tx-05", "tx-06"], passed: false });
    expect(transactionReportLines(report).at(-1)).toBe("result: failed");
  });

  // A notice's key is its sender and subject alone, so a second situation, of any
  // domain, would dispute the first.
  it("a notice that gives a second situation, of another domain, fails", async () => {
    const office = byId("tx-03");
    const second = {
      subject: mention(EVAL_OWNER, office.sentAt),
      type: "situation",
      fields: { state: "vision test appointment is scheduled", domain: "health" },
      statementKind: "stated_fact",
      basis: "third_party",
      span: await spanOf(office, office.paragraphs[1] as string),
    };
    const report = await evaluateTransactions({ model: fakeModelClient(await outputs({ "tx-03": [second] }), []) });
    expect(report).toMatchObject({ extra: 1, failed: ["tx-03"], passed: false });
  });

  it("a fact missed fails its notice; a situation in the wrong domain or without the status words is no match", async () => {
    const empty = Object.fromEntries(
      EVAL_NOTICES.map((one) => [openEvalNotice(one).context.evidenceId, { claims: [], narrowing: "none" }]),
    );
    expect((await evaluateTransactions({ model: fakeModelClient(empty, []) })).failed).toEqual([
      "tx-01",
      "tx-02",
      "tx-03",
      "tx-04",
      "tx-05",
    ]);
    const passport = byId("tx-01");
    const wrong = {
      [openEvalNotice(passport).context.evidenceId]: {
        claims: [
          await claimFor(passport, passport.expected[0] as EvalNoticeFact, {
            fields: { state: "passport application is In Process", domain: "admin" },
          }),
        ],
        narrowing: "none",
      },
    };
    expect((await evaluateTransactions({ model: fakeModelClient(wrong, []) }, [passport])).failed).toEqual(["tx-01"]);
  });

  // A real run withholds a quarantined or special-category item and commits nothing.
  it("a withheld notice finds nothing and fails the evaluation, whatever claims it carried", async () => {
    const passport = byId("tx-01");
    for (const narrowing of ["quarantine", "special_category"]) {
      const held = {
        [openEvalNotice(passport).context.evidenceId]: {
          claims: [await claimFor(passport, passport.expected[0] as EvalNoticeFact)],
          narrowing,
        },
      };
      const report = await evaluateTransactions({ model: fakeModelClient(held, []) }, [passport]);
      expect(report).toMatchObject({ found: 0, withheld: ["tx-01"], failed: ["tx-01"], passed: false });
      expect(transactionReportLines(report)).toContain("result: failed");
    }
  });

  // What a run commits of a notice: the owner as subject whatever the model named, a third party's
  // basis whatever it said, and a claim the store counts at the system_notice tier.
  it("the lane's check makes every claim the owner's and a third party's, and its record a system notice, never the owner's own statement", async () => {
    const passport = byId("tx-01");
    const fact = passport.expected[0] as EvalNoticeFact;
    const claimed = await claimFor(passport, fact, {
      subject: mention("DoNotReply@passports.example", passport.sentAt),
      basis: "explicit_self",
    });
    const { claims, unmapped } = await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never);
    expect(unmapped).toEqual([]);
    expect(claims).toHaveLength(1);
    const [record] = claims;
    expect(record?.claim.content.subject).toBe(EVAL_NOTICE_OWNER);
    expect(record?.subjectKind).toBe("owner");
    expect(record?.claim.basis).toBe("third_party");
    expect(record?.lane).toBe("transaction");
    expect(record?.origin).toBe("source");
    expect(record?.claim.validFrom).toBe(passport.sentAt);
    expect(isSystemNotice(record as never)).toBe(true);
    expect(ownStatement(record?.claim as never, record?.claim.assertedBy === EVAL_NOTICE_OWNER)).toBe(false);
    expect(
      claimTierOf({
        origin: "source",
        pipelineVersion: record?.claim.pipelineVersion ?? "",
        basis: record?.claim.basis ?? "",
        ownerSaid: false,
        confirmed: false,
        notice: isSystemNotice(record as never),
      }),
    ).toBe("system_notice");
    // The receipt is a claim of the lane and no system notice.
    const receipt = byId("tx-05");
    const bought = await checkNotice(receipt, {
      claims: [await claimFor(receipt, receipt.expected[0] as EvalNoticeFact)],
      narrowing: "none",
    } as never);
    expect(bought.claims.map((one) => [one.claim.content.type, isSystemNotice(one as never)])).toEqual([
      ["transaction.receipt", false],
    ]);
  });
});

// A claim is a system notice's only when triage routed its message
// to the lane by its own rule, its speaker is not the owner, and the system did not send it.
// Otherwise the lane's rules stand as they were: no mark, no forced basis, the ordinary key.
describe("what counts as a notice", () => {
  const passport = byId("tx-01");
  const fact = passport.expected[0] as EvalNoticeFact;

  it("a message the owner sent to the lane by hand is no notice: no mark, the ordinary key", async () => {
    const claimed = await claimFor(passport, fact, { basis: "explicit_self" });
    const automatic = (await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never)).claims[0];
    const { claims } = await checkNotice(
      passport,
      { claims: [claimed], narrowing: "none" } as never,
      undefined,
      (due) => ({ ...due, lane: "transaction" }),
    );
    const [record] = claims;
    expect(automatic?.notice).toBe(true);
    expect(record?.lane).toBe("transaction");
    expect(record?.notice).toBeUndefined();
    expect(isSystemNotice(record as never)).toBe(false);
    expect(record?.factKey).not.toBe(automatic?.factKey);
  });

  it("mail that is not bulk, or not of Updates or Primary, is no notice whatever its lane", async () => {
    const claimed = await claimFor(passport, fact);
    for (const change of [
      (due: EmailDueItem) => ({ ...due, triage: { ...due.triage, bulk: false } }),
      (due: EmailDueItem) => ({ ...due, triage: { ...due.triage, category: "promotions" as const } }),
    ]) {
      const [record] = (
        await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never, undefined, change)
      ).claims;
      expect(record?.notice).toBeUndefined();
      expect(isSystemNotice(record as never)).toBe(false);
    }
  });

  // The check reads triage's own decision, so mail the decide model's line 4 routes is a notice.
  // Only with a machine's mail markers, bulk or the Updates category.
  it("non-bulk Updates mail that Jev's human_written below the line sends to the lane is a notice", async () => {
    const claimed = await claimFor(passport, fact);
    const automatic = (await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never)).claims[0];
    const unbulk = (due: EmailDueItem) => ({
      ...due,
      triage: { ...due.triage, bulk: false, category: "updates" as const },
    });
    const [record] = (
      await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never, undefined, unbulk, 0.1)
    ).claims;
    expect(record?.notice).toBe(true);
    expect(record?.claim.basis).toBe("third_party");
    expect(record?.factKey).toBe(automatic?.factKey);
    // At or above the line it is a person's mail, which triage sends to correspondence: no notice.
    const [person] = (
      await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never, undefined, unbulk, 0.9)
    ).claims;
    expect(person?.notice).toBeUndefined();
  });

  it("a person's non-bulk Primary mail Jev under-scores is no notice: it keeps the lane's rules", async () => {
    const claimed = await claimFor(passport, fact, { basis: "explicit_self" });
    const automatic = (await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never)).claims[0];
    const person = (due: EmailDueItem) => ({
      ...due,
      triage: { ...due.triage, bulk: false, category: "primary" as const },
    });
    const [record] = (
      await checkNotice(passport, { claims: [claimed], narrowing: "none" } as never, undefined, person, 0.1)
    ).claims;
    expect(record?.lane).toBe("transaction");
    expect(record?.notice).toBeUndefined();
    expect(isSystemNotice(record as never)).toBe(false);
    expect(record?.factKey).not.toBe(automatic?.factKey);
  });

  it("a notice whose sender has no parseable address is no notice, so none shares a key", async () => {
    const opened = openEvalNotice(passport);
    const { parsed, read } = await readStored(opened, ["own"]);
    const nameless = { opened, read, parsed: { ...parsed, headers: { ...parsed.headers, from: ["Passport Office"] } } };
    const [record] = (
      await checkNotice(passport, { claims: [await claimFor(passport, fact)], narrowing: "none" } as never, nameless)
    ).claims;
    expect(record?.notice).toBeUndefined();
    expect(isSystemNotice(record as never)).toBe(false);
  });

  // The mark is the one definition, so the check gives it to a statement only.
  it("a question, proposal, hypothesis or reversal of a notice gets no mark", async () => {
    for (const statementKind of ["question", "proposal", "hypothesis", "reversal"]) {
      const { claims } = await checkNotice(passport, {
        claims: [await claimFor(passport, fact, { statementKind })],
        narrowing: "none",
      } as never);
      for (const record of claims) expect(record.notice, statementKind).toBeUndefined();
    }
  });

  it("a claim the store resolves as the owner's own word never counts through the notice rule", async () => {
    const [record] = (
      await checkNotice(passport, { claims: [await claimFor(passport, fact)], narrowing: "none" } as never)
    ).claims;
    const rule = BELIEF_RULES.situation as BeliefRule;
    const noticed = {
      claim: record!.claim,
      origin: record!.origin,
      subjectKind: record!.subjectKind,
      notice: true as const,
    };
    expect(rule.counts(noticed)).toBe(true);
    expect(rule.counts({ ...noticed, ownerSaid: true })).toBe(false);
  });
});

// A notice's situation keys by its sender and subject, never with the owner's own situation of the
// domain, so each case below stays visible.
describe("a notice's situation, keyed by sender and subject", () => {
  const situationOf = async (id: string) => {
    const notice = byId(id);
    const fact = notice.expected.find((one) => one.type === "situation") as EvalNoticeFact;
    const { claims } = await checkNotice(notice, {
      claims: [await claimFor(notice, fact)],
      narrowing: "none",
    } as never);
    expect(claims).toHaveLength(1);
    return claims[0] as NonNullable<(typeof claims)[number]>;
  };

  it("(i) never shares a key with the owner's own situation of its domain", async () => {
    const passport = await situationOf("tx-01");
    expect(passport.claim.content.fields.domain).toBe("travel");
    const his = { ...passport.claim.content, fields: { state: "planning a trip to Lisbon", domain: "travel" } };
    for (const version of [1, 2] as const)
      expect(passport.factKey).not.toBe(personalFactKey(his, "", ["own"], undefined, version));
    expect(passport.legacyFactKey).toBeUndefined();
  });

  it("(ii) one sender's two notices share a key, and the later is the belief's answer, undisputed", async () => {
    const [inProcess, mailed] = [await situationOf("tx-01"), await situationOf("tx-02")];
    expect(inProcess.claim.content.fields.state).not.toBe(mailed.claim.content.fields.state);
    expect(inProcess.factKey).toBe(mailed.factKey);
    const kept = [inProcess, mailed].map((record) => ({
      claim: record.claim,
      origin: record.origin,
      subjectKind: record.subjectKind,
      ownerSaid: false,
      notice: true as const,
    }));
    const rule = BELIEF_RULES.situation as BeliefRule;
    expect(kept.every((one) => rule.counts(one))).toBe(true);
    const { claims, conflict } = settle(rule, kept);
    const belief = buildBelief(claims, [], mailed.claim.validFrom, PERSONAL_ONTOLOGY, mailed.factKey, undefined, {
      conflict,
    });
    expect(belief?.disputed).toBe(false);
    expect(Date.parse(mailed.claim.validFrom)).toBeGreaterThan(Date.parse(inProcess.claim.validFrom));
  });

  // The set accepts travel or admin for the passport notices, so the key is blind to it.
  it("(ii) tx-01 and tx-02 share one key whichever domain the model chose for each", async () => {
    const keyOf = async (id: string, domain: string) => {
      const notice = byId(id);
      const fact = notice.expected[0] as EvalNoticeFact;
      const claimed = await claimFor(notice, fact);
      const { claims } = await checkNotice(notice, {
        claims: [{ ...claimed, fields: { ...(claimed.fields as object), domain } }],
        narrowing: "none",
      } as never);
      expect(claims[0]?.claim.content.fields.domain).toBe(domain);
      return claims[0]?.factKey;
    };
    expect(await keyOf("tx-02", "admin")).toBe(await keyOf("tx-01", "travel"));
    expect(await keyOf("tx-02", "travel")).toBe(await keyOf("tx-01", "admin"));
  });

  // The invariant renderLine and the store rely on to read a notice line's headers
  // from the cite it renders from: every claim of a notice belief is a notice's.
  it("only a notice's situation builds a notice belief: a plan builds none, and every notice situation takes the notice key", async () => {
    // Version 2 still marks its situation; in the fact-kind versions a notice is a status, keyed
    // by its organization and process.
    expect(noticeTypesFor("2").filter((type) => (BELIEF_TYPES as readonly string[]).includes(type))).toEqual([
      "status",
      "situation",
    ]);
    const renewal = byId("tx-03");
    const { claims } = await checkNotice(renewal, {
      claims: await Promise.all(renewal.expected.map((fact) => claimFor(renewal, fact as EvalNoticeFact))),
      narrowing: "none",
    } as never);
    const situation = claims.find((one) => one.claim.content.type === "situation");
    expect(situation?.notice).toBe(true);
    expect(situation?.factKey).toBe(
      noticeFactKey(
        situation!.claim.content,
        ["own"],
        noticeSource(renewal.from) as string,
        renewal.subject,
        openEvalNotice(renewal).context.evidenceId,
      ),
    );
  });

  it("(iii) two senders' notices of one domain are two keys", async () => {
    const [renewed, shipped] = [await situationOf("tx-03"), await situationOf("tx-04")];
    expect(renewed.claim.content.fields.domain).toBe(shipped.claim.content.fields.domain);
    expect(renewed.factKey).not.toBe(shipped.factKey);
  });
});
