import type { ClientId, EntityId, MessageId, VendorRetention } from "@intelligence/contracts/personal";
import type { SourceAccountRow } from "../write/writer-types.ts";
import { OWNER, QUENTIN, type Who } from "./cast.ts";
import { hashFingerprint, sha256Hex, testId } from "./clients.ts";
import { type CommitmentSpec, commitClaims, type Records } from "./commitment-fixtures.ts";
import { readAs, session } from "./connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "./database.ts";
import { ingestMail, type MailFixture, mail, mailSourceId } from "./items.ts";
import { seeder } from "./seeder.ts";
import type { TestStore } from "./store.ts";

// The memory tests' helpers: clients inserted in SQL as pi_admin, and
// policy.serve_memory called as pi_reader under a token, with values of the right forms that
// name nothing real. The function derives each entry's evidence ids from its belief, so a sync
// first writes, as pi_admin, the beliefs it serves: each with one claim on each of its evidence
// ids, and an evidence row for each id the vault lacks. No row of the synthetic world is needed.
// Each entry's support, the claims seeded for it, is passed as the reader passes a computed
// belief's (`supportsOf`).

export const TEMPLATE = "active_memory@1";
const SERVE =
  "select kind, projection_id, ended_at, reason, current_id, evidence_ids from policy.serve_memory($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, supports => $11::jsonb)";

// A lower-case hexadecimal value of `length` characters, made from `seed`.
export const hex = (seed: number | string, length = 64): string => {
  const base = typeof seed === "number" ? seed.toString(16) : Buffer.from(seed, "utf8").toString("hex");
  return base.padStart(length, "0").slice(-length);
};
export const projectionId = (seed: number | string): string => `mpr_${hex(seed, 40)}`;
export const beliefId = (seed: number | string): string => `blf_${hex(seed, 40)}`;
export const evidenceId = (seed: number | string): string => hex(`evidence-${seed}`);

export type MemoryClient = { id: ClientId; name: string; token: string; compartments: string[] };

// A client of kind agent, inserted as pi_admin (the Admin is not what these tests exercise).
export async function memoryClient(
  db: TestDatabase,
  name: string,
  clearance: string[],
  options: { tools?: string[]; views?: string[]; retention?: VendorRetention; status?: "active" | "revoked" } = {},
): Promise<MemoryClient> {
  const client = {
    id: testId("cli") as ClientId,
    name,
    token: `pit_test-${name}-${testId("x")}`,
    compartments: clearance,
  };
  await queryAs(
    db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, revoked_at)
     values ($1, $2, $3, $4, $5, 'local', $6, $7, $8, case when $4 = 'revoked' then now() end)`,
    [
      client.id,
      name,
      sha256Hex(client.token),
      options.status ?? "active",
      options.retention ?? "none",
      clearance,
      options.views ?? ["self", "work"],
      options.tools ?? ["get_self", "sync_memory"],
    ],
  );
  return client;
}

// One served entry, as the store hands it to policy.serve_memory, and `evidence`, the evidence
// ids of its belief's support, which the function finds for itself.
export type Served = {
  id: string;
  fact: string;
  state: string;
  belief: string;
  evidence: string[];
  compartments: string[];
};
export const served = (seed: number, over: Partial<Served> = {}): Served => ({
  id: projectionId(seed),
  fact: hex(`fact-${seed}`),
  state: hex(`state-${seed}`),
  belief: beliefId(seed),
  evidence: [evidenceId(seed)],
  compartments: ["own"],
  ...over,
});

// `seed: false` serves the entries without writing their beliefs first.
export type Sync = {
  entries?: Served[];
  open?: string[];
  partial?: boolean;
  have?: string[];
  canDelete?: boolean;
  template?: string;
  seed?: false;
};
export type Answer = {
  kind: "served" | "remove" | "correction";
  projection_id: string;
  ended_at: Date | null;
  reason: string | null;
  current_id: string | null;
  evidence_ids: string[] | null;
};

// The function's ten values. `open` defaults to the served entries' fact keys.
export const valuesOf = (sync: Sync): unknown[] => {
  const entries = sync.entries ?? [];
  return [
    sync.template ?? TEMPLATE,
    entries.map((one) => one.id),
    entries.map((one) => one.fact),
    entries.map((one) => one.state),
    entries.map((one) => one.belief),
    JSON.stringify(entries.map((one) => one.compartments)),
    sync.open ?? entries.map((one) => one.fact),
    sync.partial ?? false,
    sync.have ?? [],
    sync.canDelete ?? true,
  ];
};

// The claim seeded on one evidence id of an entry's belief.
const supportClaim = (entry: Served, evidenceId: string): string =>
  sha256Hex(`memory claim ${entry.belief} ${evidenceId}`);

// Each entry's support, as a JSON list of lists, the serve_memory argument after the ten.
export const supportsOf = (sync: Sync): string =>
  JSON.stringify(
    (sync.entries ?? []).map((entry) => [...new Set(entry.evidence)].map((id) => supportClaim(entry, id))),
  );

// A source account for each compartment, made once for each database.
const accounts = new WeakMap<TestDatabase, Map<string, string>>();

// What the beliefs `entries` are served from rest on, for `audience`: each entry's support, one
// claim of its fact key on each of its evidence ids, which serve_memory reads its label and evidence
// from. An evidence id the vault lacks gets an evidence row of the entry's compartments; one it
// holds keeps its own label. An entry whose compartments are no label the audience can hold is
// left out: it is a refusal's case, and the function refuses it before any claim.
export async function seedBeliefs(db: TestDatabase, audience: string[], entries: Served[]): Promise<void> {
  const sorted = [...new Set(audience)].sort();
  const labelled = entries.filter(
    (one) =>
      one.compartments.length > 0 &&
      one.compartments.every((c, n) => sorted.includes(c) && (n === 0 || (one.compartments[n - 1] as string) < c)),
  );
  if (labelled.length === 0) return;
  const known = accounts.get(db) ?? new Map<string, string>();
  accounts.set(db, known);
  await session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const sealed = (compartments: string[], table: string, id: string, column: string, value: string) =>
      JSON.stringify(sealRow(db.keys, compartments[0] ?? "own", { table, id, column }, value));
    for (const entry of labelled) {
      for (const evidenceId of new Set(entry.evidence)) {
        if ((await query("select 1 from vault.evidence_items where id = $1", [evidenceId])).length === 0) {
          // An account holds one compartment; the evidence row keeps the entry's whole label.
          const first = entry.compartments[0] as string;
          const account = known.get(first) ?? (await seed.sourceAccount([first]));
          known.set(first, account);
          const blob = testId("blb");
          await query(
            "insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2::jsonb, $3)",
            [
              blob,
              sealed(
                entry.compartments,
                "vault.evidence_blobs",
                blob,
                "envelope",
                Buffer.from(`memory ${evidenceId}`).toString("base64"),
              ),
              entry.compartments,
            ],
          );
          await query(
            `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
               observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
             values ($1, $2, 'email', $3, $4, 0, $5, $6, 'message/rfc822', '2026-09-01T00:00:00Z', 'backfill', '{m-owner}', false, false, 'present', $7, '{m-owner}', $8, $9::jsonb)`,
            [
              evidenceId,
              account,
              fingerprint(db.keys, "source_id", `memory-${evidenceId}`),
              fingerprint(db.keys, "revision_tag", `h:memory-${evidenceId}`),
              `${evidenceId.slice(0, 64)}:1`,
              hashFingerprint(db.keys, "content_hash", sha256Hex(`memory ${evidenceId}`)),
              entry.compartments,
              blob,
              sealed(
                entry.compartments,
                "vault.evidence_items",
                evidenceId,
                "item_enc",
                JSON.stringify({ sourceItemId: `memory-${evidenceId}`, markers: [] }),
              ),
            ],
          );
        }
      }
      const support = [...new Set(entry.evidence)].map((evidenceId) => supportClaim(entry, evidenceId));
      for (const [n, evidenceId] of [...new Set(entry.evidence)].entries()) {
        await query(
          `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
           select $1, e.id, 'commitment', now(), $3, 1, e.readers, $4::jsonb, e.compartments from vault.evidence_items e where e.id = $2
           on conflict (id) do nothing`,
          [
            support[n],
            evidenceId,
            entry.fact,
            sealed(entry.compartments, "knowledge.claims", support[n] as string, "content_enc", "{}"),
          ],
        );
      }
    }
  });
}

// The clearance of the client a token names, or null for no client.
const clearanceOf = async (db: TestDatabase, token: string | null): Promise<string[] | null> =>
  token === null
    ? null
    : ((
        await queryAs<{ compartments: string[] }>(
          db.urls.admin,
          "select compartments from policy.clients where token_hash = $1",
          [sha256Hex(token)],
        )
      )[0]?.compartments ?? null);

// One sync as pi_reader under `token`, in a transaction of its own, which commits, after the
// beliefs it serves are written for the client's audience (unless `seed` is false). `serve`
// answers the remove and correction rows; `serveAll` the served rows too.
export const serveAll = async (db: TestDatabase, token: string | null, sync: Sync): Promise<Answer[]> => {
  const clearance = sync.seed === false ? null : await clearanceOf(db, token);
  if (clearance !== null) await seedBeliefs(db, clearance, sync.entries ?? []);
  return readAs(db, token, (query) => query<Answer>(SERVE, [...valuesOf(sync), supportsOf(sync)]));
};
export const serve = async (db: TestDatabase, token: string | null, sync: Sync): Promise<Answer[]> =>
  (await serveAll(db, token, sync)).filter((row) => row.kind !== "served");
// `values` are the ten, which pass no support, or the ten and the supports.
export const serveValues = (db: TestDatabase, token: string | null, values: unknown[]): Promise<Answer[]> =>
  readAs(db, token, (query) => query<Answer>(SERVE, values.length === 10 ? [...values, null] : values));

// The answer's two parts, as the store reads them.
export const removed = (answer: Answer[]): string[] =>
  answer.filter((row) => row.kind === "remove").map((row) => row.projection_id);
export const corrections = (
  answer: Answer[],
): { projection: string; reason: string | null; current: string | null }[] =>
  answer
    .filter((row) => row.kind === "correction")
    .map((row) => ({ projection: row.projection_id, reason: row.reason, current: row.current_id }));

export type ProjectionRow = {
  id: string;
  client_id: string;
  audience: string[];
  template: string;
  fact_key_fp: string;
  state_fp: string;
  belief_id: string | null;
  evidence_ids: string[];
  compartments: string[];
  first_served_at: Date;
  last_served_at: Date;
  ended_at: Date | null;
  reason: string | null;
  next_id: string | null;
  last_ended_at: Date | null;
  reported_present_at: Date | null;
  reported_absent_at: Date | null;
  tainted_at: Date | null;
  last_tainted_at: Date | null;
};
export type ExposureRow = {
  id: string;
  client_id: string;
  projection_id: string;
  first_served_at: Date;
  recorded_at: Date;
  retention: string;
  removal: string;
  removal_at: Date | null;
  first_removal: string | null;
  first_removal_at: Date | null;
  compartments: string[];
};

export const projectionsOf = (db: TestDatabase, client: { id: string }): Promise<ProjectionRow[]> =>
  queryAs<ProjectionRow>(
    db.urls.admin,
    'select * from ledger.memory_projections where client_id = $1 order by id collate "C"',
    [client.id],
  );
export const projectionOf = async (db: TestDatabase, id: string): Promise<ProjectionRow> => {
  const [row] = await queryAs<ProjectionRow>(db.urls.admin, "select * from ledger.memory_projections where id = $1", [
    id,
  ]);
  if (row === undefined) throw new Error(`no projection row ${id}`);
  return row;
};
export const exposuresOf = (db: TestDatabase, client: { id: string }): Promise<ExposureRow[]> =>
  queryAs<ExposureRow>(
    db.urls.admin,
    "select id::text as id, client_id, projection_id, first_served_at, recorded_at, retention, removal, removal_at, first_removal, first_removal_at, compartments from ledger.memory_exposures where client_id = $1 order by memory_exposures.id",
    [client.id],
  );

// What a deletion does: ledger.taint_citing as the writer calls it, with the deleted evidence ids.
export const taint = async (db: TestDatabase, evidence: string[]): Promise<number> => {
  const [row] = await queryAs<{ n: number }>(
    db.urls.writer,
    "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[]) as n",
    [evidence],
  );
  return row?.n ?? -1;
};

// The clock a read of these commitments runs at: the day after their mail, before their due date. A
// commitment more than 14 days past its date is not open at read (commitment-lapse.ts), so a read on the
// wall clock would serve none of these once the date had gone by.
export const MEMORY_FIXTURE_NOW = new Date("2026-09-03T12:00:00Z");

// A message from `from` to the owner, stored through the writer, a commitment of the sender's
// to the owner on it, committed through the Pipeline, and the beliefs of each audience given:
// what a deletion or an erasure of that message must take out of every projection. A rebuild
// replaces an audience's beliefs whole, so the commitments in `keep` are written again with it.
export type MailCommitment = {
  fixture: MailFixture;
  message: { id: MessageId; evidence: string };
  sender: EntityId;
  fact: string;
  spec: CommitmentSpec;
  records: Records;
};
export async function commitmentOnMail(
  store: TestStore,
  account: SourceAccountRow,
  owner: string,
  id: string,
  options: {
    from?: Who;
    compartment?: string;
    due?: string;
    at?: string;
    // Kept for the callers' shape: every belief is computed when asked, so nothing is written for
    // an audience or kept for one.
    audiences?: string[][];
    keep?: MailCommitment[];
  } = {},
): Promise<MailCommitment> {
  const from = options.from ?? QUENTIN;
  const fixture = mail({
    id,
    threadId: `thread-${id}`,
    at: options.at ?? "2026-09-02T09:00:00Z",
    from,
    to: [{ address: OWNER.personal, name: OWNER.name }],
    subject: `canary-${id}`,
    labels: ["INBOX"],
  });
  await ingestMail(store.writer, account, fixture);
  const [row] = await queryAs<{ id: string; evidence_id: string; sent_at: Date }>(
    store.db.urls.admin,
    "select m.id, m.evidence_id, m.sent_at from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
    [account.id, fingerprint(store.db.keys, "source_id", mailSourceId(fixture))],
  );
  if (row === undefined) throw new Error(`message ${id} was not stored`);
  const [sender] = await queryAs<{ entity_id: string }>(
    store.db.urls.admin,
    "select distinct entity_id from knowledge.accounts where value_fp = $1",
    [fingerprint(store.db.keys, "address", from.address)],
  );
  if (sender === undefined) throw new Error(`no person for message ${id}`);
  const compartment = options.compartment ?? "own";
  const spec: CommitmentSpec = {
    key: `k-${id}`,
    subject: sender.entity_id,
    counterparty: owner,
    due: options.due ?? "2026-09-20",
    claims: [
      {
        message: { id: row.id, evidenceId: row.evidence_id, sentAt: row.sent_at.toISOString(), compartment },
        what: `canary-${id}-what`,
      },
    ],
  };
  const records = await commitClaims(store, owner, [spec]);
  return {
    fixture,
    message: { id: row.id as MessageId, evidence: row.evidence_id },
    sender: sender.entity_id as EntityId,
    fact: fingerprint(store.db.keys, "fact", spec.key),
    spec,
    records,
  };
}
