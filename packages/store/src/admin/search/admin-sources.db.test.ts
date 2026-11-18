import { describe, expect, it } from "vitest";
import { CANARIES, CANARY_PERSON } from "../../test-support/cast.ts";
import { one, session } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { batchOf, stored } from "../../test-support/pipeline-fixtures.ts";
import { commitment, personOf, withRulings } from "../../test-support/ruling-fixtures.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { namedMessages } from "./admin-sources.ts";

// Synthetic mail only.

describe("named messages", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("names a cited message by its subject and its sender, and leaves a held one out", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const person = await personOf(store, CANARY_PERSON.address, "own");
      expect(
        await pipeline.commit(
          batchOf(canary, [commitment(canary, "own", owner, person, { n: 1, factKey: "r6 lamp" })]),
        ),
      ).toBe("committed");
      const message = one(
        await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
          canary,
        ]),
      ).id;

      const named = await session(store.db.urls.admin, (query) =>
        namedMessages({ query, keys: store.db.keys }, [message]),
      );
      expect(named).toEqual([
        {
          id: message,
          at: expect.any(String),
          subject: { untrusted: CANARIES.subject },
          from: expect.objectContaining({ id: person, kind: "person", name: { untrusted: CANARIES.name } }),
        },
      ]);
      // An id that is no message of the owner's names nothing.
      expect(
        await session(store.db.urls.admin, (query) =>
          namedMessages({ query, keys: store.db.keys }, ["msg_01J00000000000000000000000"]),
        ),
      ).toEqual([]);
    }));
});
