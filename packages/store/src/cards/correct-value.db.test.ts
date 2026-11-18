import { type BeliefClaim, ClaimRecord, CORRECTION_PIPELINE, type FactId } from "@intelligence/contracts/personal";
import {
  BELIEF_RULES,
  type BeliefRule,
  KEY_V2_GENERATION,
  keyVersionOf,
  personalFactKey,
  settle,
} from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { openedUnder } from "../core/tx.ts";
import { CANARY_PERSON } from "../test-support/cast.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { factIdOf, factKeyFpOf, personOf, type RulingStore, withRulings } from "../test-support/ruling-fixtures.ts";

// A correction with the true value. The wrong claim's reject and the owner's owner_command claim
// carrying the value, in one transaction; the owner's claim takes the key its value gives, where a
// source claim of that value joins it, and `settle` ranks it over the claims of its key that state
// something else; a value its field's schema refuses writes nothing; the lift of the reject undoes
// both. Synthetic words only.

const TIMEOUT = 180_000;
const WRONG = "canary-wrong-title harbour master";
const TRUE = "canary-true-title lighthouse keeper";

// A person's role, stated in a stored item, under the fact key `fact-role`.
const role = (evidenceId: string, person: string): ClaimRecord =>
  ({
    ...claimRecord(evidenceId, "own", person, {
      type: "role",
      factKey: "fact-role",
      entities: [person],
      basis: "third_party",
    }),
    subjectKind: "person",
    fieldKinds: { title: "text", organization_name: "text" },
  }) as ClaimRecord;
// The organization's name is the item's own text, which the owner's claim never copies.
const titled = (record: ClaimRecord, title: string): ClaimRecord =>
  ({
    ...record,
    claim: {
      ...record.claim,
      content: { ...record.claim.content, fields: { title, organization_name: "canary-org-name" } },
    },
  }) as ClaimRecord;

const sql = <Row = Record<string, unknown>>(store: RulingStore, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(store.db.urls.admin, text, values);
const counts = async (store: RulingStore) =>
  one(
    await sql<{ decisions: number; items: number; claims: number; rulings: number }>(
      store,
      `select (select count(*)::int from knowledge.owner_decisions) as decisions, (select count(*)::int from vault.evidence_items where source_kind = 'owner_command') as items,
         (select count(*)::int from knowledge.claims) as claims, (select count(*)::int from knowledge.belief_rulings) as rulings`,
    ),
  );
// The claims beliefClaims gives the build for one fact key's fingerprint.
const given = async (store: RulingStore, factKeyFp: string): Promise<BeliefClaim[]> =>
  (await store.pipeline.beliefClaims()).find((group) => group.factKeyFp === factKeyFp)?.claims ?? [];
// The key a role of this title takes at the current key version, as extraction keys it.
const roleKey = (person: string, title: string): string =>
  personalFactKey(
    { type: "role", subject: person as never, fields: { title, organization_name: "canary-org-name" } },
    "",
    ["own"],
    undefined,
    keyVersionOf(KEY_V2_GENERATION),
  );

async function world(store: RulingStore) {
  const { pipeline, writer, accounts, owner } = store;
  const canary = await stored(writer, accounts.personalMail, MAIL.canary);
  const solo = await stored(writer, accounts.personalMail, MAIL.solo);
  const person = await personOf(store, CANARY_PERSON.address, "own");
  const wrong = titled(role(canary, person), WRONG);
  const other = titled(role(solo, person), WRONG);
  // A commitment, which takes no value.
  const lamp = claimRecord(canary, "own", owner, { n: 2, factKey: "fact-lamp" });
  expect(await pipeline.commit(batchOf(canary, [wrong, lamp]))).toBe("committed");
  expect(await pipeline.commit(batchOf(solo, [other]))).toBe("committed");
  return {
    person,
    wrong: factIdOf(store, wrong),
    other: factIdOf(store, other),
    records: { wrong, other },
    lamp: factIdOf(store, lamp),
  };
}

describe("a correction with the true value", { timeout: TIMEOUT }, () => {
  it("one reject and one claim of the owner's in one transaction; settle ranks the owner's claim; the lift undoes both", () =>
    withRulings(async (store) => {
      const { admin } = store;
      const { person, wrong, other, records } = await world(store);
      const before = await counts(store);

      const request = "request-c4-value-000001";
      const ruling = await admin.notes.correctValue(wrong, { title: TRUE }, { requestId: request });
      // A repeated request returns the first ruling and writes nothing more.
      expect(await admin.notes.correctValue(wrong, { title: TRUE }, { requestId: request })).toBe(ruling);
      expect(await counts(store)).toEqual({
        decisions: before.decisions + 1,
        items: before.items + 1,
        claims: before.claims + 1,
        rulings: before.rulings + 1,
      });

      // The owner's claim: an owner_command item's, the wrong claim's type, subject and label, the owner's
      // value, under the key that value gives, not the wrong value's.
      const hisKey = factKeyFpOf(store, roleKey(person, TRUE));
      const claims = await given(store, hisKey);
      const his = claims.find((x) => x.origin === "owner_command");
      expect(claims).toHaveLength(1);
      expect(his?.claim).toMatchObject({
        pipelineVersion: CORRECTION_PIPELINE,
        content: { type: "role", subject: person, fields: { title: TRUE } },
        label: { compartments: ["own"] },
      });
      const hisId = one(
        await sql<{ id: FactId; compartments: string[]; content_enc: unknown; fp: string }>(
          store,
          "select c.id, c.compartments, c.content_enc, c.fact_key_fp as fp from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where e.source_kind = 'owner_command'",
        ),
      );
      const record = ClaimRecord.parse(
        JSON.parse(
          openedUnder(
            store.db.keys,
            hisId.compartments,
            { table: "knowledge.claims", id: hisId.id, column: "content_enc" },
            hisId.content_enc,
          ),
        ),
      );
      expect(record).toMatchObject({ origin: "owner_command", factKey: roleKey(person, TRUE), subjectKind: "person" });
      expect(record.claim.content.fields).toEqual({ title: TRUE });
      expect(hisId.fp).toBe(hisKey);
      expect(
        await sql(store, "select entity_id from knowledge.claim_entities where claim_id = $1", [hisId.id]),
      ).toEqual([{ entity_id: person }]);
      // The wrong claim is given to no build; the other claim of the wrong key still is.
      expect((await given(store, factKeyFpOf(store, "fact-role"))).map((x) => x.claim.id)).toEqual([
        records.other.claim.id,
      ]);
      // The owner's words reach no decision row.
      expect(JSON.stringify(await sql(store, "select * from knowledge.owner_decisions"))).not.toContain(
        "canary-true-title",
      );

      // A later source claim of the owner's value lands on the owner's key and joins their belief; `settle` keeps both.
      const reply = await stored(store.writer, store.accounts.personalMail, MAIL.reply);
      const later = {
        ...titled(role(reply, person), TRUE),
        factKey: roleKey(person, TRUE),
        claim: { ...titled(role(reply, person), TRUE).claim, validFrom: "2027-01-01T09:00:00.000Z" },
      } as ClaimRecord;
      expect(await store.pipeline.commit(batchOf(reply, [later]))).toBe("committed");
      const joined = await given(store, hisKey);
      expect(joined.map((x) => x.claim.id).sort()).toEqual([his?.claim.id, later.claim.id].sort());
      expect(settle(BELIEF_RULES.role as BeliefRule, joined).claims).toHaveLength(2);
      // A later source claim of the wrong value on the owner's key is outranked.
      expect(
        settle(BELIEF_RULES.role as BeliefRule, [
          ...joined,
          {
            ...joined[0],
            origin: "source",
            claim: {
              ...later.claim,
              id: "claim-wrong-later" as never,
              content: { ...later.claim.content, fields: { title: WRONG } },
            },
          } as BeliefClaim,
        ]).claims,
      ).toHaveLength(2);

      // The lift: the reject is lifted and the owner's claim rejected, in one transaction.
      expect(await admin.facts.liftRuling(ruling, { requestId: "request-c4-lift-0000001" })).toBe(true);
      expect((await given(store, factKeyFpOf(store, "fact-role"))).map((x) => x.claim.id).sort()).toEqual(
        [records.wrong.claim.id, records.other.claim.id].sort(),
      );
      expect((await given(store, hisKey)).map((x) => x.claim.id)).toEqual([later.claim.id]);
      expect(await admin.facts.show(other)).not.toBeNull();
      expect(
        await sql(
          store,
          "select verdict, claim_fp, lifted_at is null as standing from knowledge.belief_rulings order by created_at, ruling_id",
        ),
      ).toEqual([
        { verdict: "reject", claim_fp: wrong, standing: false },
        { verdict: "reject", claim_fp: hisId.id, standing: true },
      ]);
    }));

  it("a value its field's schema refuses, or a kind that takes none, writes nothing", () =>
    withRulings(async (store) => {
      const { admin } = store;
      const { wrong, other, lamp } = await world(store);
      const before = await counts(store);
      const bad = [
        { title: "" },
        { title: "   " },
        { role: TRUE },
        { title: TRUE, extra: "x" },
        { title: 7 },
        { title: "a\u0007b" },
        { title: "x".repeat(2001) },
      ];
      for (const [n, value] of bad.entries()) {
        await expect(
          admin.notes.correctValue(wrong, value, { requestId: `request-c4-bad-00000${n}` }),
          JSON.stringify(value).slice(0, 40),
        ).rejects.toMatchObject({ code: "invalid_argument" });
      }
      // A commitment takes no value: its reject stands alone.
      await expect(
        admin.notes.correctValue(lamp, { what: TRUE }, { requestId: "request-c4-none-000001" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        admin.notes.correctValue("0".repeat(64) as FactId, { title: TRUE }, { requestId: "request-c4-none-000002" }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await counts(store)).toEqual(before);
      // A request id first used to reject another claim is refused, not tied to that reject.
      await admin.facts.rejectClaim(other, { requestId: "request-c4-reuse-00001" });
      await expect(
        admin.notes.correctValue(wrong, { title: TRUE }, { requestId: "request-c4-reuse-00001" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect((await counts(store)).items).toBe(before.items);
    }));

  // The owner's own role and affiliation take the owner's value too, in the same fields a
  // person's do; an affiliation's relation only from its list.
  it("the owner's own role's title and affiliation's relation each take the owner's value", () =>
    withRulings(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const titledMine = titled(role(canary, owner), WRONG);
      const mine = {
        ...titledMine,
        subjectKind: "owner",
        claim: { ...titledMine.claim, basis: "explicit_self" },
      } as ClaimRecord;
      const base = claimRecord(canary, "own", owner, { n: 3, type: "affiliation", factKey: "fact-affiliation" });
      const joined = {
        ...base,
        fieldKinds: { relation: "enum", organization_name: "text" },
        claim: {
          ...base.claim,
          content: { ...base.claim.content, fields: { relation: "member", organization_name: "canary-org-name" } },
        },
      } as ClaimRecord;
      expect(await pipeline.commit(batchOf(canary, [mine, joined]))).toBe("committed");
      const before = await counts(store);

      await expect(
        admin.notes.correctValue(
          factIdOf(store, joined),
          { relation: "not-a-relation" },
          { requestId: "request-0187-bad-000001" },
        ),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect(await counts(store)).toEqual(before);
      await admin.notes.correctValue(factIdOf(store, mine), { title: TRUE }, { requestId: "request-0187-role-00001" });
      await admin.notes.correctValue(
        factIdOf(store, joined),
        { relation: "founder" },
        { requestId: "request-0187-affil-0001" },
      );
      expect(await counts(store)).toEqual({
        decisions: before.decisions + 2,
        items: before.items + 2,
        claims: before.claims + 2,
        rulings: before.rulings + 2,
      });
      const his = await sql<{ id: FactId; compartments: string[]; content_enc: unknown }>(
        store,
        "select c.id, c.compartments, c.content_enc from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where e.source_kind = 'owner_command' order by c.id",
      );
      const records = his.map((row) =>
        ClaimRecord.parse(
          JSON.parse(
            openedUnder(
              store.db.keys,
              row.compartments,
              { table: "knowledge.claims", id: row.id, column: "content_enc" },
              row.content_enc,
            ),
          ),
        ),
      );
      expect(
        records
          .map((record) => [
            record.claim.content.type,
            record.subjectKind,
            record.claim.basis,
            record.claim.content.fields,
          ])
          .sort(),
      ).toEqual([
        ["affiliation", "owner", "explicit_self", { relation: "founder" }],
        ["role", "owner", "explicit_self", { title: TRUE }],
      ]);
    }));

  // A status's organization, process and state are the owner's to correct,
  // all three in one value since the owner's claim keeps no text of the wrong one; a role's organization by
  // name replaces the organization it linked.
  it("a status takes its organization, process and state; a role its organization by name", () =>
    withRulings(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      const base = claimRecord(canary, "own", owner, { n: 4, type: "status", factKey: "fact-status" });
      const status = {
        ...base,
        subjectKind: "owner",
        fieldKinds: { organization_name: "text", process: "text", state: "text", domain: "enum" },
        claim: {
          ...base.claim,
          content: {
            ...base.claim.content,
            fields: {
              organization_name: "canary-org-name",
              process: "canary application",
              state: "canary-wrong-state",
              domain: "education",
            },
          },
        },
      } as ClaimRecord;
      const linked = role(canary, person);
      const atOrg = {
        ...linked,
        fieldKinds: { title: "text", organization: "entity" },
        claim: { ...linked.claim, content: { ...linked.claim.content, fields: { title: WRONG, organization: owner } } },
        factKey: "fact-role-linked",
      } as ClaimRecord;
      expect(await pipeline.commit(batchOf(canary, [status, atOrg]))).toBe("committed");
      const before = await counts(store);

      // Only the state, or a field a status has not: refused, nothing written.
      for (const [n, value] of [
        { state: "canary-true-state" },
        { organization_name: "a", process: "b", state: "c", domain: "health" },
        { organization_name: "a", process: "b", state: "" },
      ].entries()) {
        await expect(
          admin.notes.correctValue(factIdOf(store, status), value, { requestId: `request-r11-bad-0000${n}` }),
          JSON.stringify(value),
        ).rejects.toMatchObject({ code: "invalid_argument" });
      }
      expect(await counts(store)).toEqual(before);

      const truth = { organization_name: "canary-true-org", process: "canary application", state: "canary-true-state" };
      await admin.notes.correctValue(factIdOf(store, status), truth, { requestId: "request-r11-status-0001" });
      await admin.notes.correctValue(
        factIdOf(store, atOrg),
        { title: TRUE, organization_name: "canary-true-org" },
        { requestId: "request-r11-role-000001" },
      );
      expect(await counts(store)).toEqual({
        decisions: before.decisions + 2,
        items: before.items + 2,
        claims: before.claims + 2,
        rulings: before.rulings + 2,
      });
      const his = await sql<{ id: FactId; compartments: string[]; content_enc: unknown }>(
        store,
        "select c.id, c.compartments, c.content_enc from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where e.source_kind = 'owner_command' order by c.id",
      );
      const records = his.map((row) =>
        ClaimRecord.parse(
          JSON.parse(
            openedUnder(
              store.db.keys,
              row.compartments,
              { table: "knowledge.claims", id: row.id, column: "content_enc" },
              row.content_enc,
            ),
          ),
        ),
      );
      expect(records.map((record) => [record.claim.content.type, record.claim.content.fields]).sort()).toEqual([
        ["role", { title: TRUE, organization_name: "canary-true-org" }],
        ["status", truth],
      ]);
    }));
});
