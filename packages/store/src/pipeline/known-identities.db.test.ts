import { describe, expect, it } from "vitest";
import { QUENTIN, SOLO } from "../test-support/cast.ts";
import { sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { stored, withPipeline } from "../test-support/pipeline-fixtures.ts";

// policy.known_identities: the people's names the pseudonymiser replaces reach pi_pipeline through
// this function alone, only under the owner's clearance, and no other role may call it.

const TIMEOUT = 240_000;
const CALL = "select source, id from policy.known_identities()";

describe("policy.known_identities", () => {
  it(
    "gives pi_pipeline other people's names, which its row policy hides, and nothing restricted",
    async () => {
      await withPipeline(async ({ writer, accounts, db, pipeline }) => {
        await stored(writer, accounts.personalMail, MAIL.fromQuentin);
        await stored(writer, accounts.personalMail, MAIL.solo);
        const people = await queryAs<{ id: string }>(
          db.urls.admin,
          "select a.id from knowledge.aliases a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' order by a.id",
        );
        expect(people.length).toBeGreaterThan(0);
        const ids = people.map((row) => row.id);

        // Positive control first: the function returns them, sealed.
        const given = await queryAs<{ source: string; id: string }>(db.urls.pipeline, CALL);
        expect(given.filter((row) => row.source === "alias").map((row) => row.id)).toEqual(expect.arrayContaining(ids));
        // The table itself still hides them from the role.
        const direct = await queryAs<{ id: string }>(db.urls.pipeline, "select id from knowledge.aliases");
        expect(direct.map((row) => row.id).filter((id) => ids.includes(id))).toEqual([]);

        // A person's alias under a restricted label is not under the owner's clearance.
        const [first] = ids;
        await queryAs(
          db.urls.admin,
          `insert into knowledge.aliases (id, entity_id, value_fp, evidence_id, value_enc, compartments)
           select 'alias-restricted-test', entity_id, value_fp || '-r', evidence_id, value_enc, array['restricted:health']
           from knowledge.aliases where id = $1`,
          [first],
        );
        const after = await queryAs<{ id: string }>(db.urls.pipeline, CALL);
        expect(after.map((row) => row.id)).not.toContain("alias-restricted-test");

        // Opened by the pipeline: the names and addresses, each once.
        const known = await pipeline.knownIdentities();
        expect(known.names).toEqual(expect.arrayContaining([QUENTIN.name, SOLO.name]));
        expect(known.addresses).toEqual(expect.arrayContaining([QUENTIN.address, SOLO.address]));
        expect(new Set(known.names).size).toBe(known.names.length);
      });
    },
    TIMEOUT,
  );

  it(
    "is refused to every other role",
    async () => {
      await withPipeline(async ({ db }) => {
        for (const url of [db.urls.reader, db.urls.writer, db.urls.admin, db.urls.work, db.urls.restricted])
          expect(await sqlState(() => queryAs(url, CALL))).toBe("42501");
      });
    },
    TIMEOUT,
  );
});
