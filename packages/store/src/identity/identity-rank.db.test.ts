import type { Timestamp } from "@intelligence/contracts";
import type { CardId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { ReportRow } from "../admin/cards/admin-calibration.ts";
import { openUnder } from "../core/seal.ts";
import { OWNER } from "../test-support/cast.ts";
import { sha256Hex } from "../test-support/clients.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import { mail } from "../test-support/items.ts";
import type { IdentityDecideModel } from "./identity-sweep.ts";

// The identity ranking on the contacts sweep, with a fake the decide model. Made-up values on
// reserved domains only.

const TIMEOUT = 180_000;
const NOW = new Date("2026-09-15T12:00:00Z");
// A contact's only name: it must reach no request (no contact field is in the state).
const CONTACT_CANARY = "Quillon Vantablack";

type Asked = {
  subject: string;
  pair: { a: { address: string; names: string[] }; b: { address: string; names: string[] } };
  refs: string[];
  compartments: string[];
  mayCall: boolean;
};

// A decide-model that answers by the order it is asked in: each answer a probability, "fail" for a throw.
function fakeDecideModel(
  answers: (number | "fail")[],
  maxCalls = 50,
): { decideModel: IdentityDecideModel; asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    decideModel: {
      maxCalls,
      async ask(pair, mayCall) {
        asked.push({ ...pair, pair: JSON.parse(pair.pair) as Asked["pair"], mayCall });
        const answer = answers[asked.length - 1];
        if (!mayCall || answer === undefined || answer === "fail")
          throw Object.assign(new Error("no_answer"), { code: "model_unavailable" });
        return { p: answer, live: true };
      },
    },
  };
}

// Inbound mail from an address under a display name: a direct interaction and an email alias.
async function wrote(world: IdentityWorld, n: number, address: string, name: string): Promise<void> {
  await world.mail(
    mail({
      id: `gm-rank-${n}`,
      threadId: `thread-rank-${n}`,
      at: `2026-09-0${(n % 8) + 1}T10:00:00Z` as Timestamp,
      from: { address, name },
      to: [{ address: OWNER.personal }],
      subject: "Hello",
      labels: ["INBOX"],
    }),
  );
}

// Three tier 1 pairs (on one contact each, no interaction) and one tier 0 pair (both wrote).
async function world4(world: IdentityWorld): Promise<void> {
  const contacts = world.accounts.personalContacts;
  await world.save(contacts, "zero", {
    names: [CONTACT_CANARY],
    emails: ["z1@identity-rank.test", "z2@identity-rank.example"],
  });
  await wrote(world, 1, "z1@identity-rank.test", "Zia Ostrander");
  await wrote(world, 2, "z2@identity-rank.example", "Z. Ostrander");
  for (const tag of ["b", "c", "d"])
    await world.save(contacts, tag, {
      names: [CONTACT_CANARY],
      emails: [`${tag}1@identity-rank.test`, `${tag}2@identity-rank.example`],
    });
}

// The raised same_person cards, in the order raised, each as its two people's addresses' pair.
async function raisedPairs(world: IdentityWorld, asked: Asked[]): Promise<string[]> {
  const byPeople = new Map<string, string>();
  for (const one of asked)
    byPeople.set(
      [await world.person(one.pair.a.address), await world.person(one.pair.b.address)].sort().join(" "),
      one.subject,
    );
  const cards = await world.sql<{ refs: string[] }>(
    `select array(select b.ref_id from ledger.basis b where b.row_kind = 'card' and b.row_id = c.id order by b.ref_id) as refs
     from ledger.cards c where c.kind = 'same_person' order by c.created_at, c.id`,
  );
  return cards.map((card) => byPeople.get([...card.refs].sort().join(" ")) ?? "unknown");
}

describe("the identity ranking", { timeout: TIMEOUT }, () => {
  it("within a tier, cards are raised by descending probability; a pair with no answer comes after; a tier is never crossed", () =>
    inIdentityWorld(async (world) => {
      await world4(world);
      // Asked in the sweep's order: the tier 0 pair first, then tier 1 in fingerprint order.
      const { decideModel, asked } = fakeDecideModel([0.01, "fail", 0.2, 0.9]);
      expect(await world.admin.identity.proposeIdentity({ now: NOW, decideModel })).toMatchObject({
        candidates: 4,
        raised: 4,
      });
      expect(asked).toHaveLength(4);
      const [zero, failed, low, high] = asked.map((one) => one.subject);
      expect(await raisedPairs(world, asked)).toEqual([zero, high, low, failed]);
    }));

  it("the pair slot holds email aliases, addresses and counts, and no contact field; refs are the two fingerprints and the aliases' evidence", () =>
    inIdentityWorld(async (world) => {
      await world4(world);
      const { decideModel, asked } = fakeDecideModel([0.5, 0.5, 0.5, 0.5]);
      await world.admin.identity.proposeIdentity({ now: NOW, decideModel });
      for (const one of asked) expect(JSON.stringify(one)).not.toContain(CONTACT_CANARY);
      const zero = asked[0];
      if (zero === undefined) throw new Error("nothing asked");
      const sides = [zero.pair.a, zero.pair.b].sort((x, y) => (x.address < y.address ? -1 : 1));
      expect(sides.map((side) => side.address)).toEqual(["z1@identity-rank.test", "z2@identity-rank.example"]);
      expect(sides.map((side) => side.names)).toEqual([["Zia Ostrander"], ["Z. Ostrander"]]);
      expect(zero.pair.a).toMatchObject({ received: 1, sent: 0, meetings: 0, firstSeen: "2026-09" });
      expect(zero.refs.slice(0, 2).sort()).toEqual(
        [world.fp("z1@identity-rank.test"), world.fp("z2@identity-rank.example")].sort(),
      );
      expect(zero.refs).toHaveLength(4);
      expect(zero.compartments).toEqual(["own"]);
      // A tier 1 pair has no interaction: no alias, no months.
      expect(asked[1]?.pair.a).toMatchObject({ names: [], received: 0, firstSeen: null, lastSeen: null });
    }));

  it("at most maxCalls live calls, none after 120 seconds from the first; the rest are asked for a saved answer alone", () =>
    inIdentityWorld(async (world) => {
      await world4(world);
      const capped = fakeDecideModel([0.1, 0.2, 0.3, 0.4], 2);
      await world.admin.identity.proposeIdentity({ now: NOW, decideModel: capped.decideModel });
      expect(capped.asked.map((one) => one.mayCall)).toEqual([true, true, false, false]);
    }));

  it("no live call after the window", () =>
    inIdentityWorld(async (world) => {
      await world4(world);
      const times = [0, 60_000, 121_000, 200_000];
      let tick = 0;
      const late = fakeDecideModel([0.1, 0.2, 0.3, 0.4]);
      await world.admin.identity.proposeIdentity({
        now: NOW,
        decideModel: late.decideModel,
        clock: () => times[Math.min(tick++, times.length - 1)] ?? 0,
      });
      expect(late.asked.map((one) => one.mayCall)).toEqual([true, true, false, false]);
    }));

  it("with identity_rank's rung 1 suspended, Jev is not asked and the order is contacts'", () =>
    inIdentityWorld(async (world) => {
      await world4(world);
      const report: ReportRow = {
        n: 0,
        bands: [],
        precision: null,
        recall: null,
        agreement: null,
        agreement28d: null,
        intervals: {},
        drift: true,
        insufficient: true,
      };
      await world.admin.calibration.suspend(
        "identity_rank",
        1,
        await world.admin.calibration.writeReport("identity_rank", 1, report),
      );
      const { decideModel, asked } = fakeDecideModel([0.9, 0.9, 0.9, 0.9]);
      const ranked = await world.admin.identity.proposeIdentity({ now: NOW, decideModel });
      expect(asked).toEqual([]);
      expect(ranked).toMatchObject({ candidates: 4, raised: 4 });
    }));

  it("an answer to a same_person card writes an identity_rank verdict on the saved call; a batch answer's is not deliberate", () =>
    inIdentityWorld(async (world) => {
      const contacts = world.accounts.personalContacts;
      for (const tag of ["b", "c", "d"])
        await world.save(contacts, tag, {
          names: [CONTACT_CANARY],
          emails: [`${tag}1@identity-rank.test`, `${tag}2@identity-rank.example`],
        });
      const store = world.admin.calibration.decisionCalls();
      const decideModel: IdentityDecideModel = {
        maxCalls: 50,
        async ask(pair) {
          const rawOutput = JSON.stringify({ same_person: 0.7 });
          await store.save({
            key: {
              point: "identity_rank",
              version: 1,
              promptId: "jev_identity",
              promptVersion: "1",
              subject: pair.subject,
              inputHash: sha256Hex(pair.pair),
            },
            rawOutput,
            outputHash: sha256Hex(rawOutput),
            refs: pair.refs,
            compartments: pair.compartments,
            modelId: "typesafe/jev-1.13",
          });
          return { p: 0.7, live: true };
        },
      };
      await world.admin.identity.proposeIdentity({ now: NOW, decideModel });
      const cards = await world.sql<{ id: string }>(
        "select id from ledger.cards where kind = 'same_person' order by created_at, id",
      );
      expect(cards).toHaveLength(3);
      const [single, ...batch] = cards.map((card) => card.id as CardId);
      if (single === undefined) throw new Error("no card");
      await world.admin.cards.decide({ cards: [single], answer: "same", requestId: req() });
      await world.admin.cards.decide({ cards: batch, answer: "different", requestId: req() });
      const rows = await world.sql<{
        id: string;
        call_id: string;
        source: string;
        deliberate: boolean;
        band: number;
        compartments: string[];
        body_enc: unknown;
      }>(
        "select id, call_id, source, deliberate, band, compartments, body_enc from ledger.point_verdicts where point = 'identity_rank' and version = 1 order by deliberate desc, id",
      );
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => [row.source, row.deliberate, row.band])).toEqual([
        ["card", true, 3],
        ["card", false, 3],
        ["card", false, 3],
      ]);
      expect(rows.every((row) => row.call_id.startsWith("dcc_"))).toBe(true);
      const bodies = rows.map(
        (row) =>
          JSON.parse(
            openUnder(
              world.db.keys,
              row.compartments,
              { table: "ledger.point_verdicts", id: row.id, column: "body_enc" },
              row.body_enc as never,
            ),
          ) as unknown,
      );
      expect(bodies).toEqual([
        { verdict: "yes", p: 0.7 },
        { verdict: "no", p: 0.7 },
        { verdict: "no", p: 0.7 },
      ]);
    }));

  it("with no saved call, an answer writes no verdict", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "b", {
        names: [CONTACT_CANARY],
        emails: ["b1@identity-rank.test", "b2@identity-rank.example"],
      });
      await world.admin.identity.proposeIdentity({ now: NOW });
      const [card] = await world.sql<{ id: string }>("select id from ledger.cards where kind = 'same_person'");
      await world.admin.cards.decide({ cards: [card?.id as CardId], answer: "same", requestId: req() });
      expect(await world.count("ledger.point_verdicts")).toBe(0);
    }));
});
