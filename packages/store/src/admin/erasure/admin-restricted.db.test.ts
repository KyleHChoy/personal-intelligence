import { describe, expect, it } from "vitest";
import { connect } from "../../test-support/cast.ts";
import { testId } from "../../test-support/clients.ts";
import { asTablesOwner, one } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { stored } from "../../test-support/pipeline-fixtures.ts";
import { openStore } from "../../test-support/store.ts";
import { refusedWith } from "../../test-support/values.ts";

// The restricted items' owner side in the store: a category turned on, and the counts `pi restricted list`
// prints. Counts and category names only.

const TIMEOUT = 180_000;
const RESTRICTED = ["own", "restricted:health"];

describe("the admin: restricted categories", { timeout: TIMEOUT }, () => {
  it("restricted list prints counts and no content", async () => {
    const store = await openStore();
    try {
      const { admin, db, writer } = store;
      const accounts = await connect(writer);
      const item = await stored(writer, accounts.personalMail, MAIL.canary);
      const other = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      // Nothing is on: no line.
      expect(await admin.restricted.counts()).toEqual([]);

      await admin.restricted.addRestrictedCategory("money");
      await admin.restricted.addRestrictedCategory("health");
      // A second add of the same category writes nothing.
      await admin.restricted.addRestrictedCategory("health");
      expect(
        await queryAs(db.urls.admin, "select category from policy.restricted_categories order by category"),
      ).toEqual([{ category: "health" }, { category: "money" }]);

      // health on one item, by its evidence row, as the table's owner (no runtime role updates a
      // label); a pending request for it on the other; one of money's lifts.
      await asTablesOwner(db, ["vault.evidence_items"], (query) =>
        query("update vault.evidence_items set compartments = $2 where id = $1", [item, RESTRICTED]),
      );
      await queryAs(
        db.urls.admin,
        "insert into vault.restriction_requests (id, evidence_id, kind, category, requested_by, compartments) values ($1, $2, 'restrict', 'health', 'jev', '{own}')",
        [testId("rrq"), other],
      );
      const ruling = testId("rul");
      await queryAs(
        db.urls.admin,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, 'restriction_lift', 0, now(), '{own}')",
        [ruling, `lift-${ruling.slice(4, 20)}`],
      );
      const source = one(
        await queryAs<{ fp: string }>(
          db.urls.admin,
          "select source_item_fp as fp from vault.evidence_items where id = $1",
          [other],
        ),
      ).fp;
      await queryAs(
        db.urls.admin,
        "insert into vault.restriction_lifts (account_id, source_item_fp, category, ruling_id, compartments) values ($1, $2, 'money', $3, '{own}')",
        [accounts.personalMail.id, source, ruling],
      );

      const counts = await admin.restricted.counts();
      expect(counts).toEqual([
        { category: "health", items: 1, pending: 1, lifts: 0 },
        { category: "money", items: 0, pending: 0, lifts: 1 },
      ]);
      // Nothing of the items is in it: ids, fingerprints and labels included.
      const text = JSON.stringify(counts);
      for (const value of [item, other, source, ruling, "restricted:", "own"]) expect(text).not.toContain(value);
      // A name that is no category is refused before any statement.
      expect(await refusedWith(() => admin.restricted.addRestrictedCategory("other" as never))).toEqual({
        name: "AdminError",
        code: "invalid_argument",
      });
      expect(await queryAs(db.urls.admin, "select count(*)::int as n from policy.restricted_categories")).toEqual([
        { n: 2 },
      ]);
    } finally {
      await store.close();
    }
  });
});
