import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimRecord, ExtractionCommit } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import { sealUnder } from "../core/seal.ts";
import { type StatusFacts, statusAt } from "../core/status-facts.ts";
import { openedUnder, type Tx } from "../core/tx.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { commitBatch } from "./pipeline-write.ts";

// commitBatch over a query that answers as the database would, recording each statement it sends:
// which statements, in which order, and what it returns or throws, for each of its paths. Ids that
// are valid but mean nothing.

let dir = "";
let keys: Keys;
const LABEL = ["own"];
const ITEM = "e".repeat(64);
const OTHER_ITEM = "a".repeat(64);
const SUBJECT = `ent_${"0".repeat(25)}7`;
const STORED_CLAIM = "b".repeat(64);
const CODE_CLAIM = "c".repeat(64);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-pipeline-write-"));
  await generateKeyFile(join(dir, "keys.json"), LABEL);
  keys = await loadKeys(join(dir, "keys.json"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Answers = {
  sourceKind?: string;
  gone?: boolean;
  superseded?: boolean;
  status?: Partial<StatusFacts>;
  stored?: { id: string; type: string }[];
  generation?: number | null;
  firstKnown?: Record<string, string> | null;
  flagged?: boolean;
  thread?: string | null;
};

// A statement by its first words and a digest of its whole text.
const statement = (text: string): string =>
  `${text.slice(0, 60)} #${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;

// The statements sent, each its first words, and answers by what a statement reads.
// The status rows written: their marks, release and opened facts.
type Written = { marks: unknown[]; release: unknown; facts: StatusFacts };
function database(answers: Answers): { tx: Tx; sent: string[]; written: Written[] } {
  const sent: string[] = [];
  const written: Written[] = [];
  const query = (async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    sent.push(statement(text));
    if (text.startsWith("insert into vault.pipeline_items"))
      written.push({
        marks: values.slice(1, 4),
        release: values[7],
        facts: JSON.parse(openedUnder(keys, LABEL, statusAt(ITEM), values[5])) as StatusFacts,
      });
    if (text.startsWith("select compartments, readers, source_kind, xmin::text"))
      return answers.gone === true
        ? []
        : [{ compartments: LABEL, readers: ["m-owner"], source_kind: answers.sourceKind ?? "mail", xmin: "7" }];
    if (text.includes("where supersedes = $1")) return [{ found: answers.superseded === true }];
    if (text.startsWith("select facts_enc, compartments, vendor_retries from vault.pipeline_items"))
      return answers.status === undefined
        ? []
        : [
            {
              compartments: LABEL,
              vendor_retries: 0,
              facts_enc: sealUnder(
                keys,
                LABEL,
                statusAt(ITEM),
                JSON.stringify({
                  lane: "correspondence",
                  override: false,
                  status: "done",
                  attempts: 0,
                  claims: 1,
                  unmapped: 0,
                  unresolved: 3,
                  ...answers.status,
                }),
              ),
            },
          ];
    if (text.includes("max(c.extractor_generation)"))
      return [
        {
          generation: answers.generation ?? null,
          rederived: answers.generation === undefined,
          first_known: answers.firstKnown ?? null,
        },
      ];
    if (text.startsWith("select id, type from knowledge.claims where evidence_id")) return answers.stored ?? [];
    if (text.includes("from ledger.agent_writes where evidence_id = $1 and flagged_at is null"))
      return answers.flagged === true ? [] : [{ id: "1" }];
    if (text.includes("from ledger.agent_writes where evidence_id = $1 and flagged_at is not null"))
      return answers.flagged === true ? [{ id: "1" }] : [];
    if (text.startsWith("select compartments from vault.evidence_items")) return [{ compartments: LABEL }];
    if (text.startsWith("select thread_fp from vault.evidence_items")) return [{ thread_fp: answers.thread ?? null }];
    if (text.includes("ledger.check_restatement")) return [{ answer: "echo", cleared: false }];
    if (text.startsWith("select item_enc from vault.evidence_items"))
      return [
        {
          item_enc: sealUnder(
            keys,
            LABEL,
            { table: "vault.evidence_items", id: ITEM, column: "item_enc" },
            JSON.stringify({
              recordId: `rec_${"0".repeat(25)}1`,
              client: "test-agent",
              session: `ses_${"0".repeat(25)}2`,
              kind: "proposal",
              recordedAt: "2026-09-01T09:00:00.000Z",
              cites: [],
            }),
          ),
        },
      ];
    return [];
  }) as Query;
  return { tx: { query, keys }, sent, written };
}

const claim = (n: number, options: Parameters<typeof claimRecord>[3] = {}): ClaimRecord =>
  claimRecord(ITEM, LABEL, SUBJECT, { n, ...options });

describe("commitBatch refuses what is not one item's whole commit", () => {
  const refused = async (batch: unknown, answers: Answers = {}): Promise<string[]> => {
    const { tx, sent } = database(answers);
    await expect(commitBatch(tx, batch as ExtractionCommit, undefined)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    return sent;
  };

  it("a batch that does not parse, a claim of another item, a released claim not `own` alone, an answer naming no claim of it", async () => {
    expect(await refused({ evidenceId: ITEM })).toEqual([]);
    expect(await refused(batchOf(ITEM, [claimRecord(OTHER_ITEM, LABEL, SUBJECT)]))).toEqual([]);
    const released = { ...claim(1), released: { ruling: "x" } };
    const wide = {
      ...released,
      claim: { ...released.claim, label: { ...released.claim.label, compartments: ["own", "work"] } },
    };
    expect(await refused(batchOf(ITEM, [wide as unknown as ClaimRecord]))).toEqual([]);
    expect(
      await refused(
        batchOf(ITEM, [claim(1)], {
          restatements: [{ claimId: "z", answer: "new", reached: null, matchedFactKeyFp: null }],
        }),
      ),
    ).toEqual([]);
  });

  it("restatement answers on an item that is no agent record, and `keep` on one that is no moment, after the lock", async () => {
    const lock = EXPECTED.source?.slice(0, 2) ?? [];
    const one = claim(1);
    expect(
      await refused(
        batchOf(ITEM, [one], {
          restatements: [{ claimId: one.claim.id, answer: "new", reached: null, matchedFactKeyFp: null }],
        }),
      ),
    ).toEqual(lock);
    expect(await refused(batchOf(ITEM, [], { status: "skipped", keep: true }))).toEqual(lock);
  });
});

describe("commitBatch's paths, each statement in order", () => {
  it("an item gone or superseded returns that and writes nothing; a changed row throws", async () => {
    const gone = database({ gone: true });
    expect(await commitBatch(gone.tx, batchOf(ITEM, []), undefined)).toBe("gone");
    expect(gone.sent).toHaveLength(1);
    const superseded = database({ superseded: true });
    expect(await commitBatch(superseded.tx, batchOf(ITEM, []), undefined)).toBe("superseded");
    expect(superseded.sent).toHaveLength(2);
    await expect(commitBatch(database({}).tx, batchOf(ITEM, []), "8")).rejects.toMatchObject({ code: "item_changed" });
  });

  it("a source item's done commit raised a generation: a stored claim replaced, new claims, unmapped, mentions and the carry spent", async () => {
    const { tx, sent, written } = database({
      generation: 0,
      status: { rerouted: true, laneOverride: "skip" },
      stored: [{ id: STORED_CLAIM, type: "commitment" }],
      firstKnown: { k: "2026-01-01T00:00:00.000Z" },
      thread: "f".repeat(64),
    });
    const batch = batchOf(ITEM, [claim(1), claim(2, { type: "relationship" })], {
      unmapped: [{ id: "u1", proposedType: "hobby", reason: "unknown_type" }],
      mentions: [{ name: "Avery Example", type: "relationship", field: "counterparty" }],
    });
    expect(await commitBatch(tx, batch, "7")).toBe("committed");
    expect(sent).toEqual(EXPECTED.source);
    expect(written).toEqual([
      {
        marks: [false, false, true],
        release: null,
        facts: {
          lane: "correspondence",
          laneOverride: "skip",
          override: false,
          status: "done",
          attempts: 0,
          claims: 2,
          unmapped: 1,
          unresolved: 0,
        },
      },
    ]);
  });

  it("a moment's kept skip with a title link: only code's claims replaced, the lock and its card", async () => {
    const { tx, sent, written } = database({
      sourceKind: "screen_activity",
      generation: 1,
      status: {},
      stored: [
        { id: STORED_CLAIM, type: "commitment" },
        { id: CODE_CLAIM, type: "activity.app" },
      ],
    });
    const batch = batchOf(ITEM, [claim(1, { type: "capture.project" })], {
      status: "skipped",
      code: "no_turns",
      keep: true,
      unmapped: [{ id: "u1", proposedType: "hobby", reason: "unknown_type" }],
      mentions: [{ name: "Avery Example", type: "relationship", field: "counterparty" }],
    });
    expect(await commitBatch(tx, batch, undefined)).toBe("committed");
    expect(sent).toEqual(EXPECTED.moment);
    expect(written).toEqual([
      {
        marks: [false, false, false],
        release: null,
        facts: {
          lane: "correspondence",
          override: false,
          status: "skipped",
          code: "no_turns",
          attempts: 0,
          claims: 2,
          unmapped: 1,
          unresolved: 3,
        },
      },
    ]);
  });

  it("an agent record's done commit: its locks, the restatement marks and the cards", async () => {
    const { tx, sent } = database({ sourceKind: "agent_record", generation: 1 });
    const one = claim(1, { origin: "agent_record" });
    const batch = batchOf(ITEM, [one, claim(2, { origin: "agent_record" })], {
      restatements: [{ claimId: one.claim.id, answer: "echo", reached: "read", matchedFactKeyFp: "9".repeat(64) }],
    });
    expect(await commitBatch(tx, batch, undefined)).toBe("committed");
    expect(sent).toEqual(EXPECTED.agentDone);
  });

  it("an agent record withheld as quarantine is flagged; one flagged before commits nothing of its batch", async () => {
    const quarantine = database({ sourceKind: "agent_record", generation: 1 });
    const batch = batchOf(ITEM, [], { status: "withheld", code: "quarantine" });
    expect(await commitBatch(quarantine.tx, batch, undefined)).toBe("committed");
    expect(quarantine.sent).toEqual(EXPECTED.agentQuarantine);
    const flagged = database({ sourceKind: "agent_record", generation: 1, flagged: true });
    expect(await commitBatch(flagged.tx, batchOf(ITEM, [claim(1, { origin: "agent_record" })]), undefined)).toBe(
      "committed",
    );
    expect(flagged.sent).toEqual(EXPECTED.agentFlagged);
  });

  it("an agent record's client-scoped skip raises its one card", async () => {
    const { tx, sent } = database({ sourceKind: "agent_record", generation: 1 });
    const batch = batchOf(ITEM, [], { lane: "agent", status: "skipped", code: "client_scoped" });
    expect(await commitBatch(tx, batch, undefined)).toBe("committed");
    expect(sent).toEqual(EXPECTED.agentClientScoped);
  });
});

// What each path sent, read off commitBatch before it was split into steps.
const EXPECTED: Record<string, string[]> = {
  source: [
    "select compartments, readers, source_kind, xmin::text as xmi #5066e161",
    "select exists (select 1 from vault.evidence_items where supe #50a86146",
    "select facts_enc, compartments, vendor_retries from vault.pi #991ec8a6",
    "select (select max(c.extractor_generation) from knowledge.cl #399d4a2a",
    "select set_config('pi.trigger_cause', 'backfill', true) #34c53905",
    "select id, type from knowledge.claims where evidence_id = $1 #13671f98",
    "select k.key, to_char(min(k.first_known_at) at time zone 'UT #4351da0c",
    "select pg_advisory_xact_lock(hashtext('intelligence personal #6c2a3df6",
    "delete from knowledge.project_bindings where claim_id = any  #197094e4",
    "delete from knowledge.claim_entities where claim_id = any ($ #1446b20a",
    "select projections.drop_declassified($1) as dropped #cc760ee7",
    "delete from knowledge.claims where id = any ($1) #8d487cd6",
    "delete from vault.unmapped_claims where evidence_id = $1 and #156b395c",
    "insert into knowledge.claims (id, evidence_id, type, valid_f #be4d028f",
    "insert into knowledge.claim_values (claim_id, claim_key, val #6179893a",
    "insert into knowledge.claim_entities (claim_id, entity_id, c #2fd5808d",
    "insert into knowledge.claims (id, evidence_id, type, valid_f #be4d028f",
    "insert into knowledge.claim_values (claim_id, claim_key, val #6179893a",
    "insert into knowledge.claim_entities (claim_id, entity_id, c #2fd5808d",
    "select id, evidence_id, fact_key_fp, legacy_fact_key_fp, leg #35765457",
    "select id from knowledge.entities where kind = 'owner' #9df65064",
    "update vault.pipeline_items p set waiting = true where p.evi #7a400f3f",
    "select thread_fp from vault.evidence_items where id = $1 #1b2bc3d9",
    "select a.project_id from knowledge.project_anchors a join kn #d8e5f533",
    "select id, compartments, facts_enc from vault.unmapped_claim #c4a5778a",
    "insert into vault.unmapped_claims (id, evidence_id, extracto #08e8db10",
    "delete from vault.unresolved_mentions where evidence_id = $1 #a43b60c8",
    "insert into vault.unresolved_mentions (id, evidence_id, extr #44f3475d",
    "select compartments from vault.evidence_items where id = $1 #706ece83",
    "insert into vault.pipeline_items (evidence_id, waiting, with #0c822fe5",
    "update vault.pipeline_items set reask_codes = $2, reask_word #73d508a5",
    "update vault.pipeline_items set first_known = null where evi #0cc52465",
  ],
  moment: [
    "select compartments, readers, source_kind, xmin::text as xmi #5066e161",
    "select exists (select 1 from vault.evidence_items where supe #50a86146",
    "select facts_enc, compartments, vendor_retries from vault.pi #991ec8a6",
    "select (select max(c.extractor_generation) from knowledge.cl #399d4a2a",
    "select id, type from knowledge.claims where evidence_id = $1 #13671f98",
    "select k.key, to_char(min(k.first_known_at) at time zone 'UT #4351da0c",
    "select pg_advisory_xact_lock(hashtext('intelligence personal #6c2a3df6",
    "select ledger.lock_rows($1) #724f8354",
    "delete from knowledge.project_bindings where claim_id = any  #197094e4",
    "delete from knowledge.claim_entities where claim_id = any ($ #1446b20a",
    "select projections.drop_declassified($1) as dropped #cc760ee7",
    "delete from knowledge.claims where id = any ($1) #8d487cd6",
    "insert into knowledge.claims (id, evidence_id, type, valid_f #be4d028f",
    "insert into knowledge.claim_values (claim_id, claim_key, val #6179893a",
    "insert into knowledge.claim_entities (claim_id, entity_id, c #2fd5808d",
    "select id, evidence_id, fact_key_fp, legacy_fact_key_fp, leg #35765457",
    "select id from knowledge.entities where kind = 'owner' #9df65064",
    "select thread_fp from vault.evidence_items where id = $1 #1b2bc3d9",
    "select id, compartments, facts_enc from vault.unmapped_claim #c4a5778a",
    "insert into vault.unmapped_claims (id, evidence_id, extracto #08e8db10",
    "select compartments from vault.evidence_items where id = $1 #706ece83",
    "insert into vault.pipeline_items (evidence_id, waiting, with #0c822fe5",
    "update vault.pipeline_items set reask_codes = $2, reask_word #73d508a5",
    "select now() as now #6b9d09d3",
    "select ledger.expire_agent_claims() #756bfd78",
    "select ledger.lock_rows($1) #724f8354",
    "select c.id, (select r.event from ledger.record_events r whe #223e1afc",
    "insert into ledger.cards (id, request_id, created_at, create #58e92d3e",
    "insert into ledger.record_events (row_kind, row_id, event, a #238377c4",
    "select ledger.stop_card_by_rule($1) as rule #40864fd9",
    "select ledger.add_agent_claim_basis($1, $2) as ok #f019f6da",
  ],
  agentDone: [
    "select compartments, readers, source_kind, xmin::text as xmi #5066e161",
    "select exists (select 1 from vault.evidence_items where supe #50a86146",
    "select facts_enc, compartments, vendor_retries from vault.pi #991ec8a6",
    "select (select max(c.extractor_generation) from knowledge.cl #399d4a2a",
    "select id from ledger.agent_writes where evidence_id = $1 an #2f5b66db",
    "select id, type from knowledge.claims where evidence_id = $1 #13671f98",
    "select ledger.lock_rows($1) #724f8354",
    "select id from ledger.agent_writes where evidence_id = $1 an #53929786",
    "delete from vault.unmapped_claims where evidence_id = $1 and #156b395c",
    "insert into knowledge.claims (id, evidence_id, type, valid_f #be4d028f",
    "insert into knowledge.claim_values (claim_id, claim_key, val #6179893a",
    "insert into knowledge.claim_entities (claim_id, entity_id, c #2fd5808d",
    "insert into knowledge.claims (id, evidence_id, type, valid_f #be4d028f",
    "insert into knowledge.claim_values (claim_id, claim_key, val #6179893a",
    "insert into knowledge.claim_entities (claim_id, entity_id, c #2fd5808d",
    "select id, evidence_id, fact_key_fp, legacy_fact_key_fp, leg #35765457",
    "select id from knowledge.entities where kind = 'owner' #9df65064",
    "select id, compartments, facts_enc from vault.unmapped_claim #c4a5778a",
    "delete from vault.unresolved_mentions where evidence_id = $1 #a43b60c8",
    "select compartments from vault.evidence_items where id = $1 #706ece83",
    "insert into vault.pipeline_items (evidence_id, waiting, with #0c822fe5",
    "update vault.pipeline_items set reask_codes = $2, reask_word #73d508a5",
    "select answer, cleared from ledger.check_restatement($1, $2, #6c8ec17c",
    "select now() as now #6b9d09d3",
    "select ledger.expire_agent_claims() #756bfd78",
    "select item_enc from vault.evidence_items where id = $1 #74057135",
    "select 1 from ledger.cards where created_by = 'system:extrac #2f372489",
    "select policy.fact_ruled($1, $2) as ruled #2f82bbbd",
    "select ledger.lock_rows($1) #724f8354",
    "select c.id, (select r.event from ledger.record_events r whe #223e1afc",
    "insert into ledger.cards (id, request_id, created_at, create #58e92d3e",
    "insert into ledger.record_events (row_kind, row_id, event, a #238377c4",
    "select ledger.stop_card_by_rule($1) as rule #40864fd9",
    "select ledger.add_agent_claim_basis($1, $2) as ok #f019f6da",
  ],
  agentQuarantine: [
    "select compartments, readers, source_kind, xmin::text as xmi #5066e161",
    "select exists (select 1 from vault.evidence_items where supe #50a86146",
    "select facts_enc, compartments, vendor_retries from vault.pi #991ec8a6",
    "select (select max(c.extractor_generation) from knowledge.cl #399d4a2a",
    "select id from ledger.agent_writes where evidence_id = $1 an #2f5b66db",
    "select id, type from knowledge.claims where evidence_id = $1 #13671f98",
    "select ledger.lock_rows($1) #724f8354",
    "select id from ledger.agent_writes where evidence_id = $1 an #53929786",
    "delete from vault.unmapped_claims where evidence_id = $1 and #156b395c",
    "select id, compartments, facts_enc from vault.unmapped_claim #c4a5778a",
    "delete from vault.unresolved_mentions where evidence_id = $1 #a43b60c8",
    "select compartments from vault.evidence_items where id = $1 #706ece83",
    "insert into vault.pipeline_items (evidence_id, waiting, with #0c822fe5",
    "update vault.pipeline_items set reask_codes = $2, reask_word #73d508a5",
    "update ledger.agent_writes set flagged_at = now() where evid #3843ba4b",
  ],
  agentFlagged: [
    "select compartments, readers, source_kind, xmin::text as xmi #5066e161",
    "select exists (select 1 from vault.evidence_items where supe #50a86146",
    "select facts_enc, compartments, vendor_retries from vault.pi #991ec8a6",
    "select (select max(c.extractor_generation) from knowledge.cl #399d4a2a",
    "select id from ledger.agent_writes where evidence_id = $1 an #2f5b66db",
    "select id from ledger.agent_writes where evidence_id = $1 an #7543e986",
    "select id, type from knowledge.claims where evidence_id = $1 #13671f98",
    "select ledger.lock_rows($1) #724f8354",
    "select id from ledger.agent_writes where evidence_id = $1 an #53929786",
    "select id from ledger.agent_writes where evidence_id = $1 an #3bc90d05",
    "delete from vault.unmapped_claims where evidence_id = $1 and #156b395c",
    "select id, compartments, facts_enc from vault.unmapped_claim #c4a5778a",
    "delete from vault.unresolved_mentions where evidence_id = $1 #a43b60c8",
    "select compartments from vault.evidence_items where id = $1 #706ece83",
    "insert into vault.pipeline_items (evidence_id, waiting, with #0c822fe5",
    "update vault.pipeline_items set reask_codes = $2, reask_word #73d508a5",
  ],
  agentClientScoped: [
    "select compartments, readers, source_kind, xmin::text as xmi #5066e161",
    "select exists (select 1 from vault.evidence_items where supe #50a86146",
    "select facts_enc, compartments, vendor_retries from vault.pi #991ec8a6",
    "select (select max(c.extractor_generation) from knowledge.cl #399d4a2a",
    "select id from ledger.agent_writes where evidence_id = $1 an #2f5b66db",
    "select id, type from knowledge.claims where evidence_id = $1 #13671f98",
    "select ledger.lock_rows($1) #724f8354",
    "select id from ledger.agent_writes where evidence_id = $1 an #53929786",
    "delete from vault.unmapped_claims where evidence_id = $1 and #156b395c",
    "select id, compartments, facts_enc from vault.unmapped_claim #c4a5778a",
    "delete from vault.unresolved_mentions where evidence_id = $1 #a43b60c8",
    "select compartments from vault.evidence_items where id = $1 #706ece83",
    "insert into vault.pipeline_items (evidence_id, waiting, with #0c822fe5",
    "update vault.pipeline_items set reask_codes = $2, reask_word #73d508a5",
    "select now() as now #6b9d09d3",
    "select ledger.expire_agent_claims() #756bfd78",
    "select item_enc from vault.evidence_items where id = $1 #74057135",
    "select ledger.lock_rows($1) #724f8354",
    "select c.id, (select r.event from ledger.record_events r whe #223e1afc",
    "insert into ledger.cards (id, request_id, created_at, create #58e92d3e",
    "insert into ledger.record_events (row_kind, row_id, event, a #238377c4",
    "select ledger.stop_card_by_rule($1) as rule #40864fd9",
    "select ledger.add_agent_claim_basis($1, $2) as ok #f019f6da",
  ],
};
