import {
  type AgentRecordArgs,
  type ClaimRecord,
  type CommitmentItem,
  CommitmentList,
  type EntityId,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerCommitments } from "../admin/work/admin-commitments.ts";
import type { AdminContext } from "../core/admin-context.ts";
import { createDb } from "../core/job-db.ts";
import { sealRow } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { bulkClaims } from "../test-support/bulk-claims.ts";
import { testId } from "../test-support/clients.ts";
import {
  type Client,
  commitClaims,
  insertReader,
  seededOf,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// Invariants 6 and 10: a released claim whose release has ended (a tainted or superseded confirm, or a
// veto on another claim of its record) keeps its row under `own` until the next rebuild, and a belief
// keeps it in its support until then, which the release's end wakes a run to do. A commitment's status and
// close time read that support, so they must read only claims whose release is in force, as find_facts' do.
// Synthetic rows only.

const OWN = ["own"];
const CLEARANCE = ["agent:release-reader", "own"];
const TOOLS = ["get_commitments", "get_beliefs", "record"];
const VIEWS = ["self", "people", "work"];
const DAY = 86_400_000;
const ago = (days: number): Date => new Date(WORLD_NOW.getTime() - days * DAY);

describe("get_commitments over a released claim", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let blake: string;
  let reader: Client;
  let sourceClaim: string;
  let n = 0;

  // A released claim under `own` of an agent record whose release is in force, as the pipeline commits
  // it. Its id and its release's ruling.
  async function releasedClaim(
    statementKind: string,
    at: Date,
  ): Promise<{ claim: string; ruling: string; evidence: string; fact: string }> {
    const { ruling, evidence } = await session(store.db.urls.admin, async (query) => {
      await seeder(store.db, query).into("knowledge.claim_releases")(OWN);
      const [release] = (await query(
        "select ruling_id, evidence_id from knowledge.claim_releases order by created_at desc, ruling_id desc limit 1",
      )) as { ruling_id: string; evidence_id: string }[];
      return { ruling: release?.ruling_id ?? "", evidence: release?.evidence_id ?? "" };
    });
    n += 1;
    const factKey = `release commitment ${n}`;
    // Its commitment's own claim from mail, a plain statement long before the courtesy window, on
    // the same fact key, so the belief computed for the key rests on both.
    await bulkClaims(store, 1, ago(60), (_, { evidenceId, validFrom }) => {
      const mail = claimRecord(evidenceId, OWN, owner, { n: 1, factKey, validFrom, entities: [blake] });
      return {
        ...mail,
        claim: {
          ...mail.claim,
          content: { ...mail.claim.content, fields: { counterparty: blake, what: "canary-mail-words" } },
        },
        subjectKind: "owner",
        fieldKinds: { counterparty: "entity", what: "text", due: "date" },
      } as unknown as ClaimRecord;
    });
    const base = claimRecord(evidence, OWN, owner, {
      n: 9000 + n,
      type: "commitment",
      factKey,
      validFrom: at.toISOString(),
      entities: [blake],
      origin: "agent_record",
    });
    const record = {
      ...base,
      claim: {
        ...base.claim,
        statementKind,
        content: { ...base.claim.content, fields: { counterparty: blake, what: "canary-released-words" } },
      },
      subjectKind: "owner",
      fieldKinds: { counterparty: "entity", what: "text", due: "date" },
      released: { ruling },
    } as unknown as ClaimRecord;
    // Its stored id, as the commit makes one: its claim id's keyed fingerprint.
    const id = fingerprint(store.db.keys, "claim", base.claim.id);
    await session(store.db.urls.pipeline, (query) =>
      query(
        `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, compartments, released, content_enc)
         values ($1, $2, 'commitment', $3, $4, 1, array['m-owner'], array['own'], true, $5)`,
        [
          id,
          evidence,
          at.toISOString(),
          fingerprint(store.db.keys, "fact", factKey),
          sealRow(
            store.db.keys,
            "own",
            { table: "knowledge.claims", id, column: "content_enc" },
            JSON.stringify(record),
          ),
        ],
      ),
    );
    await knownBy(store.db, store.now);
    return { claim: id, ruling, evidence, fact: fingerprint(store.db.keys, "fact", factKey) };
  }

  // As the table's owner, past its row level security.
  const asOwner = (table: string, statement: string): Promise<unknown> =>
    queryAs(
      store.db.urls.bootstrap,
      `set role pi_owner; alter table ${table} no force row level security; ${statement}; alter table ${table} force row level security`,
    );
  const taint = (ruling: string): Promise<unknown> =>
    asOwner(
      "knowledge.owner_decisions",
      `update knowledge.owner_decisions set tainted_at = now() where id = '${ruling}'`,
    );

  const items = async (state: "open" | "closed"): Promise<CommitmentItem[]> =>
    CommitmentList.parse(outcomeValue(await store.reader.getCommitments(reader.token, { state, limit: 50 })))
      .commitments;
  const facts = async (state: "open" | "closed"): Promise<string[]> =>
    (await items(state)).map((one) => one.belief.fact);

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "agent:release-reader"] });
    const world = await seedWorld(store.writer, store.admin);
    owner = world.ownerEntity();
    blake = world.entityOf(WORLD.both.address) as EntityId;
    const messages = await worldMessages(store);
    const message = messages.find((one) => one.compartment === "own");
    if (message === undefined) throw new Error("no message");
    // The mail's own claim, a plain statement, long before the courtesy window.
    const specs = [
      {
        key: "release-source",
        subject: owner,
        counterparty: blake,
        claims: [{ message, what: "canary-mail-words", at: ago(60).toISOString() }],
      },
    ];
    const records = await commitClaims(store, owner, specs);
    await knownBy(store.db, store.now);
    sourceClaim = seededOf(store, specs, records).get("release-source")?.claims[0] ?? "";
    reader = await insertReader(store, "release-reader", CLEARANCE, { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  // A compiled read serves a document's claim with no document id, and says its source all the same.
  it("a released claim on a document the token sees is cited as a document's, as find_facts says", async () => {
    const { claim, evidence } = await releasedClaim("stated_fact", ago(30));
    const citeOf = async () =>
      outcomeValue(await store.reader.getBeliefs(reader.token, { kind: "commitment", state: "any" }))
        .beliefs.flatMap((one) => one.cites)
        .find((one) => !("held" in one) && one.id === claim);
    expect(await citeOf()).toMatchObject({ source: "agent", document: null });
    await session(store.db.urls.admin, async (query) => {
      await seeder(store.db, query).into("knowledge.documents")(OWN);
      await query(
        "update knowledge.documents set evidence_id = $1 where id = (select id from knowledge.documents order by id desc limit 1)",
        [evidence],
      );
    });
    expect(await citeOf()).toMatchObject({ source: "document", document: null });
  });

  it("a proposal whose release ended no longer lapses the commitment: its status is read from what is in force", async () => {
    const { claim, ruling, fact } = await releasedClaim("proposal", ago(45));
    // While the release is in force the proposal is the latest claim, and the courtesy has lapsed.
    expect(await facts("open")).not.toContain(fact);
    expect(await facts("closed")).toContain(fact);
    await taint(ruling);
    // The claim's row is still returned by the row policy; its release is not in force.
    const [row] = await queryAs<{ released: boolean }>(
      store.db.urls.admin,
      "select released from knowledge.claims where id = $1",
      [claim],
    );
    expect(row?.released).toBe(true);
    expect(await facts("open")).toContain(fact);
    expect(await facts("closed")).not.toContain(fact);
  });

  it("the owner's page reads the lapse as get_commitments does", async () => {
    // The owner's read computes the commitment from the claims in force under the owner's audience,
    // as get_commitments computes it under the token's.
    const { ruling, fact } = await releasedClaim("proposal", ago(45));
    const db = createDb(store.db.urls.admin, recordingLogger().log);
    const context: AdminContext = {
      transaction: (fn) => db.transaction(fn),
      keys: store.db.keys,
      log: recordingLogger().log,
      now: () => store.now,
    };
    const inState = async (state: "open" | "closed"): Promise<string[]> =>
      (await ownerCommitments(context, { state })).commitments.map((one) => one.item.belief.fact);
    try {
      expect(await inState("closed")).toContain(fact);
      await taint(ruling);
      expect(await inState("open")).toContain(fact);
      expect(await inState("closed")).not.toContain(fact);
    } finally {
      await db.close();
    }
  });

  it("a reversal whose release ended no longer dates the close: the commitment says nothing of when or by what", async () => {
    const at = ago(10);
    const { ruling, evidence, fact } = await releasedClaim("reversal", at);
    // The answer record that made the release, as the token returns it.
    const recordId = outcomeValue(
      await store.reader.record(reader.token, {
        kind: "note",
        body: "canary-answer",
        requestId: "release-reversal-answer",
      } satisfies AgentRecordArgs),
    ).recordId;
    await asOwner(
      "ledger.agent_writes",
      `update ledger.agent_writes set tool = 'answer_owner_question', kind = 'answer', opportunity_id = 'opp_01JABCDEFGHJKMNPQRSTVWXY98', evidence_id = '${evidence}' where id = '${recordId}'`,
    );
    const inState = async (state: "open" | "closed"): Promise<CommitmentItem | undefined> =>
      (await items(state)).find((one) => one.belief.fact === fact);
    expect(await inState("closed")).toMatchObject({ closedAt: at.toISOString(), doneBy: { answer: recordId } });
    await taint(ruling);
    // The reversal, out of force, closes nothing: the commitment computed from what is in force is
    // open again, and says nothing of when or by what it closed.
    expect(await inState("closed")).toBeUndefined();
    expect(await inState("open")).toMatchObject({ closedAt: null, doneAt: null, doneBy: null });
  });

  // Whether the channel that wakes a run, and so the rebuild, heard anything while `act` ran.
  // `patience` is how long it listens: a short while before saying no, and long before giving up on a yes.
  async function woke(act: () => Promise<unknown>, patience = 200): Promise<boolean> {
    const client = new pg.Client({ connectionString: store.db.urls.pipeline });
    await client.connect();
    let heard = false;
    client.on("notification", () => {
      heard = true;
    });
    try {
      await client.query("listen pi_agent_write");
      await act();
      for (const end = Date.now() + patience; !heard && Date.now() < end; ) {
        await client.query("select 1");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await client.query("select 1");
      return heard;
    } finally {
      await client.end();
    }
  }
  const wakes = (act: () => Promise<unknown>): Promise<boolean> => woke(act, 30_000);

  describe("a release that ends wakes the run that rebuilds", () => {
    it("when its decision is tainted", async () => {
      const { ruling } = await releasedClaim("reversal", ago(10));
      expect(await wakes(() => taint(ruling))).toBe(true);
    });

    it("when its decision is superseded", async () => {
      const { ruling } = await releasedClaim("reversal", ago(10));
      expect(
        await wakes(() =>
          asOwner(
            "knowledge.owner_decisions",
            `insert into knowledge.owner_decisions (id, request_id, kind, supersedes, queue_depth, decided_at, compartments)
             values ('${testId("rul")}', 'release-superseded-${n}', 'confirmation_lift', '${ruling}', 0, now(), array['own'])`,
          ),
        ),
      ).toBe(true);
    });

    it("when its row is lifted", async () => {
      const { ruling } = await releasedClaim("reversal", ago(10));
      expect(
        await wakes(() =>
          queryAs(
            store.db.urls.admin,
            "update knowledge.claim_releases set lifted_at = now(), lift_ruling_id = ruling_id where ruling_id = $1",
            [ruling],
          ),
        ),
      ).toBe(true);
    });

    it("when a claim of its record is vetoed, which no other veto does", async () => {
      const { claim } = await releasedClaim("reversal", ago(10));
      expect(await wakes(() => store.admin.facts.vetoFact(claim as never, { requestId: `release-veto-${n}` }))).toBe(
        true,
      );
      expect(
        await woke(() => store.admin.facts.vetoFact(sourceClaim as never, { requestId: `release-other-veto-${n}` })),
      ).toBe(false);
    });

    it("and no decision that made no release wakes anything", async () => {
      const [other] = await queryAs<{ id: string }>(
        store.db.urls.admin,
        `select o.id from knowledge.owner_decisions o
         where not exists (select 1 from knowledge.claim_releases r where r.ruling_id = o.id) and o.tainted_at is null
         order by o.id limit 1`,
      );
      expect(other).toBeDefined();
      expect(await woke(() => taint(other?.id ?? ""))).toBe(false);
    });

    it("and the rebuild it wakes no longer reads a closed commitment's ended reversal", async () => {
      const { claim, ruling } = await releasedClaim("reversal", ago(10));
      const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
      const released = async (): Promise<boolean> => {
        const [row] = await queryAs<{ fact_key_fp: string }>(
          store.db.urls.admin,
          "select fact_key_fp from knowledge.claims where id = $1",
          [claim],
        );
        const group = (await pipeline.beliefClaims()).find((one) => one.factKeyFp === row?.fact_key_fp);
        return (
          group?.claims.some((one) => one.origin === "agent_record" && one.claim.statementKind === "reversal") === true
        );
      };
      try {
        expect(await released()).toBe(true);
        await taint(ruling);
        expect(await released()).toBe(false);
      } finally {
        await pipeline.close();
      }
    });
  });
});
