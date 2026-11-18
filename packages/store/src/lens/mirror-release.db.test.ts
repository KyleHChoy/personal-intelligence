import { type ClaimRecord, MIRROR_TEMPLATES, MirrorPage, type SyncMirrorArgs } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealRow } from "../core/seal.ts";
import { Reader } from "../read/read.ts";
import { testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { MIRROR_PASS_SECONDS } from "./mirror-sync.ts";

// An organization's entry serves the organization_name of a role claim. The Mac keeps an entry until
// its token changes, so a release that ends has to change the token, or the Mac keeps the name until
// the next full rebuild, up to a day later. A belief's entry is its state's: its support's evidence
// is lineage, and no word of it is served. Synthetic rows only.

const OWN = ["own"];
const T1 = MIRROR_TEMPLATES.find((one) => one.name === "lens_mirror@1");
const NAME = "Canary Release Organization";

describe("a mirror entry over a released claim", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let token: string;
  let organization: string;
  let ruling: string;
  let now = WORLD_NOW;
  let reader: Reader;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "agent:seed"] });
    const world = await seedWorld(store.writer, store.admin);
    const person = world.entityOf(WORLD.both.address);
    reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => now });
    // Cleared for the record's label: serve_mirror refuses an organization's evidence outside the clearance.
    await store.admin.lens.addDevice("mac", {
      compartments: ["agent:seed", "own"] as never,
      views: ["self", "people", "work"] as never,
    });
    token = await store.admin.lens.rotateDevice("mac", "mirror");
    const seeded = await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const id = await seed.entity("organization");
      await seed.domain(OWN, id);
      await seed.into("knowledge.claim_releases")(OWN);
      const [release] = (await query(
        "select ruling_id, evidence_id from knowledge.claim_releases order by created_at desc, ruling_id desc limit 1",
      )) as { ruling_id: string; evidence_id: string }[];
      return { id, ruling: release?.ruling_id ?? "", evidence: release?.evidence_id ?? "" };
    });
    organization = seeded.id;
    ruling = seeded.ruling;
    const base = claimRecord(seeded.evidence, OWN, person, {
      n: 9100,
      type: "role",
      factKey: "mirror release role",
      entities: [organization],
      origin: "agent_record",
    });
    const record = {
      ...base,
      claim: {
        ...base.claim,
        content: {
          type: "role",
          subject: person,
          fields: { title: "Chair", organization, organization_name: NAME },
        },
      },
      subjectKind: "person",
      fieldKinds: { title: "text", organization: "entity", organization_name: "text" },
    } as unknown as ClaimRecord;
    const id = fingerprint(store.db.keys, "claim", testId("released"));
    await session(store.db.urls.pipeline, async (query) => {
      await query(
        `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, compartments, released, content_enc)
         values ($1, $2, 'role', '2026-02-01T09:00:00Z', $3, 1, array['m-owner'], array['own'], true, $4)`,
        [
          id,
          seeded.evidence,
          fingerprint(store.db.keys, "fact", "mirror release role"),
          sealRow(
            store.db.keys,
            "own",
            { table: "knowledge.claims", id, column: "content_enc" },
            JSON.stringify(record),
          ),
        ],
      );
      await query(
        "insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, array['own'])",
        [id, organization],
      );
    });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  // Every entry of one pass from `cursor`, and the cursor it ends on.
  async function pass(from: string | null): Promise<{ text: string[]; cursor: string; ids: string[] }> {
    const text: string[] = [];
    const ids: string[] = [];
    let cursor = from;
    for (let calls = 0; calls < 60; calls += 1) {
      const answer = await reader.syncMirror(token, { templates: [T1?.name], cursor } as SyncMirrorArgs);
      if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
      const page = MirrorPage.parse(answer.value);
      for (const entry of page.entries)
        if (entry.section === "entities") {
          ids.push(entry.entity.id);
          text.push(JSON.stringify(entry.entity));
        }
      cursor = page.cursor;
      if (page.passComplete) return { text, cursor, ids };
    }
    throw new Error("no pass completed");
  }

  it("a release that ends sends the organization's entry again, without the name it gave", async () => {
    const first = await pass(null);
    expect(first.ids).toContain(organization);
    expect(first.text.join("\n")).toContain(NAME);
    await queryAs(
      store.db.urls.bootstrap,
      `set role pi_owner; alter table knowledge.owner_decisions no force row level security; update knowledge.owner_decisions set tainted_at = now() where id = '${ruling}'; alter table knowledge.owner_decisions force row level security`,
    );
    // The call after a completed pass confirms what it sent. The next pass, once it is due, sends only
    // an entry whose token changed.
    const between = await reader.syncMirror(token, { templates: [T1?.name], cursor: first.cursor } as SyncMirrorArgs);
    if (!between.ok) throw new Error(`sync_mirror answered ${between.code}`);
    const [row] = await queryAs<{ completed: Date }>(
      store.db.urls.admin,
      "select max(completed_at) as completed from ledger.mirror_cursors",
    );
    now = new Date((row?.completed.getTime() ?? 0) + (MIRROR_PASS_SECONDS + 1) * 1000);
    const second = await pass(MirrorPage.parse(between.value).cursor);
    expect(second.ids).toEqual([organization]);
    expect(second.text.join("\n")).not.toContain(NAME);
  });
});
