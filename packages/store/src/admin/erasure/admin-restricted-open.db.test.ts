import { describe, expect, it } from "vitest";
import type { Keys } from "../../core/keys.ts";
import { openedUnder } from "../../core/tx.ts";
import { connect, OWNER, type Who } from "../../test-support/cast.ts";
import { fingerprint, queryAs, type TestDatabase } from "../../test-support/database.ts";
import { ingestMail, mail, mailSourceId } from "../../test-support/items.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { withStore } from "../../test-support/store.ts";
import { type Admin, createAdmin } from "../admin.ts";

// The restricted spec's "one label everywhere" at the owner's commands: pi extract review, status and pi
// inspect open and seal a restricted item's values under its row's whole label, so nothing they write
// opens with the general file alone, and with the general file alone they open nothing of it.

const TIMEOUT = 120_000;
const HEALTH = ["own", "restricted:health"];
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const CLINIC: Who = { address: "rhea.moss@clinic-example.test", name: "Rhea Moss" };

const generalOnly = (keys: Keys): Keys => ({
  compartments: new Map([...keys.compartments].filter(([name]) => !name.startsWith("restricted:"))),
  fingerprintKey: keys.fingerprintKey,
});

async function withAdmin<T>(db: TestDatabase, keys: Keys, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const admin = createAdmin({ url: db.urls.admin, keys, log: recordingLogger().log });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

const restricted = mail({
  id: "gm-o5-open",
  threadId: "thread-gm-o5-open",
  at: "2026-09-02T09:00:00Z",
  from: CLINIC,
  to: [ME],
  subject: "Your lab results",
  labels: ["INBOX"],
  text: "Ready.",
  restricted: ["health"],
});

describe("the owner's commands under the whole label", { timeout: TIMEOUT }, () => {
  it("pi extract review seals a restricted item's verdict under its whole label, and status opens it with both files and not with the general file alone", () =>
    withStore(
      async ({ db, writer }) => {
        const accounts = await connect(writer);
        await ingestMail(writer, accounts.personalMail, restricted);
        const [item] = await queryAs<{ id: string }>(
          db.urls.admin,
          "select id from vault.evidence_items where source_item_fp = $1",
          [fingerprint(db.keys, "source_id", mailSourceId(restricted))],
        );
        await withAdmin(db, db.keys, (admin) =>
          admin.extraction.recordReview([{ evidenceId: item?.id ?? "", type: "commitment", verdict: "missed" }]),
        );
        const [review] = await queryAs<{ id: string; compartments: string[]; facts_enc: unknown }>(
          db.urls.admin,
          "select id, compartments, facts_enc from vault.extraction_reviews",
        );
        if (review === undefined) throw new Error("no review");
        const at = { table: "vault.extraction_reviews", id: review.id, column: "facts_enc" };
        expect(review.compartments).toEqual(HEALTH);
        expect(JSON.parse(openedUnder(db.keys, review.compartments, at, review.facts_enc))).toMatchObject({
          type: "commitment",
          verdict: "missed",
        });
        expect(() => openedUnder(generalOnly(db.keys), review.compartments, at, review.facts_enc)).toThrow(
          expect.objectContaining({ code: "open_failed" }),
        );
        expect(() => openedUnder(db.keys, ["own"], at, review.facts_enc)).toThrow(
          expect.objectContaining({ code: "open_failed" }),
        );
        // Status tallies it with both files; with the general file alone it cannot open it.
        const status = await withAdmin(db, db.keys, (admin) => admin.extraction.status({ generation: 1 }));
        expect(status.reviews).toEqual([expect.objectContaining({ type: "commitment", verdict: "missed", count: 1 })]);
        await expect(
          withAdmin(db, generalOnly(db.keys), (admin) => admin.extraction.status({ generation: 1 })),
        ).rejects.toMatchObject({ code: "open_failed" });
      },
      { restricted: ["health"] },
    ));

  it("pi inspect opens a restricted sender's rows under their whole label and names it, and the general file alone opens none", () =>
    withStore(
      async ({ db, writer }) => {
        const accounts = await connect(writer);
        await ingestMail(writer, accounts.personalMail, restricted);
        const view = await withAdmin(db, db.keys, (admin) => admin.accounts.inspect(CLINIC.address));
        expect(view?.names).toEqual([{ value: CLINIC.name, compartment: "own,restricted:health" }]);
        expect(view?.addresses).toEqual(
          expect.arrayContaining([{ value: CLINIC.address, compartment: "own,restricted:health" }]),
        );
        expect(view?.interactions.map((one) => one.compartment)).toEqual(["own,restricted:health"]);
        await expect(
          withAdmin(db, generalOnly(db.keys), (admin) => admin.accounts.inspect(CLINIC.address)),
        ).rejects.toMatchObject({ code: "open_failed" });
      },
      { restricted: ["health"] },
    ));
});
