import { randomBytes } from "node:crypto";
import { BoxHealthRow, type CardId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { withDatabase } from "../test-support/store.ts";
import { CARD_STATE } from "./statements.ts";

// A box health card before a client's own token lapses: raised seven days ahead, once for that
// expiry, never for a revoked client or one bound to an OAuth registration, and withdrawn when the
// token is rotated.

const DAY = 24 * 60 * 60_000;
const OWN = ["own"];

async function withAdmin<T>(db: TestDatabase, now: Date, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log, now: () => now });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}
const record = (db: TestDatabase, now: Date) => withAdmin(db, now, (admin) => admin.box.recordCoverage([]));
const tokenCards = async (db: TestDatabase): Promise<{ case_key: string; state: string }[]> =>
  queryAs(
    db.urls.admin,
    `select c.case_key, ${CARD_STATE} as state
     from ledger.cards c where starts_with(c.case_key, 'box:token_expiring:') order by c.created_at, c.id`,
  );
const expiresIn = (db: TestDatabase, name: string, days: number) =>
  queryAs(db.urls.admin, "update policy.clients set expires_at = now() + make_interval(days => $2) where name = $1", [
    name,
    days,
  ]);

describe("a lapsing token's box health card", { timeout: 180_000 }, () => {
  it("is raised a week ahead for an active client, once for that expiry, and withdrawn by a rotation", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const lapsing = await insertClient(db, "lapsing", OWN);
      const fresh = await insertClient(db, "fresh", OWN);
      const retired = await insertClient(db, "retired", OWN);
      const connector = await insertClient(db, "connector", OWN);
      await expiresIn(db, "lapsing", 3);
      await expiresIn(db, "fresh", 8);
      await expiresIn(db, "retired", 3);
      await expiresIn(db, "connector", 3);
      await queryAs(db.urls.admin, "update policy.clients set status = 'revoked', revoked_at = now() where id = $1", [
        retired.id,
      ]);
      await session(db.urls.bootstrap, async (query) => {
        await query("begin");
        await query("set local role pi_owner");
        await query("insert into policy.oauth_registrations (id, redirect_uris, client_id) values ($1, $2, $3)", [
          `oc_${randomBytes(24).toString("base64url")}`,
          ["https://claude.ai/api/mcp/auth_callback"],
          connector.id,
        ]);
        await query("commit");
      });

      await record(db, now);
      expect(await tokenCards(db)).toEqual([{ case_key: `box:token_expiring:client/${lapsing.id}`, state: "pending" }]);
      const status = await withAdmin(db, now, (admin) => admin.accounts.status());
      const open = status.boxHealth.filter((row) => row.kind === "token_expiring");
      expect(open.map((row) => row.about)).toEqual([`client/${lapsing.id}`]);
      expect(BoxHealthRow.array().parse(open)).toEqual(open);

      // Seen by the owner: not raised again for the same expiry.
      await withAdmin(db, now, (admin) =>
        admin.cards.decide({ cards: [open[0]?.card as CardId], answer: "seen", requestId: testId("req").slice(4) }),
      );
      await record(db, new Date(now.getTime() + DAY));
      expect((await tokenCards(db)).map((card) => card.state)).toEqual(["decided"]);

      // The fresh client's token comes within the week; then a rotation withdraws its open card.
      await record(db, new Date(now.getTime() + 2 * DAY));
      expect((await tokenCards(db)).map((card) => card.case_key)).toEqual([
        `box:token_expiring:client/${lapsing.id}`,
        `box:token_expiring:client/${fresh.id}`,
      ]);
      await withAdmin(db, now, (admin) => admin.clients.rotateToken("fresh"));
      await record(db, new Date(now.getTime() + 2 * DAY));
      expect((await tokenCards(db)).map((card) => card.state)).toEqual(["decided", "withdrawn"]);
    }));
});
