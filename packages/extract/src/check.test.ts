import { legacyFactKey } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { strip } from "./check.ts";
import { checkCorrespondence, type EvalMessage, openEvalMessage, spanOf } from "./eval/eval-correspondence.ts";
import { fieldsDetail } from "./fields-detail.ts";
import { readStored } from "./interpret.ts";
import { FACT_KIND_VERSIONS, ontologyFor } from "./lane-versions.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import {
  answering,
  changed,
  dueOf,
  processOne,
  recordsOf,
  type Setup,
  setup,
  unmappedOf,
} from "./test-support/support.ts";

type Candidate = {
  type: string;
  subject: { key: { kind: string; value: string }; observedAt: string };
  fields: Record<string, unknown>;
  span: string;
  [key: string]: unknown;
};
type Output = { claims: Candidate[]; narrowing: string };

const outputOf = (s: Setup, gmailId: string): Output =>
  structuredClone(s.store.outputs[s.store.evidenceIdOf(gmailId)]) as Output;
const first = (output: Output): Candidate => output.claims[0] as Candidate;
const DAY = 86_400_000;
const NOW_PLUS = (days: number): number => Date.parse("2026-10-01T12:00:00.000Z") + days * DAY;

describe("the personal checks", () => {
  it("a claim that cites a quote is unmapped", async () => {
    const s = await setup();
    const { quotedReplyMessageId: id } = s.w.handles;
    expect((await processOne(s, id)).status).toBe("done");
    expect(recordsOf(s, id)).toEqual([]);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["bad_span"]);
  });

  it("a correspondence candidate that cites the subject line is unmapped, and a transaction one is not", async () => {
    const s = await setup();
    const { subjectLineReplyMessageId: reply, receiptGroupedMessageId: receipt } = s.w.handles;
    const subject = "Paid 42.80 at Hale Books";
    changed(s, receipt, (message) => {
      message.headers = message.headers.map((header) =>
        header.name === "Subject" ? { name: "Subject", value: subject } : header,
      );
    });
    const output = outputOf(s, receipt);
    Object.assign(first(output), {
      span: `subject:chars:0-${subject.length}`,
      fields: { merchant: "Hale Books", amount: 42.8, currency: "EUR" },
    });
    answering(s, { [receipt]: output });
    await processOne(s, reply);
    await processOne(s, receipt);
    expect(unmappedOf(s, reply).map((one) => one.reason)).toEqual(["bad_span"]);
    expect(unmappedOf(s, receipt)).toEqual([]);
    expect(recordsOf(s, receipt).map((one) => one.claim.content.fields.merchant)).toEqual(["Hale Books"]);
  });

  it("a date outside the window is unmapped", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    const output = outputOf(s, id);
    const when = new Date(Date.parse(first(output).subject.observedAt) + 900 * DAY).toISOString().slice(0, 10);
    first(output).fields.when = when;
    answering(s, { [id]: output });
    await processOne(s, id);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["bad_times"]);
  });

  it("a receipt with no date takes the sent date, and its id is the one it has with a date left out", async () => {
    const s = await setup();
    const { receiptCanaryMessageId: id } = s.w.handles;
    const due = await dueOf(s.store, id);
    await processOne(s, id);
    const [record] = recordsOf(s, id);
    const sentDay = new Date(due.sentAt).toISOString().slice(0, 10);
    expect(record?.claim.content.fields.date).toBe(sentDay);
    // Given the same date by the model, the id covers it, so it is another id.
    const other = await setup();
    const output = outputOf(other, id);
    first(output).fields.date = sentDay;
    answering(other, { [id]: output });
    await processOne(other, id);
    const [dated] = recordsOf(other, id);
    expect(dated?.claim.content.fields.date).toBe(sentDay);
    expect(dated?.claim.id).not.toBe(record?.claim.id);
  });

  it("the transaction lane's subject is the owner whatever the model named", async () => {
    const s = await setup();
    for (const id of [
      s.w.handles.receiptCanaryMessageId,
      s.w.handles.receiptGroupedMessageId,
      s.w.handles.receiptAmpersandMessageId,
    ]) {
      expect(first(outputOf(s, id)).subject.key.value).not.toMatch(/quinn/);
      await processOne(s, id);
      const [record] = recordsOf(s, id);
      expect(record?.claim.content.subject).toBe(OWNER_ENTITY);
      expect(record?.subjectKind).toBe("owner");
    }
  });

  it("a receipt whose headers hold no owner address is unmapped", async () => {
    const s = await setup();
    const { receiptGroupedMessageId: id } = s.w.handles;
    changed(s, id, (message) => {
      message.headers = message.headers.map((header) =>
        header.name === "To" ? { name: "To", value: "box@relay.example.org" } : header,
      );
    });
    await processOne(s, id);
    expect(recordsOf(s, id)).toEqual([]);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["ungrounded_mention"]);
  });

  it("a receipt whose compartment holds no owner address is unmapped, not kept with the model's subject", async () => {
    const s = await setup();
    const { receiptGroupedMessageId: id } = s.w.handles;
    changed(
      s,
      id,
      () => {},
      (opened) => ({ ...opened, context: { ...opened.context, ownerAddresses: [] } }),
    );
    await processOne(s, id);
    expect(recordsOf(s, id)).toEqual([]);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["ungrounded_mention"]);
  });

  it("a subject kind the type does not list is unmapped", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    changed(
      s,
      id,
      () => {},
      (opened) => ({ ...opened, kindOf: () => "organization" }),
    );
    await processOne(s, id);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["ungrounded_mention"]);
  });

  it("a mention that resolves to nobody yields no claim and is counted", async () => {
    const s = await setup();
    const { namesWorkOnlyMessageId: id } = s.w.handles;
    const outcome = await processOne(s, id);
    expect(outcome).toMatchObject({ status: "done", claims: 0, unmapped: 0, unresolved: 1 });
    expect(recordsOf(s, id)).toEqual([]);
  });

  it("a claim about another person is third party", async () => {
    const s = await setup();
    await processOne(s, s.w.handles.planMessageId);
    expect(recordsOf(s, s.w.handles.planMessageId).map((one) => one.disclosure)).toEqual([["third_party"]]);
  });

  it("a receipt is not", async () => {
    const s = await setup();
    await processOne(s, s.w.handles.receiptCanaryMessageId);
    const [record] = recordsOf(s, s.w.handles.receiptCanaryMessageId);
    expect(record?.disclosure).toEqual([]);
    expect(record?.entities).toEqual([]);
  });

  it("the same item gives the same ids", async () => {
    const ids = [];
    for (let round = 0; round < 2; round += 1) {
      const s = await setup();
      await processOne(s, s.w.handles.commitmentOutboundMessageId);
      ids.push(recordsOf(s, s.w.handles.commitmentOutboundMessageId).map((one) => [one.claim.id, one.factKey]));
    }
    expect(ids[0]).toHaveLength(1);
    expect(ids[1]).toEqual(ids[0]);
  });

  it("a candidate's validFrom, validTo, context and assertedBy are gone before the check, and the claim id is the same with and without them", async () => {
    const plain = await setup();
    const { planMessageId: id } = plain.w.handles;
    await processOne(plain, id);
    const s = await setup();
    const output = outputOf(s, id);
    const at = first(output).subject.observedAt;
    Object.assign(first(output), {
      validFrom: at,
      validTo: at,
      context: { kind: "project" },
      assertedBy: first(output).fields.counterparty,
    });
    expect(strip(output.claims as never).map((one) => Object.keys(one).sort())).toEqual([
      ["basis", "fields", "span", "statementKind", "subject", "type"],
    ]);
    answering(s, { [id]: output });
    await processOne(s, id);
    const [record] = recordsOf(s, id);
    expect(record?.claim.id).toBe(recordsOf(plain, id)[0]?.claim.id);
    expect(record?.claim.content.context).toBeUndefined();
    expect(record?.claim.validTo).toBeUndefined();
  });

  it("a model's candidate with basis system_observed is unmapped bad_fields, and the same candidate with another basis is kept", async () => {
    const plain = await setup();
    const { planMessageId: id } = plain.w.handles;
    await processOne(plain, id);
    expect(recordsOf(plain, id)).toHaveLength(1);
    const s = await setup();
    const output = outputOf(s, id);
    first(output).basis = "system_observed";
    answering(s, { [id]: output });
    expect((await processOne(s, id)).status).toBe("done");
    expect(recordsOf(s, id)).toEqual([]);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["bad_fields"]);
    // strip leaves every other candidate as it was.
    const kept = outputOf(s, id);
    expect(strip(kept.claims as never)).toEqual(kept.claims);
  });

  it("valid_from is the message's sent time whatever the model said", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    const output = outputOf(s, id);
    first(output).validFrom = "2020-01-01T00:00:00.000Z";
    answering(s, { [id]: output });
    const due = await dueOf(s.store, id);
    await processOne(s, id);
    expect(recordsOf(s, id)[0]?.claim.validFrom).toBe(due.sentAt);
  });

  it("a type proposed in the wrong lane is unmapped", async () => {
    const s = await setup();
    const { receiptGroupedMessageId: receipt, planMessageId: plan } = s.w.handles;
    const output = outputOf(s, plan);
    answering(s, { [receipt]: output, [plan]: outputOf(s, receipt) });
    await processOne(s, receipt);
    await processOne(s, plan);
    // personal_transaction version 2 offers a plan, so the plan given to the receipt is a type of
    // its lane, refused for citing the other message's span; a receipt is still no type of
    // correspondence.
    expect(unmappedOf(s, receipt).map((one) => [one.proposedType, one.reason])).toEqual([["plan", "bad_span"]]);
    expect(unmappedOf(s, plan).map((one) => [one.proposedType, one.reason])).toEqual([["other", "unknown_type"]]);
  });

  it("an inbound claim whose speaker is the owner is unmapped as bad_speaker, with either basis, and the same claim in an outbound item is kept", async () => {
    const s = await setup();
    const { forgedOwnerMessageId: forged, commitmentOutboundMessageId: sent } = s.w.handles;
    // A commitment by the owner, and a report by the owner about the other person.
    const twice = (output: Output): Output => {
      const own = first(output);
      const counterparty = own.fields.counterparty as Candidate["subject"];
      return {
        ...output,
        claims: [own, { ...own, subject: counterparty, fields: { ...own.fields, counterparty: own.subject } }],
      };
    };
    answering(s, { [forged]: twice(outputOf(s, forged)), [sent]: twice(outputOf(s, sent)) });
    expect((await dueOf(s.store, forged)).triage.direction).toBe("inbound");
    expect((await dueOf(s.store, sent)).triage.direction).toBe("outbound");
    await processOne(s, forged);
    await processOne(s, sent);
    expect(unmappedOf(s, forged).map((one) => one.reason)).toEqual(["bad_speaker", "bad_speaker"]);
    expect(recordsOf(s, forged)).toEqual([]);
    expect(
      recordsOf(s, sent)
        .map((one) => one.claim.basis)
        .sort(),
    ).toEqual(["explicit_self", "third_party"]);
    expect(unmappedOf(s, sent)).toEqual([]);
  });

  it("a quoted segment credited to the owner in an inbound item is bad_span, not bad_speaker", async () => {
    const s = await setup();
    const { planMessageId: id } = s.w.handles;
    const line = "I will bring the wine on the day.";
    changed(s, id, (message) => {
      message.text = `Lovely, see you then.\r\n\r\nOn Monday, Avery Quinn <avery@quinn.test> wrote:\r\n> ${line}\r\n`;
    });
    const due = await dueOf(s.store, id);
    const opened = await s.deps.store.open(due.evidenceId);
    if (opened === null) throw new Error("gone");
    const { parsed } = await readStored(opened, due.compartments);
    const quoted = parsed.segments.find((segment) => segment.quoted);
    expect(quoted?.author?.key.value).toBe("avery@quinn.test");
    const output = outputOf(s, id);
    const at = first(output).subject.observedAt;
    output.claims = [
      {
        ...first(output),
        type: "commitment",
        subject: { key: { kind: "address", value: "avery@quinn.test" }, observedAt: at },
        fields: { counterparty: first(output).subject, what: line },
        span: quoted?.span ?? "",
      },
    ];
    answering(s, { [id]: output });
    await processOne(s, id);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["bad_span"]);
  });

  it("a claim from a system-originated item has the origin agent_record, and answersSystem is carried from the item", async () => {
    const s = await setup();
    const { planMessageId: marked, commitmentInboundMessageId: plain } = s.w.handles;
    s.store.setMarks(s.store.evidenceIdOf(marked), { systemOriginated: true, answersSystem: true });
    await processOne(s, marked);
    await processOne(s, plain);
    expect(recordsOf(s, marked).map((one) => [one.origin, one.answersSystem, one.claim.systemOriginated])).toEqual([
      ["agent_record", true, true],
    ]);
    expect(recordsOf(s, plain).map((one) => [one.origin, one.answersSystem])).toEqual([["source", false]]);
  });

  it("no claim carries subject aliases", async () => {
    const s = await setup();
    for (const id of [
      s.w.handles.planMessageId,
      s.w.handles.commitmentInboundMessageId,
      s.w.handles.receiptCanaryMessageId,
    ])
      await processOne(s, id);
    expect(s.store.claims().length).toBe(3);
    for (const record of s.store.claims()) expect(record.claim.subjectAliases).toBeUndefined();
  });

  describe("belief-kinds", () => {
    const IRIS = "iris.calloway@kestrel.test";
    // Iris's dinner message, given this text and this one candidate.
    const say = async (text: string, candidate: (at: string, span: string) => Record<string, unknown>) => {
      const s = await setup();
      const { planMessageId: id } = s.w.handles;
      changed(s, id, (message) => {
        message.text = `${text}\r\n`;
      });
      const at = first(outputOf(s, id)).subject.observedAt;
      answering(s, {
        [id]: {
          claims: [
            { statementKind: "stated_fact", basis: "explicit_self", ...candidate(at, `chars:0-${text.length}`) },
          ],
          narrowing: "none",
        },
      });
      const outcome = await processOne(s, id);
      return { s, id, outcome, records: recordsOf(s, id), reasons: unmappedOf(s, id).map((one) => one.reason) };
    };
    const person = (address: string, at: string) => ({ key: { kind: "address", value: address }, observedAt: at });
    const domain = (value: string, at: string) => ({
      key: { kind: "source_id", value: `domain:${value}` },
      observedAt: at,
    });

    it("an affiliation with neither organization nor organization_name is bad_fields", async () => {
      const { reasons, records } = await say("I advise a few startups.", (at, span) => ({
        type: "affiliation",
        subject: person(IRIS, at),
        fields: { relation: "advisor" },
        span,
      }));
      expect(records).toEqual([]);
      expect(reasons).toEqual(["bad_fields"]);
      const named = await say("I advise Cedar Works.", (at, span) => ({
        type: "affiliation",
        subject: person(IRIS, at),
        fields: { relation: "advisor", organization_name: "Cedar Works" },
        span,
      }));
      expect(named.records.map((one) => one.claim.content.fields)).toEqual([
        { relation: "advisor", organization_name: "Cedar Works" },
      ]);
    });

    it("until sets validTo at the end of that day, in UTC, and a model's validTo is never kept", async () => {
      const text = "Please don't call me at work until the move is done.";
      const until = new Date(NOW_PLUS(20)).toISOString().slice(0, 10);
      const { records } = await say(text, (at, span) => ({
        type: "contact_rule",
        subject: person(IRIS, at),
        fields: { rule: "do_not_contact", channel: "phone", what: text, until },
        validTo: "2030-01-01T00:00:00Z",
        span,
      }));
      expect(records.map((one) => one.claim.validTo)).toEqual([`${until}T23:59:59.999Z`]);
      // A type with no until keeps no validTo.
      const need = await say("I need a kitchen designer.", (at, span) => ({
        type: "need",
        subject: person(IRIS, at),
        fields: { object: "a kitchen designer", domain: "home" },
        span,
      }));
      expect(need.records.map((one) => one.claim.validTo)).toEqual([undefined]);
    });

    it("an entity field that resolves to the wrong kind is ungrounded_mention", async () => {
      // Iris's own domain resolves to its organization, which is no counterparty of a relationship.
      const { records, reasons } = await say("They are my colleagues.", (at, span) => ({
        type: "relationship",
        subject: person(IRIS, at),
        fields: { counterparty: domain("kestrel.test", at), relation: "colleague" },
        span,
      }));
      expect(records).toEqual([]);
      expect(reasons).toEqual(["ungrounded_mention"]);
    });

    it("a domain the passage does not name is refused, the author's own domain and a named one are accepted", async () => {
      const store = await setup();
      const kestrel = store.store.organizationOf("kestrel.test");
      const mallow = store.store.organizationOf("mallow.test");
      expect(kestrel).toBeDefined();
      expect(mallow).toBeDefined();
      // The store knows mallow.test, but this passage does not name it.
      const elsewhere = await say("I am the head of design now.", (at, span) => ({
        type: "role",
        subject: person(IRIS, at),
        fields: { title: "head of design", organization: domain("mallow.test", at) },
        span,
      }));
      expect(elsewhere.records).toEqual([]);
      expect(elsewhere.reasons).toEqual(["ungrounded_mention"]);
      // The author's own domain.
      const own = await say("I am the head of design now.", (at, span) => ({
        type: "role",
        subject: person(IRIS, at),
        fields: { title: "head of design", organization: domain("Kestrel.test", at) },
        span,
      }));
      expect(own.records.map((one) => one.claim.content.fields)).toEqual([
        { title: "head of design", organization: kestrel },
      ]);
      expect(own.records[0]?.entities).toContain(kestrel);
      // A domain the passage names.
      const named = await say("I joined mallow.test as head of design.", (at, span) => ({
        type: "role",
        subject: person(IRIS, at),
        fields: { title: "head of design", organization: domain("mallow.test", at) },
        span,
      }));
      expect(named.records.map((one) => one.claim.content.fields.organization)).toEqual([mallow]);
      // A domain the store holds no organization for under this compartment resolves to nobody.
      const unknown = await say("I joined birch.example as head of design.", (at, span) => ({
        type: "role",
        subject: person(IRIS, at),
        fields: { title: "head of design", organization: domain("birch.example", at) },
        span,
      }));
      expect(unknown.records).toEqual([]);
      expect(unknown.outcome).toMatchObject({ unresolved: 1 });
    });

    it("an organization is a subject by its domain, and a claim about it is third party", async () => {
      const { records } = await say("Kestrel needs a new office.", (at, span) => ({
        type: "need",
        subject: domain("kestrel.test", at),
        fields: { object: "a new office", domain: "ventures" },
        span,
      }));
      expect(records.map((one) => [one.subjectKind, one.claim.basis])).toEqual([["organization", "third_party"]]);
    });

    it("a person known only by name is a name mention that links nobody: no claim, counted unresolved", async () => {
      const { records, reasons, outcome } = await say("Maya Field is my sister.", (at, span) => ({
        type: "relationship",
        subject: { key: { kind: "name", value: "Maya Field" }, observedAt: at },
        fields: { counterparty: person(IRIS, at), relation: "sibling" },
        span,
      }));
      expect(records).toEqual([]);
      expect(reasons).toEqual([]);
      expect(outcome).toMatchObject({ status: "done", claims: 0, unresolved: 1 });
    });

    it("a project-type candidate in an unanchored thread yields no claim and is counted unresolved", async () => {
      const { records, reasons, outcome } = await say("We chose the oak.", (at, span) => ({
        type: "project.decision",
        subject: { key: { kind: "source_id", value: "project:this" }, observedAt: at },
        fields: { what: "We chose the oak." },
        span,
      }));
      expect(records).toEqual([]);
      expect(reasons).toEqual([]);
      expect(outcome).toMatchObject({ status: "done", claims: 0, unresolved: 1 });
    });
  });
});

// The atomic checks, on fixed outputs checked as the run checks them: under version 4's types, at
// the generation of fact key version 2.
describe("the atomic checks", () => {
  const OWNER = "sam@harbor.example";
  const message = (sentence: string): EvalMessage => ({
    id: "k2a-01",
    from: OWNER,
    to: "lena.park@north.example",
    paragraphs: [sentence],
    expected: [],
  });
  const at = "2026-03-02T09:00:00.000Z";
  async function said(sentence: string, type: string, fields: Record<string, unknown>) {
    const one = message(sentence);
    const claim = {
      type,
      subject: { key: { kind: "address", value: OWNER }, observedAt: at },
      fields,
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: await spanOf(one, sentence),
    };
    return checkCorrespondence(one, { claims: [claim], narrowing: "none" } as never);
  }
  const reasons = (result: Awaited<ReturnType<typeof said>>) => result.unmapped.map((one) => one.reason);

  it("multi_fact: a key phrase with a sentence break, or a conjunction between two verbs, is unmapped", async () => {
    const two = await said("We will raise a seed round and hire two engineers.", "goal", {
      objective: "raise a seed round and hire two engineers",
      domain: "ventures",
    });
    expect(two.claims).toEqual([]);
    expect(reasons(two)).toEqual(["multi_fact"]);
    const broken = await said("Move to Portland. Start at Alder.", "goal", {
      objective: "Move to Portland. Start at Alder",
      domain: "career",
    });
    expect(reasons(broken)).toEqual(["multi_fact"]);
    const one = await said("We need a cofounder and a designer.", "need", {
      object: "a cofounder and a designer",
      domain: "ventures",
    });
    expect(reasons(one)).toEqual([]);
    expect(one.claims.length).toBe(1);
  });

  it("a null in a situation's optional field is that field absent, and its refusal detail names no null", async () => {
    const sentence = "I am moving to Portland in May.";
    const moving = { state: "moving to Portland", domain: "home" };
    const absent = await said(sentence, "situation", { ...moving, until: null, momentary: null });
    expect(reasons(absent)).toEqual([]);
    expect(absent.claims.map((one) => one.claim.content.fields)).toEqual([moving]);
    expect(reasons(await said(sentence, "situation", { ...moving, until: "May" }))).toEqual(["bad_fields"]);
    expect(reasons(await said(sentence, "situation", { ...moving, momentary: "no" }))).toEqual(["bad_fields"]);
    expect(reasons(await said(sentence, "situation", { state: null, domain: "home" }))).toEqual(["bad_fields"]);
    const situation = ontologyFor("correspondence", FACT_KIND_VERSIONS.correspondence).get("situation");
    expect(fieldsDetail(situation, { ...moving, until: null, momentary: "no" })).toEqual({
      field: "momentary",
      issue: "not_boolean",
    });
    expect(fieldsDetail(situation, { state: null, domain: "home" })).toEqual({ field: "state", issue: "not_text" });
  });

  it("a null in a status's optional since is that field absent; a present since is checked as before", async () => {
    const sentence = "Your passport renewal with the Harbor Passport Office is in review.";
    const renewal = {
      organization_name: "Harbor Passport Office",
      process: "passport renewal",
      state: "in review",
      domain: "admin",
    };
    const status = async (fields: Record<string, unknown>) => {
      const one = message(sentence);
      const claim = {
        type: "status",
        subject: { key: { kind: "address", value: OWNER }, observedAt: at },
        fields,
        statementKind: "stated_fact",
        basis: "explicit_self",
        span: await spanOf(one, sentence),
      };
      return checkCorrespondence(
        one,
        { claims: [claim], narrowing: "none" } as never,
        FACT_KIND_VERSIONS.correspondence,
      );
    };
    expect(reasons(await status(renewal))).toEqual([]);
    const absent = await status({ ...renewal, since: null });
    expect(reasons(absent)).toEqual([]);
    expect(absent.claims.map((one) => one.claim.content.fields)).toEqual([renewal]);
    expect(reasons(await status({ ...renewal, since: "lately" }))).toEqual(["bad_fields"]);
    expect(reasons(await status({ ...renewal, state: null }))).toEqual(["bad_fields"]);
    const type = ontologyFor("correspondence", FACT_KIND_VERSIONS.correspondence).get("status");
    expect(fieldsDetail(type, { ...renewal, since: null })).toEqual({});
    expect(fieldsDetail(type, { ...renewal, since: "lately" })).toEqual({ field: "since", issue: "not_date" });
  });

  it("a key phrase of more than 12 words is unmapped as bad_fields", async () => {
    const sentence = "I want to build a small cabin by the lake with my two brothers next year.";
    const long = await said(sentence, "goal", {
      objective: "build a small cabin by the lake with my two brothers next year",
      domain: "home",
    });
    expect(reasons(long)).toEqual(["bad_fields"]);
  });

  it("negated_object: a preference's leading negation moves into its polarity, and one still negated is unmapped", async () => {
    for (const [sentence, object] of [
      ["Please, no em dashes.", "no em dashes"],
      ["Never em dashes, please.", "Never em dashes"],
      ["Avoid em dashes.", "Avoid em dashes"],
    ] as const) {
      const { claims } = await said(sentence, "preference", { object, domain: "career", polarity: "prefers" });
      expect(
        claims.map((one) => one.claim.content.fields),
        sentence,
      ).toEqual([{ object: "em dashes", domain: "career", polarity: "avoids" }]);
    }
    const keys = await Promise.all(
      [
        ["Please, no em dashes.", "no em dashes", "prefers"],
        ["Never em dashes, please.", "Never em dashes", "prefers"],
        ["Em dashes, never.", "Em dashes", "avoids"],
      ].map(
        async ([sentence, object, polarity]) =>
          (await said(sentence as string, "preference", { object, domain: "career", polarity })).claims[0]?.factKey,
      ),
    );
    expect(keys.every((key) => key !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(1);
    expect(
      reasons(
        await said("I would never not answer on weekends.", "preference", {
          object: "never not answer on weekends",
          domain: "career",
          polarity: "prefers",
        }),
      ),
    ).toEqual(["negated_object"]);
    expect(
      reasons(await said("Never.", "preference", { object: "Never", domain: "career", polarity: "prefers" })),
    ).toEqual(["negated_object"]);
  });

  it("negated_object: a negation with `avoids` already is a double negative, refused and never flipped", async () => {
    for (const [sentence, object] of [
      ["Please, no em dashes.", "no em dashes"],
      ["Never.", "Never"],
      ["I would never not answer on weekends.", "never not answer on weekends"],
    ] as const) {
      expect(
        reasons(await said(sentence, "preference", { object, domain: "career", polarity: "avoids" })),
        sentence,
      ).toEqual(["negated_object"]);
    }
  });

  it("a negation inside a hyphenated compound stays in the object, and the polarity stays as given", async () => {
    const avoided = await said("I avoid no-name brands.", "preference", {
      object: "no-name brands",
      domain: "money",
      polarity: "avoids",
    });
    expect(avoided.claims.map((one) => one.claim.content.fields)).toEqual([
      { object: "no-name brands", domain: "money", polarity: "avoids" },
    ]);
    const preferred = await said("I prefer no-code tools.", "preference", {
      object: "no-code tools",
      domain: "career",
      polarity: "prefers",
    });
    expect(preferred.claims.map((one) => one.claim.content.fields)).toEqual([
      { object: "no-code tools", domain: "career", polarity: "prefers" },
    ]);
  });

  it("a key phrase over 90 code points, or one with no word in it, is unmapped as bad_fields", async () => {
    const long = "我们".repeat(46);
    expect(reasons(await said(`${long}。`, "goal", { objective: long, domain: "ventures" }))).toEqual(["bad_fields"]);
    const short = "我们".repeat(45);
    expect(reasons(await said(`${short}。`, "goal", { objective: short, domain: "ventures" }))).toEqual([]);
    expect(reasons(await said("We hope for 🙂🙂 soon.", "goal", { objective: "🙂🙂", domain: "ventures" }))).toEqual([
      "bad_fields",
    ]);
  });

  // Mail passes the one check every source passes (personal-core's checkKeyFields).
  it("a mail key phrase that does not stand alone is unmapped not_standalone, and a list of three multi_fact", async () => {
    expect(
      reasons(
        await said("I will reach out to them instead of applying.", "goal", {
          objective: "reach out to them instead of applying",
          domain: "career",
        }),
      ),
    ).toEqual(["not_standalone"]);
    // The owner is the subject, so their possessive after the first word names the owner's own.
    expect(
      reasons(
        await said("I am visiting my parents in May.", "goal", { objective: "visiting my parents", domain: "family" }),
      ),
    ).toEqual([]);
    // "that" is a relative only before its clause's subject; when unsure, refuse.
    expect(
      reasons(
        await said("I want a job that the team likes.", "goal", {
          objective: "a job that the team likes",
          domain: "career",
        }),
      ),
    ).toEqual([]);
    expect(
      reasons(
        await said("I want a job that pays well.", "goal", { objective: "a job that pays well", domain: "career" }),
      ),
    ).toEqual(["not_standalone"]);
    expect(
      reasons(
        await said("I will contact that investor.", "goal", { objective: "contact that investor", domain: "career" }),
      ),
    ).toEqual(["not_standalone"]);
    expect(
      reasons(
        await said("I want to reduce I/O latency.", "goal", { objective: "reduce I/O latency", domain: "career" }),
      ),
    ).toEqual([]);
    expect(
      reasons(
        await said("I will finish that project.", "goal", { objective: "finish that project", domain: "career" }),
      ),
    ).toEqual(["not_standalone"]);
    expect(
      reasons(
        await said("I am flying to Lisbon tomorrow.", "situation", {
          state: "flying to Lisbon tomorrow",
          domain: "travel",
        }),
      ),
    ).toEqual(["not_standalone"]);
    expect(
      reasons(
        await said("I am flying to Lisbon tomorrow.", "situation", {
          state: "flying to Lisbon tomorrow",
          domain: "travel",
          until: "2026-03-03",
        }),
      ),
    ).toEqual([]);
    expect(
      reasons(
        await said("I have lived in Seattle, Denver, and Portland.", "situation", {
          state: "lived in Seattle, Denver, and Portland",
          domain: "home",
        }),
      ),
    ).toEqual(["multi_fact"]);
    // A leading first-person subject is kept as written and dropped from the key.
    const subject = await said("I moved to Portland.", "situation", { state: "I moved to Portland", domain: "home" });
    expect(kept(subject, "state")).toEqual(["I moved to Portland"]);
    expect(subject.claims[0]?.factKey).toBe(
      (await said("I moved to Portland.", "situation", { state: "moved to Portland", domain: "home" })).claims[0]
        ?.factKey,
    );
  });

  it("a missing or unlisted domain is the shared field refusal", async () => {
    expect(reasons(await said("We hope to raise a seed round.", "goal", { objective: "raise a seed round" }))).toEqual([
      "bad_fields",
    ]);
    expect(
      reasons(
        await said("We hope to raise a seed round.", "goal", { objective: "raise a seed round", domain: "startups" }),
      ),
    ).toEqual(["bad_fields"]);
  });

  it("a claim at the generation of key version 2 has its version 1 key beside it", async () => {
    const { claims } = await said("We hope to raise a seed round.", "goal", {
      objective: "raise a seed round",
      domain: "ventures",
    });
    const [record] = claims;
    expect(record?.claim.extractorGeneration).toBe(5);
    const thread = openEvalMessage(message("We hope to raise a seed round.")).raw.threadId as string;
    expect(record?.legacyFactKey).toBe(legacyFactKey(record?.claim.content as never, thread, ["own"]));
    expect(record?.legacyFactKey).not.toBe(record?.factKey);
  });

  // A key phrase is grounded as the model wrote it, before the normalizer, with case, quotes,
  // dashes and white space folded, and a phrase that is no slice is `bad_fields`. `bad_span` is the
  // citation's alone.
  const kept = (result: Awaited<ReturnType<typeof said>>, field: string) =>
    result.claims.map((one) => one.claim.content.fields[field]);

  it("a key phrase is grounded as written, with case, curly quotes and dashes folded, and keeps the passage's slice", async () => {
    expect(
      kept(
        await said("I can review founders’ term sheets.", "capability", {
          object: "founders' term sheets",
          domain: "ventures",
        }),
        "object",
      ),
    ).toEqual(["founders’ term sheets"]);
    expect(
      kept(
        await said("I can review founders' term sheets.", "capability", {
          object: "founders’ term sheets",
          domain: "ventures",
        }),
        "object",
      ),
    ).toEqual(["founders' term sheets"]);
    expect(
      kept(
        await said("I am training for the Portland Marathon.", "situation", {
          state: "Training for the portland marathon",
          domain: "health",
        }),
        "state",
      ),
    ).toEqual(["training for the Portland Marathon"]);
    expect(
      kept(
        await said("I want a full–time role in Lisbon.", "goal", {
          objective: "a full-time role in Lisbon",
          domain: "career",
        }),
        "objective",
      ),
    ).toEqual(["a full–time role in Lisbon"]);
  });

  it("the normalizer is for the key alone: a phrase with its article is grounded and stored as written, and keys as the phrase with another", async () => {
    const the = await said("We will raise the seed round in May.", "goal", {
      objective: "raise the seed round",
      domain: "ventures",
    });
    const a = await said("We will raise a seed round in May.", "goal", {
      objective: "raise a seed round",
      domain: "ventures",
    });
    expect(kept(the, "objective")).toEqual(["raise the seed round"]);
    expect(the.claims[0]?.factKey).toBe(a.claims[0]?.factKey);
    // A phrase the model shortened, or one the message does not hold, is no slice: refused as a
    // field, never as a span.
    expect(
      reasons(
        await said("We will raise the seed round in May.", "goal", {
          objective: "raise seed round",
          domain: "ventures",
        }),
      ),
    ).toEqual(["bad_fields"]);
    expect(
      reasons(
        await said("We will raise the seed round in May.", "goal", { objective: "hire a lawyer", domain: "ventures" }),
      ),
    ).toEqual(["bad_fields"]);
  });

  it("a key phrase across a wrapped line is one fact, stored as the passage writes it; a blank line still breaks it", async () => {
    const wrapped = await said("We hope to raise\na seed round by June.", "goal", {
      objective: "raise a seed round",
      domain: "ventures",
    });
    expect(reasons(wrapped)).toEqual([]);
    expect(kept(wrapped, "objective")).toEqual(["raise\na seed round"]);
    expect(wrapped.claims[0]?.factKey).toBe(
      (
        await said("We hope to raise a seed round by June.", "goal", {
          objective: "raise a seed round",
          domain: "ventures",
        })
      ).claims[0]?.factKey,
    );
    expect(
      reasons(
        await said("Move to Portland\n\nStart at Alder", "goal", {
          objective: "Move to Portland Start at Alder",
          domain: "career",
        }),
      ),
    ).toEqual(["multi_fact"]);
  });

  it("bad_span is the citation's: a span no segment holds, a quoted segment or the subject line; a listed span, or a part of one, is kept", async () => {
    const own = "I am moving to Portland in May.";
    const reply: EvalMessage = {
      id: "k2-span",
      from: OWNER,
      to: "lena.park@north.example",
      paragraphs: [own, "On Sun, 1 Mar 2026, lena.park@north.example wrote:\n> We hope to raise a seed round by June."],
      expected: [],
    };
    const { parsed } = await readStored(openEvalMessage(reply), ["own"]);
    const [subject, mine, quoted] = parsed.segments;
    expect([subject?.span, mine?.span, quoted?.quoted]).toEqual(["subject:chars:0-11", `chars:0-${own.length}`, true]);
    const moving = (span: string) => ({
      type: "situation",
      subject: { key: { kind: "address", value: OWNER }, observedAt: at },
      fields: { state: "moving to Portland", domain: "home" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span,
    });
    const raising = (span: string) => ({
      type: "goal",
      subject: { key: { kind: "address", value: "lena.park@north.example" }, observedAt: at },
      fields: { objective: "raise a seed round", domain: "ventures" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span,
    });
    const checked = async (claim: object) =>
      reasons(await checkCorrespondence(reply, { claims: [claim], narrowing: "none" } as never));
    expect(await checked(moving(mine?.span as string))).toEqual([]);
    expect(await checked(moving("chars:5-28"))).toEqual([]);
    // Offsets a model counted itself, past the end of the segment.
    expect(await checked(moving(`chars:0-${own.length + 8}`))).toEqual(["bad_span"]);
    expect(await checked(raising(quoted?.span as string))).toEqual(["bad_span"]);
    expect(
      await checked({ ...raising(subject?.span as string), fields: { objective: "Catching up", domain: "ventures" } }),
    ).toEqual(["bad_span"]);
  });

  // The run checks at generation 5, so every claim has its version 1 key beside it, the same as its
  // own for a kind version 2 does not change; at generation 4 none.
  it("a claim the run checks from the go, at generation 5, has its version 1 key beside it; one at generation 4 has none", async () => {
    const s = await setup();
    await processOne(s, s.w.handles.planMessageId);
    const records = recordsOf(s, s.w.handles.planMessageId);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.claim.extractorGeneration).toBe(5);
      expect(record.legacyFactKey).toBe(record.factKey);
    }
    const before = await setup();
    before.deps.generation = 4;
    await processOne(before, before.w.handles.planMessageId);
    for (const record of recordsOf(before, before.w.handles.planMessageId)) {
      expect(record.claim.extractorGeneration).toBe(4);
      expect(record.legacyFactKey).toBeUndefined();
    }
  });
});

describe("the commitment bar on the mail lane", () => {
  // One commitment by the sender of a real message of the world, its what a slice of the body.
  const asked = async (s: Setup, what: string, turned = false, before = "") => {
    const id = s.w.handles.commitmentInboundMessageId;
    changed(s, id, (message) => {
      message.text = `${before}${what}\r\n`;
    });
    const output = outputOf(s, id);
    const claim = first(output);
    const { counterparty } = claim.fields as { counterparty: Candidate["subject"] };
    output.claims = [
      {
        ...claim,
        ...(turned ? { subject: counterparty } : {}),
        fields: { counterparty: turned ? claim.subject : counterparty, what },
        span: `chars:0-${before.length + what.length}`,
      },
    ];
    answering(s, { [id]: output });
    await processOne(s, id);
    return { records: recordsOf(s, id), reasons: unmappedOf(s, id).map((one) => one.reason) };
  };

  it("under the fifth wording refuses a remark and an ask, and keeps a promise with its own object", async () => {
    const remark = await asked(await setup({ factKinds: ["correspondence"] }), "I'll be there");
    expect(remark).toMatchObject({ records: [], reasons: ["not_a_promise"] });
    const ask = await asked(await setup({ factKinds: ["correspondence"] }), "Can you send me the form?");
    expect(ask).toMatchObject({ records: [], reasons: ["not_a_promise"] });
    const promise = await asked(await setup({ factKinds: ["correspondence"] }), "I'll send you the signed lease");
    expect(promise.reasons).toEqual([]);
    expect(promise.records.map((one) => one.claim.content.fields.what)).toEqual(["I'll send you the signed lease"]);
  });

  it("under the fifth wording a pronoun passes when the claim gives its date, or the text before names it", async () => {
    const bare = await asked(await setup({ factKinds: ["correspondence"] }), "I'll send it");
    expect(bare).toMatchObject({ records: [], reasons: ["not_a_promise"] });
    const line = "I'll send it";
    const named = await asked(
      await setup({ factKinds: ["correspondence"] }),
      line,
      false,
      "The signed lease is ready. ",
    );
    expect(named.reasons).toEqual([]);
    expect(named.records.map((one) => one.claim.content.fields.what)).toEqual([line]);
  });

  it("under the fifth wording refuses I will credited to the one spoken to", async () => {
    const turned = await asked(await setup({ factKinds: ["correspondence"] }), "I'll send you the signed lease", true);
    expect(turned).toMatchObject({ records: [], reasons: ["wrong_direction"] });
  });

  it("under an earlier version keeps what it kept, so nothing stored is dropped", async () => {
    const remark = await asked(await setup(), "I'll be there");
    expect(remark.reasons).toEqual([]);
    expect(remark.records.map((one) => one.claim.content.fields.what)).toEqual(["I'll be there"]);
  });
});
