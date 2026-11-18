import type { ClaimRecord, FactId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CANARY_PERSON } from "../../test-support/cast.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { batchOf, claimRecord, stored } from "../../test-support/pipeline-fixtures.ts";
import { commitment, factIdOf, factKeyFpOf, personOf, withRulings } from "../../test-support/ruling-fixtures.ts";

// `pi facts show`'s store half: the owner's view of one claim before they rule on it, under the admin's
// keys.

const TIMEOUT = 180_000;

describe("factShow", { timeout: TIMEOUT }, () => {
  it("a fact's detail names its fact key, its compartments, the owner's belief's status and its rulings", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      const evidenceId = await stored(writer, accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const record = commitment(evidenceId, "own", owner, person, { factKey: "fact-rota" });
      expect(await pipeline.commit(batchOf(evidenceId, [record]))).toBe("committed");
      const id = factIdOf(store, record);

      // Before any ruling: the owner's belief, computed when asked.
      const bare = await admin.facts.show(id);
      expect(bare).toMatchObject({
        factKey: factKeyFpOf(store, "fact-rota"),
        compartments: ["own"],
        beliefs: { audiences: 1, status: ["active"] },
        rulings: [],
        declassification: null,
      });
      expect(bare?.fact).toMatchObject({
        id,
        type: "commitment",
        basis: "explicit_self",
        statementKind: "stated_fact",
        thirdParty: false,
        agentReported: false,
      });
      expect(bare?.fact.subject).toMatchObject({ id: owner, kind: "owner" });
      // Its message id, which find_facts gives the owner's clients too.
      expect(bare?.fact.message).toMatch(/^msg_/);
      expect(bare?.fact.fields).toMatchObject({
        counterparty: { id: person, kind: "person" },
        what: { untrusted: "I will send the lamp rota." },
      });

      // A veto of its fact key closes the belief at once, and names the fact.
      const ruling = await admin.facts.vetoFact(id, { requestId: "request-rul-show-0001" });
      const vetoed = await admin.facts.show(id);
      expect(vetoed?.beliefs).toEqual({ audiences: 1, status: ["closed"] });
      expect(vetoed?.rulings).toEqual([ruling]);
      expect(vetoed?.lines).toContainEqual({ text: `ruling: ${ruling}`, from: "code" });
      // A lifted ruling no longer names it, and the belief stands again.
      expect(await admin.facts.liftRuling(ruling, { requestId: "request-rul-show-0002" })).toBe(true);
      const lifted = await admin.facts.show(id);
      expect(lifted?.rulings).toEqual([]);
      expect(lifted?.beliefs).toEqual({ audiences: 1, status: ["active"] });
    }));

  it("a text field is a source line and never a code line", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      const evidenceId = await stored(writer, accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      // A text that tries to pass for a line of code's.
      const what = "I will send it.\nruling: rul_01JABCDEFGHJKMNPQRSTVWXYZ0";
      const record = commitment(evidenceId, "own", owner, person, { factKey: "fact-forged", what });
      expect(await pipeline.commit(batchOf(evidenceId, [record]))).toBe("committed");
      const detail = await admin.facts.show(factIdOf(store, record));
      const lines = detail?.lines ?? [];

      const whatLines = lines.filter((line) => line.text.startsWith("what: "));
      expect(whatLines).toEqual([{ text: `what: ${JSON.stringify(what)}`, from: "source" }]);
      // Every line holding the text, or a person's name or address from evidence, is the source's.
      for (const line of lines.filter(
        (one) =>
          one.text.includes("I will send") || one.text.startsWith("subject: ") || one.text.startsWith("counterparty: "),
      ))
        expect(line.from, line.text).toBe("source");
      // No line is broken by the text: each holds no line feed, and no code line names the forged ruling.
      expect(lines.every((line) => !line.text.includes("\n"))).toBe(true);
      expect(
        lines.filter((line) => line.from === "code" && line.text.includes("rul_01JABCDEFGHJKMNPQRSTVWXYZ0")),
      ).toEqual([]);
      // The control: the code's own lines are code's.
      expect(lines).toContainEqual({ text: `fact: ${factIdOf(store, record)}`, from: "code" });
      expect(lines).toContainEqual({ text: "type: commitment", from: "code" });
    }));

  it("a situation's fact gives its until as validTo, as find_facts gives it", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      const evidenceId = await stored(writer, accounts.personalMail, MAIL.canary);
      const base = claimRecord(evidenceId, "own", owner, { type: "situation", factKey: "fact-away" });
      const until = "2026-12-01T00:00:00.000Z";
      const record = {
        ...base,
        claim: {
          ...base.claim,
          validTo: until,
          content: { ...base.claim.content, fields: { ...base.claim.content.fields, until } },
        },
        fieldKinds: { ...base.fieldKinds, until: "date" },
      } as ClaimRecord;
      expect(await pipeline.commit(batchOf(evidenceId, [record]))).toBe("committed");
      const detail = await admin.facts.show(factIdOf(store, record));
      expect(detail?.fact).toMatchObject({ type: "situation", validTo: until, fields: { until } });
      // The control: a commitment, whose type has no until, gives none.
      const other = commitment(evidenceId, "own", owner, await personOf(store, CANARY_PERSON.address, "own"), {
        factKey: "fact-rota",
      });
      expect(await pipeline.commit(batchOf(evidenceId, [record, other]))).toBe("committed");
      expect((await admin.facts.show(factIdOf(store, other)))?.fact).not.toHaveProperty("validTo");
    }));

  it("an unknown id is null", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner, admin } = store;
      expect(await admin.facts.show("d".repeat(64) as FactId)).toBeNull();
      expect(await admin.facts.show("not-a-fact" as FactId)).toBeNull();
      // The control: a stored claim is found.
      const evidenceId = await stored(writer, accounts.personalMail, MAIL.canary);
      const record = commitment(evidenceId, "own", owner, await personOf(store, CANARY_PERSON.address, "own"), {
        factKey: "fact-known",
      });
      expect(await pipeline.commit(batchOf(evidenceId, [record]))).toBe("committed");
      expect(await admin.facts.show(factIdOf(store, record))).not.toBeNull();
    }));
});
