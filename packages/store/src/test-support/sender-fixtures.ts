import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { GateCheckKind } from "@intelligence/contracts";
import { DECISION_POINT_PINS, type SendPayload } from "@intelligence/contracts/personal";
import { sendGate } from "@intelligence/personal-core/outbound";
import { type DraftValues, draftValues } from "../agent-writes/draft-values.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { journalPath } from "../core/journal.ts";
import { forSending, type Keys, loadKeys, narrowKeyFile } from "../core/keys.ts";
import { sealRow, sealUnder } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createSender } from "../send/sender.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { type Accounts, connect } from "./cast.ts";
import { ALL_TOOLS, insertSecret, testId } from "./clients.ts";
import { one, readAs, session } from "./connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "./database.ts";
import type { MailFixture } from "./items.ts";
import { batchOf, claimRecord, stored } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";
import { insertWorkClient, type WorkClient } from "./work-clients.ts";

// The world `pi send`'s tests run on: the owner's two labels, `personal` under `own` and connected
// for reading, `work` under `employer:example`; a key file that holds `own`, `public`,
// `employer:example` and two `agent:` keys; and the copy of it the wrapper hands `pi send`,
// narrowed to the fingerprint key, `own` and the `agent:` keys. Drafts are seeded as `pi mcp` would
// store them, through `ledger.append_draft` and `ledger.append_gate_decision` as `pi_reader`, so no
// client is needed. Reserved domains only.

export { OWNER } from "./cast.ts";

export const SEND_COMPARTMENTS = ["own", "public", "employer:example", "agent:jev", "agent:luna"] as const;

export type SendWorld = {
  db: TestDatabase;
  writer: Writer;
  accounts: Accounts;
  // The narrowed copy, and its keys: what `pi send` is handed.
  sendKeyFile: string;
  sendKeys: Keys;
  close(): Promise<void>;
};

export async function sendWorld(): Promise<SendWorld> {
  const db = await createTestDatabase({ compartments: [...SEND_COMPARTMENTS] });
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: recordingLogger().log });
  const accounts = await connect(writer);
  // `personal` is connected for reading; `work` is not, so a send secret of its would be orphaned.
  await insertSecret(db, "google/personal/client", "{}");
  await insertSecret(db, "google/personal/refresh_token", "read-refresh-token");
  const sendKeyFile = join(dirname(db.keyFile), `send-keys-${randomBytes(4).toString("hex")}.json`);
  await narrowKeyFile(db.keyFile, sendKeyFile, forSending);
  return {
    db,
    writer,
    accounts,
    sendKeyFile,
    sendKeys: await loadKeys(sendKeyFile),
    async close() {
      await writer.close();
      await db.drop();
    },
  };
}

// A statement as the superuser would run it. No test can connect as one (docker-compose.yml)
// and the bootstrap holds no privilege on the schemas, so this is one pi_owner transaction,
// through the bootstrap's membership, that gives pi_owner a policy on `table` for the
// statement and drops it again, as send-fixtures.ts's `age` does. `table` null adds none.
export async function asSuperuser<Row = Record<string, unknown>>(
  db: TestDatabase,
  table: string | null,
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  return session(db.urls.bootstrap, async (query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      if (table !== null)
        await query(`create policy zz_test_superuser on ${table} for all to pi_owner using (true) with check (true)`);
      const rows = await query<Row>(text, values);
      if (table !== null) await query(`drop policy zz_test_superuser on ${table}`);
      await query("commit");
      return rows;
    } catch (error) {
      await query("rollback");
      throw error;
    }
  });
}

// The account's last sync, as the superuser: `minutes` ago, with `outcome`.
export const synced = (world: SendWorld, accountId: string, minutes = 0, outcome = "ok"): Promise<unknown> =>
  asSuperuser(
    world.db,
    "vault.source_accounts",
    "update vault.source_accounts set last_sync_at = now() - make_interval(mins => $2::int), last_outcome = $3 where id = $1",
    [accountId, minutes, outcome],
  );

// A send secret for a label, sealed under `own` as every secret is, written as `pi_proxy`.
export const sendSecretName = (label: string): string => `google-send/${label}`;
export const connectSend = (world: SendWorld, label = "personal"): Promise<unknown> =>
  queryAs(world.db.urls.proxy, "insert into policy.secrets (name, value_enc) values ($1, $2)", [
    sendSecretName(label),
    sealRow(
      world.db.keys,
      "own",
      { table: "policy.secrets", id: sendSecretName(label), column: "value_enc" },
      JSON.stringify({ clientId: "send-client", clientSecret: "send-secret", refreshToken: "send-refresh-token" }),
    ),
  ]);

// A client that drafts, with one session opened, as pi mcp opens one.
export const draftingClient = (
  world: SendWorld,
  name: string,
  compartments: string[] = ["own"],
  tools: readonly string[] = [...ALL_TOOLS, "draft_message"],
): Promise<WorkClient> => insertWorkClient(world.db, name, compartments, { tools });

export const RECIPIENT = "solo@one-message.test";

export type SeededDraft = { id: string; payload: SendPayload; values: DraftValues; code: string; label: string[] };

export type DraftOptions = Partial<Pick<SendPayload, "to" | "cc" | "subject" | "body" | "thread">> & {
  account?: Accounts["personalMail"];
  replyTo?: string;
  opportunity?: string;
  basis?: { kind: string; id: string }[];
  // How the phase-draft gate answers disclosure: `held` stores the draft held by it alone.
  disclosure?: "clear" | "held";
};

const label = (compartments: string[]): string[] => [...new Set(compartments)].sort();

// One draft, stored as `pi mcp` stores it: its payload sealed under the client's label, its four
// values made by `draftValues`, `append_draft`, then the gate at phase draft and its decision.
export async function seedDraft(
  world: SendWorld,
  client: WorkClient,
  options: DraftOptions = {},
): Promise<SeededDraft> {
  const account = options.account ?? world.accounts.personalMail;
  const payload: SendPayload = {
    v: 1,
    account: account.id as SendPayload["account"],
    to: options.to ?? [RECIPIENT],
    cc: options.cc ?? [],
    subject: options.subject ?? "A note about Thursday",
    body: options.body ?? "Shall we meet on Thursday?\nBest",
    thread: options.thread ?? null,
  };
  const values = await draftValues(world.db.keys, payload);
  const id = testId("drf");
  const compartments = label(client.compartments);
  const body = sealUnder(
    world.db.keys,
    compartments,
    { table: "ledger.drafts", id, column: "body_enc" },
    JSON.stringify(payload),
  );
  const basis = options.basis ?? [];
  await readAs(world.db, client.token, (query) =>
    query(
      `select ledger.append_draft($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10, $11::jsonb, $12::text[], $13::text[])`,
      [
        id,
        `req-${randomBytes(6).toString("hex")}`,
        client.session,
        options.opportunity ?? null,
        options.replyTo ?? null,
        account.label,
        values.recipientFps,
        values.recipientDomainFps,
        values.payloadFp,
        values.bodyFp,
        JSON.stringify(body),
        basis.map((ref) => ref.kind),
        basis.map((ref) => ref.id),
      ],
    ),
  );
  await gateAtDraft(world, client, id, values.payloadFp, options.disclosure ?? "clear");
  return { id, payload, values, code: values.payloadFp.slice(0, 8), label: compartments };
}

// The gate at phase draft, as `pi mcp` runs it, with disclosure answered as the test says.
async function gateAtDraft(
  world: SendWorld,
  client: WorkClient,
  draft: string,
  fp: string,
  disclosure: "clear" | "held",
): Promise<void> {
  await readAs(world.db, client.token, async (query) => {
    const facts = one(await query<{ facts: unknown }>("select ledger.gate_facts($1, 'draft') as facts", [draft])).facts;
    const outcome = sendGate({
      phase: "draft",
      facts: facts as never,
      revealed: disclosure === "held" ? 1 : 0,
      released: 0,
      computedFp: fp,
      storedFp: fp,
    });
    const checks = GateCheckKind.options.map((kind) => ({ kind, passed: outcome.checks[kind] }));
    await query("select ledger.append_gate_decision($1, $2, 'draft', $3, $4::jsonb, null, 1, $5)", [
      testId("gdc"),
      draft,
      fp,
      JSON.stringify(checks),
      DECISION_POINT_PINS["draft_disclosure@1"],
    ]);
  });
}

// The latest event of a draft or a send, as pi_admin.
export async function latestEvent(world: SendWorld, kind: "draft" | "send", id: string): Promise<string | null> {
  const [row] = await queryAs<{ event: string }>(
    world.db.urls.admin,
    "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
    [kind, id],
  );
  return row?.event ?? null;
}

// What sending writes, counted as pi_admin: decisions of the two send kinds, send rows, gate rows
// of phase send, and the events of drafts and sends.
export async function sendCounts(
  world: SendWorld,
): Promise<{ decisions: number; sends: number; gateRows: number; events: number }> {
  const count = async (sql: string): Promise<number> => one(await queryAs<{ n: number }>(world.db.urls.admin, sql)).n;
  return {
    decisions: await count(
      "select count(*)::int as n from knowledge.owner_decisions where kind in ('send', 'send_settle')",
    ),
    sends: await count("select count(*)::int as n from ledger.sent_messages"),
    gateRows: await count("select count(*)::int as n from ledger.gate_checks where phase = 'send'"),
    events: await count("select count(*)::int as n from ledger.record_events where row_kind in ('draft', 'send')"),
  };
}

// A use-only claim (disclosure third_party) of a message the canary person wrote to the owner,
// with Quentin on Cc, whose text value is `text`: a draft to anyone else that repeats it reveals it.
export async function useOnlyClaim(
  world: SendWorld,
  fixture: MailFixture,
  text: string,
  options: { n?: number; work?: boolean } = {},
): Promise<string> {
  const account = options.work === true ? world.accounts.workMail : world.accounts.personalMail;
  const evidenceId = await stored(world.writer, account, fixture);
  const owner = one(
    await queryAs<{ id: string }>(world.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  const record = claimRecord(evidenceId, account.compartment, owner, { n: options.n ?? 1 });
  const claim = {
    ...record,
    disclosure: ["third_party"],
    claim: { ...record.claim, content: { ...record.claim.content, fields: { what: text } } },
  };
  const pipeline = createPipeline({ url: world.db.urls.pipeline, keys: world.db.keys, log: recordingLogger().log });
  try {
    await pipeline.commit(batchOf(evidenceId, [claim as never]));
  } finally {
    await pipeline.close();
  }
  // The store keeps a claim under the fingerprint of the id its record carries (pipeline-write.ts).
  return fingerprint(world.db.keys, "claim", (claim.claim as { id: string }).id);
}

// The store's Sender as `pi send` makes it: the proxy's URL, the narrowed keys, and the journal's
// path derived from the narrowed copy's.
export const senderOf = (world: SendWorld, url = world.db.urls.proxy) =>
  createSender({ url, keys: world.sendKeys, log: recordingLogger().log, journal: journalPath(world.sendKeyFile) });

// The id of the stored message of an evidence row, as pi_admin.
export const messageOf = async (world: SendWorld, evidenceId: string): Promise<string> =>
  one(
    await queryAs<{ id: string }>(world.db.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
      evidenceId,
    ]),
  ).id;

// Ages a row's time column, as the superuser.
export const aged = (
  world: SendWorld,
  table: "ledger.drafts" | "ledger.sent_messages",
  column: "created_at" | "begun_at" | "sent_at",
  id: string,
  minutes: number,
): Promise<unknown> =>
  asSuperuser(
    world.db,
    table,
    `update ${table} set ${column} = ${column} - make_interval(mins => $2::int) where id = $1`,
    [id, minutes],
  );
