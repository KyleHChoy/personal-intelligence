import type { ClaimCandidate, LocalEntityId } from "@intelligence/contracts";
import type { OpenedItem } from "@intelligence/contracts/personal";
import type { Parsed } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { fileable } from "./mentions.ts";
import { processItem } from "./process-item.ts";
import { keyFingerprintOf } from "./test-support/memory-store.ts";
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
const mentionsOf = (s: Setup, gmailId: string) =>
  s.store.mentions().filter((one) => one.evidenceId === s.store.evidenceIdOf(gmailId));
// What is filed of each: its name, type and field.
const filedOf = (s: Setup, gmailId: string) =>
  mentionsOf(s, gmailId).map(({ name, type, field }) => ({ name, type, field }));
const textOf = (s: Setup, gmailId: string): string =>
  s.w.accounts[0]?.messages.find((one) => one.id === gmailId)?.text?.replaceAll("\r\n", "\n") ?? "";

// The opened item's port, binding one name to one entity as the owner's binding would.
const bound =
  (name: string, entity: LocalEntityId) =>
  (opened: OpenedItem): OpenedItem => ({
    ...opened,
    context: {
      ...opened.context,
      identity: {
        resolve: (mention, ...rest) =>
          mention.key.kind === "name" && mention.key.value === name
            ? Promise.resolve({ outcome: "linked", entity, epoch: 0 })
            : opened.context.identity.resolve(mention, ...rest),
      },
    },
    kindOf: (one) => (one === entity ? "person" : opened.kindOf(one)),
  });

describe("filing", () => {
  it("a name mention resolves nobody and is filed", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 0, unresolved: 1 });
    expect(recordsOf(s, id)).toEqual([]);
    expect(unmappedOf(s, id)).toEqual([]);
    expect(filedOf(s, id)).toEqual([{ name: "Bryn Calder", type: "role", field: "subject" }]);
  });

  it("a name mention whose name is not in the cited segment is not filed", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const output = outputOf(s, id);
    (output.claims[0] as Candidate).subject.key.value = "Rowan Pike";
    answering(s, { [id]: output });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unresolved: 1 });
    expect(mentionsOf(s, id)).toEqual([]);
  });

  it("a name in an entity field is filed under that field's name", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const output = outputOf(s, id);
    const text = textOf(s, id).trimEnd();
    const sender = {
      key: { kind: "address", value: "hollis.grey@larch.test" },
      observedAt: (output.claims[0] as Candidate).subject.observedAt,
    };
    output.claims = [
      {
        type: "relationship",
        subject: sender,
        fields: {
          counterparty: { key: { kind: "name", value: "Bryn Calder" }, observedAt: sender.observedAt },
          relation: "colleague",
        },
        statementKind: "stated_fact",
        basis: "explicit_self",
        span: `chars:0-${text.length}`,
      },
    ];
    answering(s, { [id]: output });
    await processOne(s, id);
    expect(filedOf(s, id)).toEqual([{ name: "Bryn Calder", type: "relationship", field: "counterparty" }]);
  });

  it("a name the owner bound resolves to that person: a claim, and nothing filed", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const entity = "ent_01JABCDEFGHJKMNPQRSTVWXYZ0" as LocalEntityId;
    changed(s, id, () => {}, bound("Bryn Calder", entity));
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 1, unresolved: 0 });
    expect(recordsOf(s, id).map((one) => one.claim.content.subject)).toEqual([entity]);
    expect(mentionsOf(s, id)).toEqual([]);
  });

  it("a retried item's filed mentions are replaced, not added", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const due = await dueOf(s.store, id);
    await processItem(due, s.deps);
    await processItem(due, s.deps);
    expect(mentionsOf(s, id)).toHaveLength(1);
    // And a later answer with no name mention files none: the text is changed, so the saved
    // answer is not replayed and the model is asked again.
    const output = outputOf(s, id);
    output.claims = [];
    answering(s, { [id]: output });
    changed(s, id, (message) => {
      message.text = "Bryn Calder is our new audit lead.\r\nThanks.\r\n";
    });
    await processItem(due, s.deps);
    expect(mentionsOf(s, id)).toEqual([]);
  });

  it("an item files at most 200 mentions, the commit's cap, and still commits", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const output = outputOf(s, id);
    const one = output.claims[0] as Candidate;
    output.claims = Array.from({ length: 201 }, () => structuredClone(one));
    answering(s, { [id]: output });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0 });
    expect(mentionsOf(s, id)).toHaveLength(200);
  });

  it("a candidate the check refuses before resolving is not filed, though another of the same name is", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const output = outputOf(s, id);
    const good = output.claims[0] as Candidate;
    // A field the type does not declare: bad_fields, refused before any mention is resolved.
    output.claims = [good, { ...structuredClone(good), fields: { ...good.fields, salary: "high" } }];
    answering(s, { [id]: output });
    await processOne(s, id);
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["bad_fields"]);
    expect(mentionsOf(s, id)).toHaveLength(1);
  });

  // The split-name fix: "Mira Okafor" written as two people would file two names for one person.
  describe("a name grounds to a whole name, never to part of one", () => {
    const SEGMENT = "Mira Okafor and Teo will send the deck.";
    const run = async (subject: string, counterparty?: string) => {
      const s = await setup();
      const id = s.w.handles.nameMentionMessageId;
      const output = outputOf(s, id);
      const observedAt = (output.claims[0] as Candidate).subject.observedAt;
      const other =
        counterparty === undefined
          ? { kind: "address", value: "hollis.grey@larch.test" }
          : { kind: "name", value: counterparty };
      output.claims = [
        {
          type: "relationship",
          subject: { key: { kind: "name", value: subject }, observedAt },
          fields: { counterparty: { key: other, observedAt }, relation: "colleague" },
          statementKind: "stated_fact",
          basis: "third_party",
          span: `chars:0-${SEGMENT.length}`,
        },
      ];
      answering(s, { [id]: output });
      changed(s, id, (message) => {
        message.text = `${SEGMENT}\r\n`;
      });
      return { s, id, outcome: await processOne(s, id) };
    };

    it("a first name and a last name of one person are refused as ungrounded_mention, and nothing is filed", async () => {
      const { s, id, outcome } = await run("Mira", "Okafor");
      expect(outcome).toMatchObject({ status: "done", claims: 0, unmapped: 1, unresolved: 0 });
      expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["ungrounded_mention"]);
      expect(mentionsOf(s, id)).toEqual([]);
    });

    it("a part of a name is refused even when the owner bound it: no claim", async () => {
      const s = await setup();
      const id = s.w.handles.nameMentionMessageId;
      const output = outputOf(s, id);
      (output.claims[0] as Candidate).subject.key.value = "Bryn";
      answering(s, { [id]: output });
      changed(s, id, () => {}, bound("Bryn", "ent_01JABCDEFGHJKMNPQRSTVWXYZ0" as LocalEntityId));
      expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
      expect(recordsOf(s, id)).toEqual([]);
      expect(mentionsOf(s, id)).toEqual([]);
    });

    it("the whole name is filed once", async () => {
      const { s, id, outcome } = await run("Mira Okafor");
      expect(outcome).toMatchObject({ status: "done", claims: 0, unmapped: 0, unresolved: 1 });
      expect(filedOf(s, id)).toEqual([{ name: "Mira Okafor", type: "relationship", field: "subject" }]);
    });
  });

  it("an address or domain mention that resolves nobody is never filed", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const output = outputOf(s, id);
    (output.claims[0] as Candidate).subject.key = { kind: "address", value: "nobody@larch.test" };
    answering(s, { [id]: output });
    await processOne(s, id);
    expect(mentionsOf(s, id)).toEqual([]);
  });
});

describe("a filing's speaker", () => {
  const SENDER = "hollis.grey@larch.test";
  const BRYN = "Bryn Calder";
  // `said`, the message's text in place of its own: an address the subject names must stand in it.
  const relationFrom = async (subject: { kind: string; value: string }, said?: string) => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const output = outputOf(s, id);
    const observedAt = (output.claims[0] as Candidate).subject.observedAt;
    if (said !== undefined)
      changed(s, id, (message) => {
        message.text = `${said}\r\n`;
      });
    const text = said ?? textOf(s, id).trimEnd();
    output.claims = [
      {
        type: "relationship",
        subject: { key: subject, observedAt },
        fields: { counterparty: { key: { kind: "name", value: BRYN }, observedAt }, relation: "colleague" },
        statementKind: "stated_fact",
        basis: "third_party",
        span: `chars:0-${text.length}`,
      },
    ];
    answering(s, { [id]: output });
    await processOne(s, id);
    return mentionsOf(s, id).map(({ evidenceId: _, ...one }) => one);
  };

  it("a mail candidate whose subject is the segment author files firstHand true", async () => {
    // The author's address in another case is the same address.
    expect(await relationFrom({ kind: "address", value: SENDER.toUpperCase() })).toEqual([
      {
        name: BRYN,
        type: "relationship",
        field: "counterparty",
        firstHand: true,
        subjectFp: keyFingerprintOf({ kind: "address", value: SENDER }),
        speakerFp: keyFingerprintOf({ kind: "address", value: SENDER }),
      },
    ]);
  });

  it("one about another person files firstHand false, its speaker still the author", async () => {
    const other = "rowan.pike@larch.test";
    expect(await relationFrom({ kind: "address", value: other }, `${BRYN} works with ${other} now.`)).toEqual([
      {
        name: BRYN,
        type: "relationship",
        field: "counterparty",
        firstHand: false,
        subjectFp: keyFingerprintOf({ kind: "address", value: other }),
        speakerFp: keyFingerprintOf({ kind: "address", value: SENDER }),
      },
    ]);
  });

  it("a name subject files its name's fingerprint and is not first-hand", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    await processOne(s, id);
    expect(mentionsOf(s, id).map(({ evidenceId: _, ...one }) => one)).toEqual([
      {
        name: BRYN,
        type: "role",
        field: "subject",
        firstHand: false,
        subjectFp: keyFingerprintOf({ kind: "name", value: BRYN }),
        speakerFp: keyFingerprintOf({ kind: "address", value: SENDER }),
      },
    ]);
  });

  it("an agent finding files firstHand false and no speakerFp", () => {
    const text = `${BRYN} works with Hollis Grey.`;
    const parsed = {
      evidenceId: "e".repeat(64),
      revision: 0,
      sourceKind: "agent_record",
      replyChainEvidenceIds: [],
      automated: false,
      segments: [{ span: `chars:0-${text.length}`, quoted: false, text }],
      headers: {},
      unreadAttachments: 0,
      texts: { "": text },
    } as unknown as Parsed;
    const at = "2026-09-01T09:00:00.000Z";
    // Its subject an address the finding names: a finding's lines are still nobody's.
    const candidate = {
      type: "relationship",
      subject: { key: { kind: "address", value: SENDER }, observedAt: at },
      fields: { counterparty: { key: { kind: "name", value: BRYN }, observedAt: at }, relation: "colleague" },
      statementKind: "stated_fact",
      basis: "third_party",
      span: `chars:0-${text.length}`,
    } as unknown as ClaimCandidate;
    expect(fileable([candidate], parsed, new Set([BRYN]), { document: true, fingerprint: keyFingerprintOf })).toEqual([
      {
        name: BRYN,
        type: "relationship",
        field: "counterparty",
        firstHand: false,
        subjectFp: keyFingerprintOf({ kind: "address", value: SENDER }),
      },
    ]);
  });
});
