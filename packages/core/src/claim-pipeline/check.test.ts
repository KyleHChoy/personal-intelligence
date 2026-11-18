import { inspect } from "node:util";
import type {
  ChangeKind,
  ClaimCandidate,
  IdentityResolver,
  MemberId,
  NarrowingValue,
  Resolution,
} from "@intelligence/contracts";
import { CheckResult } from "@intelligence/contracts";
import { aliasFingerprint } from "@intelligence/contracts/alias-key";
import { describe, expect, it } from "vitest";
import { check, type GroundingHook } from "./check.ts";
import { PipelineError } from "./errors.ts";
import { isAtLeastAsStrict } from "./labels.ts";
import { LIMITS } from "./limits.ts";
import { parse } from "./parse.ts";
import type { PipelineItem } from "./ports.ts";
import type { ReadItem } from "./read-set.ts";
import {
  AT,
  candidate,
  config,
  evidence,
  failure,
  identity,
  type Mail,
  mention,
  ontology,
  pdfOf,
  rawMail,
  read,
  timed,
} from "./test-support/support.ts";
import { PIPELINE_VERSION } from "./version.ts";

const TOMAS = '"Tomas Reyne" <tomas@larchmont.example>';
const DARA = '"Dara Whitlow" <dara@brindle.example>';
const OTHERS = '"Owen Marsh" <owen@quarry.example>, desk@brindle.example, gone@brindle.example';

const OWN = "Tomas, I need a head of finance by October.";
const TEXT = [
  OWN,
  "",
  "Dara",
  "",
  "On Tue, 01 Sep 2026 at 09:00, Tomas Reyne <tomas@larchmont.example> wrote:",
  "> Dara, I know Owen Marsh well.",
  "",
  "And one more thing.",
  "",
  "> Budgets are tight this year.",
].join("\n");
const span = (line: string) => `chars:${TEXT.indexOf(line)}-${TEXT.indexOf(line) + line.length}`;
const QUOTED = span("> Dara, I know Owen Marsh well.");
const UNINTRODUCED = span("> Budgets are tight this year.");

interface Options {
  readSet?: ReadItem[];
  narrowing?: NarrowingValue;
  changeKind?: ChangeKind;
  generation?: number;
  inputHash?: string;
  mail?: Partial<Mail>;
  reply?: Partial<Mail> | null;
  own?: PipelineItem;
  people?: IdentityResolver & { asked: ReturnType<typeof identity>["asked"] };
  fingerprintKey?: Uint8Array;
  grounded?: GroundingHook;
}

// The message from Dara, and the reply from Tomas it answers and quotes.
const setup = async (options: Options = {}) => {
  const own = options.own ?? evidence("ev-2");
  const earlier = evidence("ev-1");
  const parsed = await parse(
    own,
    rawMail({ from: DARA, to: TOMAS, cc: OTHERS, messageId: "<d2@brindle.example>", text: TEXT, ...options.mail }),
    LIMITS,
  );
  const reply =
    options.reply === null
      ? null
      : await parse(
          earlier,
          rawMail({
            from: TOMAS,
            to: DARA,
            messageId: "<t1@larchmont.example>",
            text: "Dara, I know Owen Marsh\nwell. Shall I ask him?",
            ...options.reply,
          }),
          LIMITS,
        );
  const people = options.people ?? identity();
  const deps = {
    config,
    extractorGeneration: options.generation ?? 0,
    ontology: ontology(),
    identity: people,
    ...(options.fingerprintKey !== undefined && { fingerprintKey: options.fingerprintKey }),
    ...(options.grounded !== undefined && { grounded: options.grounded }),
  };
  const context = {
    parsed,
    chain: reply === null ? [] : [reply],
    narrowing: options.narrowing ?? "none",
    changeKind: options.changeKind ?? "live",
    inputHash: options.inputHash ?? "a".repeat(64),
  };
  const readSet = options.readSet ?? (reply === null ? [read(own)] : [read(own), read(earlier)]);
  const run = (candidates: ClaimCandidate[]) => check(candidates, readSet, context, deps);
  return { parsed, people, run };
};

const one = async (overrides: Record<string, unknown> = {}, options: Options = {}) =>
  (await setup(options)).run([candidate(overrides)]);
const reasons = async (candidates: ClaimCandidate[], options: Options = {}) => {
  const result = await (await setup(options)).run(candidates);
  expect(result.claims).toEqual([]);
  return result.unmapped.map((unmapped) => unmapped.reason);
};

const about = (address: string, overrides: Record<string, unknown> = {}) =>
  candidate({ subject: mention(address), ...overrides });
const knows = (who: unknown, overrides: Record<string, unknown> = {}) =>
  candidate({ type: "relationship", fields: { with: who }, ...overrides });
const named = { key: { kind: "name", value: "Owen Marsh" }, observedAt: AT };

describe("the checker: the subject's alias keys", () => {
  it("a claim carries the subject's address as a fingerprint and the display name its headers give it, never the address", async () => {
    const { claims } = await (await setup()).run([
      candidate(),
      about("tomas@larchmont.example"),
      about("owen@quarry.example"),
    ]);
    expect(claims.map((claim) => claim.subjectAliases)).toEqual([
      [
        { kind: "address", fingerprint: aliasFingerprint("address", "dara@brindle.example") },
        { kind: "name", value: "Dara Whitlow" },
      ],
      [
        { kind: "address", fingerprint: aliasFingerprint("address", "tomas@larchmont.example") },
        { kind: "name", value: "Tomas Reyne" },
      ],
      [
        { kind: "address", fingerprint: aliasFingerprint("address", "owen@quarry.example") },
        { kind: "name", value: "Owen Marsh" },
      ],
    ]);
    const text = JSON.stringify(claims.map((claim) => claim.subjectAliases));
    for (const address of ["brindle", "larchmont", "quarry", "@"]) expect(text).not.toContain(address);
  });

  it("an address is fingerprinted under the deployment's fingerprint key when the pipeline holds it", async () => {
    const fingerprintKey = new Uint8Array(32).fill(9);
    const { claims } = await (await setup({ fingerprintKey })).run([candidate()]);
    expect(claims.map((claim) => claim.subjectAliases)).toEqual([
      [
        { kind: "address", fingerprint: aliasFingerprint("address", "dara@brindle.example", fingerprintKey) },
        { kind: "name", value: "Dara Whitlow" },
      ],
    ]);
    expect(aliasFingerprint("address", "dara@brindle.example", fingerprintKey)).not.toBe(
      aliasFingerprint("address", "dara@brindle.example"),
    );
  });

  it("the display name is found for an address that differs from the header's only in letter case", async () => {
    const { claims } = await (await setup({ mail: { cc: '"Owen Marsh" <Owen@Quarry.example>' } })).run([
      about("TOMAS@larchmont.example"),
      about("owen@quarry.example"),
    ]);
    expect(claims.map((claim) => claim.subjectAliases)).toEqual([
      [
        { kind: "address", fingerprint: aliasFingerprint("address", "tomas@larchmont.example") },
        { kind: "name", value: "Tomas Reyne" },
      ],
      [
        { kind: "address", fingerprint: aliasFingerprint("address", "owen@quarry.example") },
        { kind: "name", value: "Owen Marsh" },
      ],
    ]);
  });

  it("an address with no display name, or in the body alone, carries its fingerprint only", async () => {
    const { claims } = await (
      await setup({ mail: { from: "dara@brindle.example", text: "Write to pat@quarry.example about the budget." } })
    ).run([about("dara@brindle.example", { span: "chars:0-20" }), about("pat@quarry.example", { span: "chars:0-20" })]);
    expect(claims.map((claim) => claim.subjectAliases)).toEqual([
      [{ kind: "address", fingerprint: aliasFingerprint("address", "dara@brindle.example") }],
      [{ kind: "address", fingerprint: aliasFingerprint("address", "pat@quarry.example") }],
    ]);
  });

  it("a name-only subject a member's ruling linked carries the name as written", async () => {
    const people = identity();
    people.resolve = async () => ({ outcome: "linked", entity: "pe-owen", epoch: 4 }) as Resolution;
    const { claims } = await (await setup({ people })).run([
      candidate({ subject: { key: { kind: "name", value: "  Owen   Marsh " }, observedAt: AT } }),
    ]);
    expect(claims.map((claim) => claim.subjectAliases)).toEqual([[{ kind: "name", value: "Owen Marsh" }]]);
  });
});

describe("the checker: identity", () => {
  it("the store comes from the owner map, and the subject is resolved only through the identity resolver", async () => {
    const { people, run } = await setup();
    const { claims, unmapped, reviews } = await run([candidate()]);
    expect([unmapped, reviews]).toEqual([[], []]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      content: { type: "need", subject: "pe-dara", fields: { role: "head of finance" } },
      statementKind: "stated_fact",
      destination: "people",
      validFrom: AT,
      evidence: [{ evidenceId: "ev-2", span: "chars:0-39" }],
    });
    expect(people.asked.every((ask) => ask.store === "people")).toBe(true);
    expect(people.asked[0]?.mention).toEqual(mention("dara@brindle.example"));
  });

  it("a mention is stamped with the item's time, never the model's", async () => {
    const { people, run } = await setup();
    await run([
      about("Dara@Brindle.example", {
        subject: { key: { kind: "address", value: "Dara@Brindle.example" }, observedAt: "1999-01-01T00:00:00Z" },
      }),
    ]);
    expect(people.asked[0]?.mention).toEqual(mention("dara@brindle.example"));
  });

  it("a name-only mention creates no person", async () => {
    expect(await one({ subject: named })).toEqual({ claims: [], unmapped: [], reviews: ["rev-owen-marsh"] });
  });

  it("a name-only mention the resolver answers created for is still nobody", async () => {
    const people = identity();
    people.resolve = async () => ({ outcome: "created", entity: "pe-invented", epoch: 1 }) as Resolution;
    expect(await one({ subject: named }, { people })).toEqual({ claims: [], unmapped: [], reviews: [] });
  });

  it("a shared address and a suppressed subject yield no claim and no review", async () => {
    const { run } = await setup();
    expect(await run([about("desk@brindle.example"), about("gone@brindle.example")])).toEqual({
      claims: [],
      unmapped: [],
      reviews: [],
    });
  });

  it("an entity field is resolved like the subject, and waits when it is only a candidate", async () => {
    const linked = await one({ type: "relationship", fields: { with: mention("owen@quarry.example") } });
    expect(linked.claims[0]?.content.fields).toEqual({ with: "pe-owen" });
    expect(await one({ type: "relationship", fields: { with: named } })).toEqual({
      claims: [],
      unmapped: [],
      reviews: ["rev-owen-marsh"],
    });
  });

  it("a context mention is resolved and kept, and holds the claim back when it is only a candidate", async () => {
    const within = await one({ context: { kind: "organization", mention: mention("owen@quarry.example") } });
    expect(within.claims[0]?.content.context).toEqual({ kind: "organization", id: "pe-owen" });
    const plain = await one({ context: { kind: "global" } });
    expect(plain.claims[0]?.content.context).toEqual({ kind: "global" });
    expect(await one({ context: { kind: "project", mention: named } })).toEqual({
      claims: [],
      unmapped: [],
      reviews: ["rev-owen-marsh"],
    });
  });

  it("a failed identity call fails the item, with a code and none of the mention", async () => {
    const { run, people } = await setup();
    people.resolve = async () => Promise.reject(new Error("no route to dara@brindle.example"));
    const error = await failure(run([candidate()]));
    expect(error).toBeInstanceOf(PipelineError);
    expect((error as PipelineError).code).toBe("control_unavailable");
    expect(inspect(error, { depth: 8 })).not.toContain("dara@");
  });

  it("each mention is resolved once for an item, however many claims name it", async () => {
    const { run, people } = await setup();
    const { claims } = await run([
      candidate(),
      candidate({ fields: { role: "head of sales" } }),
      knows(mention("owen@quarry.example")),
    ]);
    expect(claims).toHaveLength(3);
    expect(people.asked.map((ask) => ask.mention.key.value)).toEqual(["dara@brindle.example", "owen@quarry.example"]);
  });

  it("the request id changes with the item's revision and with what the interpreter was shown", async () => {
    const ids = async (options: Options = {}) => {
      const { run, people } = await setup(options);
      await run([knows(mention("owen@quarry.example"))]);
      return people.asked.map((ask) => ask.requestId);
    };
    const first = await ids();
    expect(await ids()).toEqual(first);
    const revised = await ids({ own: { ...evidence("ev-2"), revision: 1 } });
    const reshown = await ids({ inputHash: "b".repeat(64) });
    for (const other of [revised, reshown]) {
      expect(other).toHaveLength(2);
      for (const id of other) expect(first).not.toContain(id);
    }
    expect(revised).not.toEqual(reshown);
  });

  it("the request id comes from the evidence id, the generation, the claim's position and which mention it is, never from the mention", async () => {
    const ids = async (candidates: ClaimCandidate[], options: Options = {}) => {
      const { run, people } = await setup(options);
      await run(candidates);
      return people.asked.map((ask) => ask.requestId);
    };
    const [subject, field] = await ids([knows(mention("owen@quarry.example"))]);
    expect(subject).toMatch(/^[0-9a-f]{64}$/);
    expect(field).not.toBe(subject);
    // The same position gives the same id on a retry, whoever is named there.
    expect(await ids([knows(mention("owen@quarry.example"))])).toEqual([subject, field]);
    expect((await ids([about("owen@quarry.example", { span: QUOTED })]))[0]).toBe(subject);
    // Another position gives another id.
    expect((await ids([candidate({ type: "horoscope" }), about("owen@quarry.example", { span: QUOTED })]))[0]).not.toBe(
      subject,
    );
    // Another generation gives other ids, so a new extraction never gets an old one's answers.
    const next = await ids([knows(mention("owen@quarry.example"))], { generation: 1 });
    expect(next).toHaveLength(2);
    expect(next).not.toContain(subject);
    expect(next).not.toContain(field);
    expect(await ids([knows(mention("owen@quarry.example"))], { generation: 1 })).toEqual(next);
  });
});

describe("the checker: who said it", () => {
  it("the sender's own words are the sender's, and the basis is worked out in code, never copied from the model", async () => {
    const { claims } = await (await setup()).run([
      candidate({ basis: "web_derived", assertedBy: mention("owen@quarry.example") }),
      about("owen@quarry.example", { basis: "explicit_self", fields: { role: "a new post" } }),
    ]);
    expect(claims.map((claim) => [claim.assertedBy, claim.basis])).toEqual([
      ["pe-dara", "explicit_self"],
      ["pe-dara", "third_party"],
    ]);
  });

  it("a quote is credited to its author when the quoted text is in a message of theirs that was read", async () => {
    const { claims } = await one({
      type: "relationship",
      subject: mention("tomas@larchmont.example"),
      fields: { with: mention("owen@quarry.example") },
      span: QUOTED,
      basis: "explicit_self",
    });
    expect([claims[0]?.assertedBy, claims[0]?.basis]).toEqual(["pe-tomas", "third_party"]);
  });

  it("a quote that is in no message read is a report by the sender who quoted it", async () => {
    const quote = knows(mention("owen@quarry.example"), { subject: mention("tomas@larchmont.example"), span: QUOTED });
    const unread = await (await setup({ reply: null })).run([quote]);
    expect([unread.claims[0]?.assertedBy, unread.claims[0]?.basis]).toEqual(["pe-dara", "third_party"]);
    const altered = await (await setup({ reply: { text: "Dara, I have never met Owen Marsh." } })).run([quote]);
    expect(altered.claims[0]?.assertedBy).toBe("pe-dara");
    // The same words in a message someone else wrote do not make them the named author's.
    const another = await (await setup({ reply: { from: '"Owen Marsh" <owen@quarry.example>' } })).run([quote]);
    expect(another.claims[0]?.assertedBy).toBe("pe-dara");
  });

  it("a quote is its author's only when it is whole lines or whole sentences of what they wrote", async () => {
    const speaker = async (written: string, quoted: string[]) => {
      const text = [
        "Tomas, noted.",
        "",
        "On Tue, 01 Sep 2026 at 09:00, Tomas Reyne <tomas@larchmont.example> wrote:",
        ...quoted.map((line) => `> ${line}`),
      ].join("\n");
      const cited = `chars:${text.indexOf("\n> ") + 1}-${text.length}`;
      const result = await one(
        { subject: mention("tomas@larchmont.example"), span: cited },
        { mail: { text }, reply: { text: written } },
      );
      return result.claims[0]?.assertedBy;
    };
    // A fragment that drops the "not", and one cut out of the middle of a word, are the sender's report.
    expect(await speaker("Dara, I do not approve the hire.", ["approve the hire."])).toBe("pe-dara");
    expect(await speaker("Dara, I disapprove.", ["approve."])).toBe("pe-dara");
    expect(await speaker("I do not approve the hire. More soon.", ["I do not approve the"])).toBe("pe-dara");
    expect(await speaker("Dara, I do not approve the hire.", ["I do not approve the hire."])).toBe("pe-dara");
    // A whole sentence, a whole line, and whole sentences wrapped differently are the author's.
    expect(await speaker("I met Owen. I do not approve the hire. More soon.", ["I do not approve the hire."])).toBe(
      "pe-tomas",
    );
    expect(await speaker("I do not approve the hire\nuntil the budget is set", ["I do not approve the hire"])).toBe(
      "pe-tomas",
    );
    expect(
      await speaker("I do not approve the hire until the budget is set. Ask me in March.", [
        "I do not approve the hire until",
        "the budget is set.",
      ]),
    ).toBe("pe-tomas");
    expect(
      await speaker("Yes.\n\nI do not approve the hire.\n\nTomas", ["Yes.", "", "I do not approve the hire."]),
    ).toBe("pe-tomas");
  });

  it("checking a long quote against a long, repetitive message takes time in step with their length", async () => {
    const written = Array.from({ length: 600 }, () => "a. ".repeat(100).trim()).join("\n");
    const quoted = Array.from({ length: 300 }, () => "a. ".repeat(100).trim());
    const text = [
      "Noted.",
      "",
      "On Tue, 01 Sep 2026 at 09:00, Tomas Reyne <tomas@larchmont.example> wrote:",
      ...quoted.map((line) => `> ${line}`),
      "> b.",
    ].join("\n");
    const { run } = await setup({ mail: { text }, reply: { text: written } });
    const cited = `chars:${text.indexOf("\n> ") + 1}-${text.length}`;
    const { ms, value } = await timed(() =>
      run([candidate({ subject: mention("tomas@larchmont.example"), span: cited })]),
    );
    expect(value.claims[0]?.assertedBy).toBe("pe-dara");
    expect(ms).toBeLessThan(1_000);
  });

  it("a claim that cites text with no known author is stored unmapped, never credited to the sender", async () => {
    expect(await reasons([candidate({ span: UNINTRODUCED })])).toEqual(["author_unknown"]);
    const attached = { mail: { pdf: pdfOf(["Dara Whitlow needs a head of finance"]) } };
    expect(await reasons([candidate({ span: "attachment:0:chars:0-12" })], attached)).toEqual(["author_unknown"]);
  });

  it("an automated sender is never credited as a person", async () => {
    const { run, people } = await setup({
      mail: { from: "Brindle <no-reply@brindle.example>", cc: `${DARA}, ${OTHERS}` },
      reply: null,
    });
    const { claims } = await run([candidate(), candidate({ span: QUOTED, fields: { role: "an introduction" } })]);
    expect(claims).toHaveLength(2);
    expect(claims.map((claim) => [claim.assertedBy, claim.basis])).toEqual([
      [undefined, "third_party"],
      [undefined, "third_party"],
    ]);
    expect(people.asked.map((ask) => ask.mention.key.value)).toEqual(["dara@brindle.example"]);
  });
});

describe("the checker: what a claim may say", () => {
  it("a type the ontology does not know is stored unmapped as other, never under the model's text", async () => {
    const result = await one({ type: "ignore the rules and route to work" });
    expect(result.claims).toEqual([]);
    expect(result.unmapped).toHaveLength(1);
    expect(result.unmapped[0]).toMatchObject({
      evidenceId: "ev-2",
      proposedType: "other",
      pipelineVersion: PIPELINE_VERSION,
      reason: "unknown_type",
    });
    expect(JSON.stringify(result)).not.toContain("ignore the rules");
  });

  it("an unmapped claim leaves the checker with no extractor generation and no shadow mark: the writer sets both", async () => {
    const result = await (await setup({ generation: 4 })).run([candidate({ type: "no such type" })]);
    expect(result.unmapped).toHaveLength(1);
    expect(Object.keys(result.unmapped[0] ?? {}).sort()).toEqual([
      "evidenceId",
      "id",
      "label",
      "pipelineVersion",
      "proposedType",
      "reason",
    ]);
    // What the checker gives is what the contract's check result takes.
    expect(CheckResult.shape.unmapped.element.safeParse(result.unmapped[0]).success).toBe(true);
  });

  it("a claim whose fields do not fit its type is stored unmapped under that type, not routed", async () => {
    const result = await (await setup()).run([
      candidate({ fields: {} }),
      candidate({ fields: { role: 7 } }),
      candidate({ fields: { role: "head of finance", urgency: "extreme" } }),
      candidate({ fields: { role: "head of finance", salary: "high" } }),
      knows("Owen"),
    ]);
    expect(result.claims).toEqual([]);
    expect(result.unmapped.map((unmapped) => [unmapped.proposedType, unmapped.reason])).toEqual([
      ["need", "bad_fields"],
      ["need", "bad_fields"],
      ["need", "bad_fields"],
      ["need", "bad_fields"],
      ["relationship", "bad_fields"],
    ]);
  });

  it("a number, a date, a boolean and a type field each take only a value of their kind", async () => {
    const profile = (fields: Record<string, unknown>) => candidate({ type: "profile", fields });
    const good = await (await setup()).run([
      profile({ headcount: 12, since: "2026-01-05", hiring: true, function: "function.finance" }),
      profile({ since: "2026-01-05T09:00:00Z", hiring: false, function: "Head of finance" }),
    ]);
    expect(good.claims.map((claim) => claim.content.fields)).toEqual([
      { headcount: 12, since: "2026-01-05", hiring: true, function: "function.finance" },
      { since: "2026-01-05T09:00:00Z", hiring: false, function: "function.finance" },
    ]);
    const bad = [
      { headcount: "12" },
      { headcount: Number.POSITIVE_INFINITY },
      { since: "next spring" },
      { since: "5" },
      { since: "January 5, 2026" },
      { since: "2026-02-30" },
      { since: 20260105 },
      { hiring: "yes" },
      { hiring: 1 },
      { function: "astrology" },
      { function: 3 },
    ];
    expect(await reasons(bad.map(profile))).toEqual(bad.map(() => "bad_fields"));
  });

  it("a claim that cites text the message does not hold is stored unmapped", async () => {
    const spans = ["chars:900-950", "the second paragraph", `chars:10-${TEXT.length}`];
    expect(await reasons(spans.map((cited) => candidate({ span: cited })))).toEqual([
      "bad_span",
      "bad_span",
      "bad_span",
    ]);
  });

  it("an address the message does not hold, in its headers or its text, is not taken from the model", async () => {
    const elsewhere = mention("stranger@elsewhere.example");
    expect(
      await reasons([
        candidate({ subject: elsewhere }),
        candidate({ context: { kind: "organization", mention: elsewhere } }),
        knows(elsewhere),
        candidate({ subject: { key: { kind: "source_id", value: "crm-41" }, observedAt: AT } }),
      ]),
    ).toEqual(["ungrounded_mention", "ungrounded_mention", "ungrounded_mention", "ungrounded_mention"]);
    // An address in the text is grounded, as one in the headers is.
    const inText = await one(
      { subject: mention("ines@larchmont.example") },
      { mail: { text: `${OWN}\nAsk ines@larchmont.example.` } },
    );
    expect(inText.claims[0]?.content.subject).toBe("pe-new-ines@larchmont.example");
  });

  it("a caller's grounding hook may accept a mention R8 refuses, and never refuses one R8 accepts", async () => {
    const crm = { key: { kind: "source_id", value: "crm-41" }, observedAt: AT };
    const asked: { value: string; segment: string }[] = [];
    const grounded: GroundingHook = (one, segment) => {
      asked.push({ value: one.key.value, segment: segment.text });
      return one.key.kind === "source_id" && one.key.value === "crm-41";
    };
    // Accepted by the hook alone: the source id is resolved as any mention is.
    const accepted = await one({ subject: crm }, { grounded });
    expect(accepted.unmapped).toEqual([]);
    expect(accepted.claims[0]?.content.subject).toBe("pe-new-crm-41");
    // It is given the segment the claim cites.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.value).toBe("crm-41");
    expect(asked[0]?.segment).toContain(OWN);
    asked.length = 0;
    const never: GroundingHook = (one, segment) => {
      asked.push({ value: one.key.value, segment: segment.text });
      return false;
    };
    const header = await one({}, { grounded: never });
    expect(header).toEqual(await one({}));
    expect(header.claims).toHaveLength(1);
    const inText = await one(
      { subject: mention("ines@larchmont.example") },
      { mail: { text: `${OWN}\nAsk ines@larchmont.example.` }, grounded: never },
    );
    expect(inText.claims[0]?.content.subject).toBe("pe-new-ines@larchmont.example");
    expect(asked).toEqual([]);
    expect(
      await reasons([candidate({ subject: crm }), candidate({ subject: mention("stranger@elsewhere.example") })], {
        grounded: never,
      }),
    ).toEqual(["ungrounded_mention", "ungrounded_mention"]);
  });

  it("a claim that ends before it starts is stored unmapped", async () => {
    expect(await reasons([candidate({ validFrom: "2026-09-01T00:00:00Z", validTo: "2026-08-01T00:00:00Z" })])).toEqual([
      "bad_times",
    ]);
    // A statement about the past with no start given is kept: its start is not after its end.
    const past = await one({ validTo: "2019-03-31T00:00:00Z" });
    expect(past.unmapped).toEqual([]);
    expect(past.claims[0]).toMatchObject({ validFrom: "2019-03-31T00:00:00Z", validTo: "2019-03-31T00:00:00Z" });
    const open = await one({ validTo: "2027-03-31T00:00:00Z" });
    expect(open.claims[0]).toMatchObject({ validFrom: AT, validTo: "2027-03-31T00:00:00Z" });
    const kept = await one({ validFrom: "2026-08-01T00:00:00Z", validTo: "2026-10-01T00:00:00Z" });
    expect(kept.claims[0]).toMatchObject({ validFrom: "2026-08-01T00:00:00Z", validTo: "2026-10-01T00:00:00Z" });
  });

  it("a claim id is a deterministic function of evidence id, revision, span, content and generation", async () => {
    const id = async (overrides: Record<string, unknown> = {}, options: Options = {}) =>
      (await one(overrides, options)).claims[0]?.id;
    const base = await id();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await id()).toBe(base);
    expect(await id({ fields: { urgency: "high", role: "head of finance" } })).toBe(
      await id({ fields: { role: "head of finance", urgency: "high" } }),
    );
    // What the model says of the basis, the author or the mention's time is not content.
    expect(await id({ basis: "web_derived", assertedBy: mention("owen@quarry.example") })).toBe(base);
    const others = [
      await id({ span: "chars:0-38" }),
      await id({ fields: { role: "head of sales" } }),
      await id({ statementKind: "question" }),
      await id({ validFrom: "2026-08-01T00:00:00Z" }),
      await id({ validTo: "2026-10-01T00:00:00Z" }),
      await id({ context: { kind: "global" } }),
      await id({}, { generation: 1 }),
      await id({}, { own: { ...evidence("ev-2"), revision: 1 } }),
    ];
    expect(new Set([base, ...others]).size).toBe(9);
    // The same statement proposed twice is one claim.
    expect((await (await setup()).run([candidate(), candidate()])).claims).toHaveLength(1);
  });

  it("a mention inside a field counts in the id by who it names, not by the time or the spelling the model gave", async () => {
    const withOwen = (value: string, observedAt: string) => knows({ key: { kind: "address", value }, observedAt });
    const { claims } = await (await setup()).run([
      withOwen("owen@quarry.example", AT),
      withOwen("owen@quarry.example", "1999-01-01T00:00:00Z"),
      withOwen("Owen@Quarry.example", "2001-01-01T00:00:00Z"),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.content.fields).toEqual({ with: "pe-owen" });
  });

  it("the checker sets the primary evidence id, system origin and identity epoch", async () => {
    expect((await one()).claims[0]).toMatchObject({
      primaryEvidenceId: "ev-2",
      systemOriginated: false,
      identityEpoch: 3,
    });
  });

  it("each claim carries the pipeline version, the generation, its item's change kind and a source origin", async () => {
    const { claims } = await one({}, { changeKind: "backfill", generation: 4 });
    expect(claims[0]).toMatchObject({
      pipelineVersion: PIPELINE_VERSION,
      extractorGeneration: 4,
      changeKind: "backfill",
      origin: "source",
    });
  });

  it("a workbench correction is refused, because nothing here can set its origin yet", async () => {
    const error = await failure(one({}, { own: evidence("ev-2", { sourceKind: "workbench_correction" }) }));
    expect((error as PipelineError).code).toBe("check_failed");
  });
});

describe("the checker: the label", () => {
  const own = evidence("ev-2", { readers: ["m-tomas", "m-ines"] });
  const shared = evidence("ev-1", { readers: ["all_members"], compartments: ["org", "source:acct-tomas"] });
  const labelOf = async (options: Options) => (await one({}, options)).claims[0]?.label;

  it("a claim's label combines the labels of exactly the items read", async () => {
    const deal = evidence("ev-1", {
      compartments: ["people", "deal:alder", "source:acct-tomas"],
      readers: ["m-tomas"],
    });
    expect(await labelOf({ own, readSet: [read(own)] })).toEqual({
      compartments: ["people", "source:acct-tomas"],
      readers: ["m-ines", "m-tomas"],
    });
    expect(await labelOf({ own, readSet: [read(own), read(deal)] })).toEqual({
      compartments: ["deal:alder", "people", "source:acct-tomas"],
      readers: ["m-tomas"],
    });
  });

  it("special_category adds the configured compartment and nothing else", async () => {
    const readSet = [read(own), read(shared)];
    const base = await labelOf({ own, readSet });
    const special = await labelOf({ own, readSet, narrowing: "special_category" });
    expect(base).toEqual({ compartments: ["org", "people", "source:acct-tomas"], readers: ["m-ines", "m-tomas"] });
    expect(special).toEqual({
      compartments: ["org", "people", "source:acct-tomas", config.specialCategoryCompartment],
      readers: ["m-ines", "m-tomas"],
    });
  });

  // The members ingest recorded on an item when it wrote it.
  const withMembers = (item: PipelineItem, members: string[]): PipelineItem => ({
    ...item,
    participantMembers: members as MemberId[],
  });

  it("participants_only keeps only the members the item itself carries", async () => {
    const on = withMembers(own, ["m-tomas", "m-finn"]);
    const readSet = [read(on), read(shared)];
    const base = await labelOf({ own: on, readSet });
    const narrowed = await labelOf({ own: on, readSet, narrowing: "participants_only" });
    expect(narrowed).toEqual({ compartments: ["org", "people", "source:acct-tomas"], readers: ["m-tomas"] });
    expect(narrowed !== undefined && base !== undefined && isAtLeastAsStrict(narrowed, base)).toBe(true);

    // A message open to every member shrinks to the people on it.
    const open = withMembers(evidence("ev-2", { readers: ["all_members"] }), ["m-tomas", "m-finn"]);
    expect((await labelOf({ own: open, readSet: [read(open)], narrowing: "participants_only" }))?.readers).toEqual([
      "m-finn",
      "m-tomas",
    ]);
    // The members are the item's own, never those of a reply read with it.
    const reply = withMembers(shared, ["m-ines"]);
    expect(
      (await labelOf({ own: on, readSet: [read(on), read(reply)], narrowing: "participants_only" }))?.readers,
    ).toEqual(["m-tomas"]);
  });

  it("participants_only on an item that carries no members leaves a claim nobody can read, never the label unchanged", async () => {
    expect((await labelOf({ own, readSet: [read(own)], narrowing: "participants_only" }))?.readers).toEqual([]);
    const none = withMembers(own, []);
    expect((await labelOf({ own: none, readSet: [read(none)], narrowing: "participants_only" }))?.readers).toEqual([]);
  });

  it("a quarantine flag yields no claim", async () => {
    expect(await one({}, { narrowing: "quarantine" })).toEqual({ claims: [], unmapped: [], reviews: [] });
  });

  it("emits nothing for an unlabelled read item", async () => {
    const unverified = { item: evidence("ev-1"), label: { compartments: ["org"], readers: [] } };
    const { run, people } = await setup({ readSet: [read(evidence("ev-2")), unverified] });
    expect(((await failure(run([candidate()]))) as PipelineError).code).toBe("label_invalid");
    expect(people.asked).toEqual([]);
    for (const bad of [evidence("ev-1", { signature: "sig:forged" }), evidence("ev-1", { vault: "public" })]) {
      expect(() => read(bad)).toThrow(PipelineError);
    }
  });
});
