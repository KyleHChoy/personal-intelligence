import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId, OwnerListId, RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { testId } from "../test-support/clients.ts";
import { type Message, seedCommitments, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// An erasure reaches the owner's decisions that have no target row. Erasing a person taints the
// owner's tier ruling's decision about them and its lift, the list membership's decision and its
// removal, and the close of a commitment owed to them; the same decisions about someone else stay.
// Through the Admin as pi_admin, over the synthetic world.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];

const req = (): { requestId: string } => ({ requestId: testId("req").slice(4) });

describe("an erasure reaches target-less decisions", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("erasing a person taints the owner's tier, list and commitment-close decisions about them, and nobody else's", async () => {
    const store = await openStore({ now: WORLD_NOW });
    const dir = await mkdtemp(join(tmpdir(), "pi-la0-"));
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
      recordEnabled: true,
    });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const owner = world.ownerEntity();
      const blake = world.entityOf(WORLD.both.address) as EntityId;
      const pat = world.entityOf(WORLD.ownOnly.address) as EntityId;
      // Each commitment on a message the other person is not on, so blake's erasure removes no
      // claim of pat's.
      const messages = await worldMessages(store);
      const onlyWith = async (person: string, other: string): Promise<Message> => {
        const ids = await queryAs<{ evidence_id: string }>(
          store.db.urls.admin,
          `select distinct i.evidence_id from knowledge.interaction_log i where i.entity_id = $1
             and not exists (select 1 from knowledge.interaction_log o where o.evidence_id = i.evidence_id and o.entity_id = $2)`,
          [person, other],
        );
        const found = messages.find(
          (one) => ids.some((row) => row.evidence_id === one.evidenceId) && one.compartment === "own",
        );
        if (found === undefined) throw new Error("no message with one person alone");
        return found;
      };
      const seeded = await seedCommitments(
        store,
        owner,
        [
          {
            key: "la0-blake",
            subject: owner,
            counterparty: blake,
            due: "2026-03-20",
            claims: [{ message: await onlyWith(blake, pat), what: "canary-la0-blake" }],
          },
          {
            key: "la0-pat",
            subject: owner,
            counterparty: pat,
            due: "2026-03-20",
            claims: [{ message: await onlyWith(pat, blake), what: "canary-la0-pat" }],
          },
        ],
        [OWN, WIDE],
      );
      const fact = (key: string): string => seeded.get(key)?.fact ?? "";

      const list = (await admin.lists.createList("canary-la0-list", req())) as OwnerListId;
      const decided: Record<string, RulingId> = {};
      for (const [name, person] of [
        ["blake", blake],
        ["pat", pat],
      ] as const) {
        decided[`${name}-tier`] = await admin.tiers.setTier(person, "close", req());
        decided[`${name}-tier-again`] = await admin.tiers.setTier(person, "inner", req());
        decided[`${name}-list`] = await admin.lists.addToList(list, person, req());
        decided[`${name}-close`] = (
          await admin.commitments.closeCommitment(fact(`la0-${name}`), "done", req())
        ).decision;
      }
      const lift = req();
      expect(await admin.tiers.clearTier(blake, lift)).toBe(true);
      const remove = req();
      expect(await admin.lists.removeFromList(list, blake, remove)).toBe(true);
      const [blakeLift] = await queryAs<{ id: RulingId }>(
        store.db.urls.admin,
        "select id from knowledge.owner_decisions where request_id = $1",
        [lift.requestId],
      );
      const [blakeRemove] = await queryAs<{ id: RulingId }>(
        store.db.urls.admin,
        "select id from knowledge.owner_decisions where request_id = $1",
        [remove.requestId],
      );
      decided["blake-tier-lift"] = blakeLift!.id;
      decided["blake-list-remove"] = blakeRemove!.id;

      // Each records what it acts on: the person's fingerprints, or the commitment's fact key.
      const subjects = async () =>
        new Map(
          (
            await queryAs<{ id: string; subject_fps: string[]; tainted: boolean; body: boolean }>(
              store.db.urls.admin,
              "select id, subject_fps, tainted_at is not null as tainted, body_enc is not null as body from knowledge.owner_decisions where id = any($1)",
              [Object.values(decided)],
            )
          ).map((row) => [row.id, row]),
        );
      const fpsOf = async (person: string) =>
        (
          await queryAs<{ value_fp: string }>(
            store.db.urls.admin,
            "select distinct value_fp from knowledge.accounts where entity_id = $1 order by value_fp",
            [person],
          )
        ).map((row) => row.value_fp);
      const blakeFps = await fpsOf(blake);
      const before = await subjects();
      for (const key of ["blake-tier", "blake-tier-again", "blake-list", "blake-tier-lift", "blake-list-remove"]) {
        expect(before.get(decided[key]!)?.subject_fps, key).toEqual(expect.arrayContaining(blakeFps));
      }
      expect(before.get(decided["blake-close"]!)?.subject_fps).toEqual([fact("la0-blake")]);
      expect([...before.values()].every((row) => !row.tainted)).toBe(true);

      // A dry run counts them and taints nothing.
      const dry = await admin.erasure.erasePerson(blake, { requestId: req().requestId, dryRun: true });
      expect(dry.more.subject_decisions).toBe(6);
      expect([...(await subjects()).values()].every((row) => !row.tainted)).toBe(true);

      const report = await admin.erasure.erasePerson(blake, req());
      expect(report.more.subject_decisions).toBe(6);
      const after = await subjects();
      for (const [key, id] of Object.entries(decided)) {
        const mine = key.startsWith("blake-");
        expect(after.get(id)?.tainted, key).toBe(mine);
        // A tainted decision keeps no erased fingerprint; the others keep theirs.
        expect(after.get(id)?.subject_fps.length === 0, key).toBe(mine);
      }
      expect(
        await queryAs(
          store.db.urls.admin,
          "select count(*)::int as n from knowledge.owner_decisions where subject_fps && $1::text[]",
          [blakeFps],
        ),
      ).toEqual([{ n: 0 }]);
      // The owner's close of the erased commitment is listed removed; pat's stays in force.
      const closes = await admin.commitments.listCloses();
      expect(closes.find((row) => row.close === decided["blake-close"])?.state).toBe("removed");
      expect(closes.find((row) => row.close === decided["pat-close"])?.state).toBe("in_force");
      // A replay's second run taints nothing more.
      expect(
        one(
          await queryAs<{ n: number }>(
            store.db.urls.admin,
            "select ledger.taint_subject_decisions($1::text[], $2::text[], '{}'::text[], false) as n",
            [blakeFps, [fact("la0-blake")]],
          ),
        ).n,
      ).toBe(0);
      // Pat's commitment keeps its claims, so its fact key alone taints nothing.
      expect(
        one(
          await queryAs<{ n: number }>(
            store.db.urls.admin,
            "select ledger.taint_subject_decisions('{}'::text[], $1::text[], '{}'::text[], false) as n",
            [[fact("la0-pat")]],
          ),
        ).n,
      ).toBe(0);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function one<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  return rows[0] as T;
}
