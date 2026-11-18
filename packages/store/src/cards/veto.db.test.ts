import { randomBytes } from "node:crypto";
import { type EntityId, VetoView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newId } from "../core/ids.ts";
import { vetoed } from "../core/queue.ts";
import { addOwnerAddressUnderived, codeOf, one, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, adminRows as rows } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { seedWorld, WORLD } from "../test-support/world.ts";

// The owner's vetoes.

const TIMEOUT = 180_000;
const NOW = new Date("2026-03-10T12:00:00.000Z");

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

// Whether a veto covers the entity, through the veto lookup, as pi_admin.
const covers = (store: TestStore, entity: string, kind?: string): Promise<boolean> =>
  session(store.db.urls.admin, (query) =>
    vetoed(query, { refs: [{ kind: "entity", id: entity as EntityId }], ...(kind === undefined ? {} : { kind }) }),
  );

const withWorld = async (
  fn: (store: TestStore, world: Awaited<ReturnType<typeof seedWorld>>) => Promise<void>,
): Promise<void> => {
  const store = await openStore({ now: NOW });
  try {
    await fn(store, await seedWorld(store.writer, store.admin));
  } finally {
    await store.close();
  }
};

describe("vetoes", { timeout: TIMEOUT }, () => {
  it("a veto holds from its commit until a lift names it", () =>
    withWorld(async (store, world) => {
      const pat = world.entityOf(WORLD.ownOnly.address);
      const blake = world.entityOf(WORLD.both.address);
      expect(await covers(store, pat)).toBe(false);
      const ruling = await store.admin.cards.addVeto({ entity: pat }, { requestId: requestId() });
      expect(ruling).toMatch(/^rul_/);
      expect(await covers(store, pat)).toBe(true);
      // The positive control: it covers no one else.
      expect(await covers(store, blake)).toBe(false);
      expect(await store.admin.cards.liftVeto(ruling, { requestId: requestId() })).toBe(true);
      expect(await covers(store, pat)).toBe(false);
      expect(
        await rows(store, "select kind, supersedes from knowledge.owner_decisions order by decided_at, kind"),
      ).toEqual([
        { kind: "veto", supersedes: null },
        { kind: "veto_lift", supersedes: ruling },
      ]);
    }));

  it("a veto on a person stores each address fingerprint the person has, under both compartments", () =>
    withWorld(async (store, world) => {
      const blake = world.entityOf(WORLD.both.address);
      const ruling = await store.admin.cards.addVeto(
        { entity: blake, kind: "introduction" },
        { requestId: requestId() },
      );
      expect(
        await rows(
          store,
          "select ruling_id, subject, value_fps, work_kind, compartments, lifted_at from knowledge.vetoes",
        ),
      ).toEqual([
        {
          ruling_id: ruling,
          subject: "person",
          value_fps: [fingerprint(store.db.keys, "address", WORLD.both.address)],
          work_kind: "introduction",
          compartments: ["employer:example", "own"],
          lifted_at: null,
        },
      ]);
      expect(
        await rows(store, "select kind, target_kind, target_id, compartments from knowledge.owner_decisions"),
      ).toEqual([{ kind: "veto", target_kind: "entity", target_id: blake, compartments: ["employer:example", "own"] }]);
      // A kind given with the entity narrows it: another kind is not covered.
      expect(await covers(store, blake, "introduction")).toBe(true);
      expect(await covers(store, blake, "follow_up")).toBe(false);
    }));

  it("a veto on an organization stores its domain fingerprints, and one on a kind alone none, under own", () =>
    withWorld(async (store) => {
      const [organization] = await rows<{ entity_id: string }>(
        store,
        "select entity_id from knowledge.domains where domain_fp = $1 limit 1",
        [fingerprint(store.db.keys, "domain", "example.org")],
      );
      const org = await store.admin.cards.addVeto(
        { entity: organization?.entity_id as EntityId },
        { requestId: requestId() },
      );
      const any = await store.admin.cards.addVeto({ kind: "introduction" }, { requestId: requestId() });
      expect(
        await rows(
          store,
          "select ruling_id, subject, value_fps, work_kind, compartments from knowledge.vetoes order by created_at, subject desc",
        ),
      ).toEqual([
        {
          ruling_id: org,
          subject: "organization",
          value_fps: [fingerprint(store.db.keys, "domain", "example.org")],
          work_kind: null,
          compartments: ["employer:example"],
        },
        { ruling_id: any, subject: "any", value_fps: [], work_kind: "introduction", compartments: ["own"] },
      ]);
    }));

  it("a veto on the owner or on an id that does not exist is not_found", () =>
    withWorld(async (store, world) => {
      expect(
        await codeOf(() => store.admin.cards.addVeto({ entity: world.ownerEntity() }, { requestId: requestId() })),
      ).toBe("not_found");
      expect(
        await codeOf(() => store.admin.cards.addVeto({ entity: newId("ent") as EntityId }, { requestId: requestId() })),
      ).toBe("not_found");
      expect(one(await rows<{ n: number }>(store, "select count(*)::int as n from knowledge.owner_decisions")).n).toBe(
        0,
      );
      // The positive control.
      expect(
        await store.admin.cards.addVeto({ entity: world.entityOf(WORLD.ownOnly.address) }, { requestId: requestId() }),
      ).toMatch(/^rul_/);
    }));

  it("lifting twice writes one row", () =>
    withWorld(async (store, world) => {
      const ruling = await store.admin.cards.addVeto(
        { entity: world.entityOf(WORLD.ownOnly.address) },
        { requestId: requestId() },
      );
      expect(await store.admin.cards.liftVeto(ruling, { requestId: requestId() })).toBe(true);
      expect(await store.admin.cards.liftVeto(ruling, { requestId: requestId() })).toBe(false);
      expect(await store.admin.cards.liftVeto(newId("rul") as never, { requestId: requestId() })).toBe(false);
      expect(
        one(
          await rows<{ n: number }>(
            store,
            "select count(*)::int as n from knowledge.owner_decisions where kind = 'veto_lift'",
          ),
        ).n,
      ).toBe(1);
      expect(
        one(await rows<{ lifted: boolean }>(store, "select lift_ruling_id is not null as lifted from knowledge.vetoes"))
          .lifted,
      ).toBe(true);
    }));

  it("a repeated lift returns the first result and writes nothing, and a request id another lift used is refused", () =>
    withWorld(async (store, world) => {
      const first = await store.admin.cards.addVeto(
        { entity: world.entityOf(WORLD.ownOnly.address) },
        { requestId: requestId() },
      );
      const second = await store.admin.cards.addVeto(
        { entity: world.entityOf(WORLD.both.address) },
        { requestId: requestId() },
      );
      const lift = requestId();
      expect(await store.admin.cards.liftVeto(first, { requestId: lift })).toBe(true);
      expect(await store.admin.cards.liftVeto(first, { requestId: lift })).toBe(true);
      expect(await codeOf(() => store.admin.cards.liftVeto(second, { requestId: lift }))).toBe("invalid_argument");
      expect(
        one(
          await rows<{ n: number }>(
            store,
            "select count(*)::int as n from knowledge.owner_decisions where kind = 'veto_lift'",
          ),
        ).n,
      ).toBe(1);
      expect(
        await rows(
          store,
          "select ruling_id, lifted_at is not null as lifted from knowledge.vetoes order by ruling_id = $1 desc",
          [first],
        ),
      ).toEqual([
        { ruling_id: first, lifted: true },
        { ruling_id: second, lifted: false },
      ]);
    }));

  it("the reader and the writer cannot read a veto", () =>
    withWorld(async (store, world) => {
      await store.admin.cards.addVeto({ entity: world.entityOf(WORLD.ownOnly.address) }, { requestId: requestId() });
      expect(await sqlState(() => queryAs(store.db.urls.reader, "select count(*) from knowledge.vetoes"))).toBe(
        "42501",
      );
      expect(await sqlState(() => queryAs(store.db.urls.writer, "select count(*) from knowledge.vetoes"))).toBe(
        "42501",
      );
      // The positive control.
      expect(await rows(store, "select count(*)::int as n from knowledge.vetoes")).toEqual([{ n: 1 }]);
    }));

  it("a veto list shows the entity that holds the address now, and null once the person is gone", () =>
    withWorld(async (store, world) => {
      const pat = world.entityOf(WORLD.ownOnly.address);
      const ruling = await store.admin.cards.addVeto({ entity: pat }, { requestId: requestId() });
      const listed = await store.admin.cards.listVetoes();
      expect(VetoView.array().parse(listed)).toEqual(listed);
      expect(listed).toEqual([{ id: ruling, subject: "person", entity: pat, kind: null, at: NOW.toISOString() }]);

      // Pat's address becomes the owner's, and the re-derive removes Pat.
      await addOwnerAddressUnderived(store.db, WORLD.ownOnly.address, "own");
      expect((await store.writer.rederiveIfNeeded(world.derive)).rederived).toBe(true);
      expect(await store.admin.cards.listVetoes()).toEqual([
        { id: ruling, subject: "person", entity: null, kind: null, at: NOW.toISOString() },
      ]);
    }));
});
