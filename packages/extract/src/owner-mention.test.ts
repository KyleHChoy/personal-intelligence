import { describe, expect, it } from "vitest";
import { findingGrounding, personalGrounding } from "./check.ts";
import { ownerInFields } from "./mentions.ts";

// An agent's finding names the owner by `owner:this`, grounded by the names and addresses code holds
// and by nothing a model wrote. Synthetic values only.
const OWNER = { names: ["Avery Quinn", "Avery Q Example"], addresses: ["avery@quinn.test"] };
const mention = (value: string) =>
  ({ key: { kind: "source_id", value }, observedAt: "2026-03-01T00:00:00.000Z" }) as never;
const segment = (text: string) => ({ span: "chars:0-1", text, quoted: false }) as never;
const grounded = (
  text: string,
  value = "owner:this",
  owner: typeof OWNER | { names: string[]; addresses: string[] } = OWNER,
) => findingGrounding(owner)(mention(value), segment(text));

describe("owner:this", () => {
  it("grounds on a whole name, a first name standing alone, or an address the finding holds", () => {
    expect(grounded("Avery Quinn will order the firebricks.")).toBe(true);
    expect(grounded("Avery will order the firebricks.")).toBe(true);
    expect(grounded("Send it to avery@quinn.test on Monday.")).toBe(true);
    expect(grounded("AVERY QUINN will order the firebricks.")).toBe(true);
  });

  it("does not ground on a finding that names nobody, the word owner, or another person's name", () => {
    expect(grounded("Someone will order the firebricks.")).toBe(false);
    expect(grounded("The owner will order the firebricks.")).toBe(false);
    expect(grounded("Avery Stone will order the firebricks.")).toBe(false);
    expect(grounded("Averyson will order the firebricks.")).toBe(false);
    // A first name that is also a word, or an honorific, never grounds alone; the whole name does.
    const will = { names: ["Will Chen"], addresses: [] };
    expect(grounded("Will will order the firebricks.", "owner:this", will)).toBe(false);
    expect(grounded("The supplier will ship the burners.", "owner:this", will)).toBe(false);
    expect(grounded("Will Chen will order the firebricks.", "owner:this", will)).toBe(true);
    const doctor = { names: ["Dr Chen"], addresses: [] };
    expect(grounded("Dr will order the firebricks.", "owner:this", doctor)).toBe(false);
    expect(grounded("Dr Chen will order the firebricks.", "owner:this", doctor)).toBe(false);
  });

  it("does not ground when code holds no name or address of the owner", () => {
    expect(grounded("Avery Quinn will order the firebricks.", "owner:this", { names: [], addresses: [] })).toBe(false);
  });

  it("in an entity field it needs a full name or an address; a first name leaves it ungrounded, and the subject as it was", () => {
    const candidate = (text: string, who: unknown, subject: unknown) =>
      ({ type: "project.next_step", subject, fields: { what: "x", who }, span: "chars:0-1", _text: text }) as never;
    const parsed = (text: string) =>
      ({ segments: [{ span: "chars:0-1", text, quoted: false, author: undefined }], texts: {}, headers: {} }) as never;
    const owner = mention("owner:this") as { key: { value: string } };
    const project = mention("project:this");
    const whoOf = (text: string): string =>
      (
        ownerInFields([candidate(text, owner, project)], parsed(text), OWNER)[0] as unknown as {
          fields: { who: { key: { value: string } } };
        }
      ).fields.who.key.value;
    expect(whoOf("Avery will order it.")).toBe("partial-name");
    expect(whoOf("Avery Quinn will order it.")).toBe("owner:this");
    expect(whoOf("Ask avery@quinn.test to order it.")).toBe("owner:this");
    const subjectOf = (
      ownerInFields([candidate("Avery will.", project, owner)], parsed("Avery will."), OWNER)[0] as unknown as {
        subject: { key: { value: string } };
      }
    ).subject.key.value;
    expect(subjectOf).toBe("owner:this");
  });

  it("every other lane's hook refuses it, and the finding's hook keeps the others' rules", () => {
    expect(personalGrounding(mention("owner:this"), segment("Avery Quinn will order the firebricks."))).toBe(false);
    expect(grounded("Anything at all.", "project:this")).toBe(true);
    expect(grounded("It was at alder.example.", "domain:alder.example")).toBe(true);
    expect(grounded("Nothing of it.", "domain:alder.example")).toBe(false);
    expect(grounded("Nothing of it.", "partial-name")).toBe(false);
  });
});
