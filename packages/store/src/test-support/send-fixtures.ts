import { randomBytes } from "node:crypto";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { GateFacts } from "@intelligence/contracts/personal";
import { gmailItemId } from "@intelligence/personal-core";
import pg from "pg";
import { sealUnder } from "../core/seal.ts";
import { ALL_TOOLS, sha256Hex, testId } from "./clients.ts";
import { one, type Query, readAs, session } from "./connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "./database.ts";
import { withDatabase } from "./store.ts";
import { AGENT_WORK_TOOLS, insertWorkClient, type WorkClient } from "./work-clients.ts";

// Every row a test needs is written in SQL as pi_admin, through the owner surface's and durable
// work's functions, or as pi_work; drafts and the phase-draft gate as pi_reader under a client's
// token; the send functions as pi_proxy; sent_tag as pi_writer. Reserved domains only.

export const TIMEOUT = 300_000;
export const OWN = ["own"];
export const HASH = sha256Hex("send functions test definition");
export const GATE_KINDS = [
  "authority",
  "vetoes",
  "conflict_lists",
  "contact_policy",
  "disclosure",
  "freshness",
  "consent",
  "channel_cap",
  "payload_hash",
] as const;
export type GateKind = (typeof GATE_KINDS)[number];
export const SEND_TOOLS = [...ALL_TOOLS, "find_messages", "read_message", "draft_message", ...AGENT_WORK_TOOLS];

export const hex = (): string => randomBytes(32).toString("hex");
export const labelOf = (compartments: readonly string[]): string[] => [...new Set(compartments)].sort();

export type Account = {
  id: string;
  label: string;
  address: string;
  compartments: string[];
};

// What every helper needs: a database, a pi_admin connection, the drafting client and its account.
export type SendCtx = {
  db: TestDatabase;
  admin: Query;
  client: WorkClient;
  account: Account;
};

// A recipient: an address on a reserved domain, its address and domain fingerprints.
export type Recipient = { address: string; fp: string; domainFp: string };
export function recipient(db: TestDatabase, address: string): Recipient {
  const domain = address.slice(address.indexOf("@") + 1);
  return {
    address,
    fp: fingerprint(db.keys, "address", address),
    domainFp: fingerprint(db.keys, "domain", domain),
  };
}

// A google_mail source account of the owner's, under `compartments`.
export async function insertAccount(
  db: TestDatabase,
  admin: Query,
  label: string,
  compartments: string[] = OWN,
): Promise<Account> {
  const id = testId("acc");
  const address = `owner-${label}@send-home.test`;
  await admin(
    `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
     values ($1, $2, 'google_mail', 'email', $3, $4, $5)`,
    [
      id,
      label,
      compartments,
      fingerprint(db.keys, "address", address),
      sealRow(
        db.keys,
        compartments[0] ?? "own",
        { table: "vault.source_accounts", id, column: "address_enc" },
        address,
      ),
    ],
  );
  return { id, label, address, compartments };
}

export async function insertSendClient(
  db: TestDatabase,
  name: string,
  compartments: string[] = OWN,
  options: { tools?: readonly string[]; views?: readonly string[] } = {},
): Promise<WorkClient> {
  return insertWorkClient(db, name, compartments, {
    kind: "agent",
    tools: options.tools ?? SEND_TOOLS,
    ...(options.views === undefined ? {} : { views: options.views }),
  });
}

// A database with one client under `own` that holds draft_message and the work view, and one
// own mail account labelled `home`.
export async function withSendWorld<T>(
  fn: (w: SendCtx) => Promise<T>,
  options: { clientCompartments?: string[]; keyCompartments?: string[] } = {},
): Promise<T> {
  return withDatabase(
    (db) =>
      session(db.urls.admin, async (admin) => {
        const account = await insertAccount(db, admin, "home");
        const client = await insertSendClient(db, "drafter", options.clientCompartments ?? OWN);
        return fn({ db, admin, client, account });
      }),
    {
      compartments: options.keyCompartments ?? ["own", "employer:example", "agent:drafter", "agent:other"],
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Stored mail, written as pi_admin with every column the send functions read under control
// ---------------------------------------------------------------------------------------------

export type Stored = {
  id: string;
  evidence: string;
  sourceItemId: string;
  sourceItemFp: string;
  threadFp: string | null;
  observedAt: string;
};
let serial = 0;

export type MessageOptions = {
  account?: Account;
  thread?: string | null;
  at?: string;
  direction?: "inbound" | "outbound";
  from?: string;
  to?: string[];
  held?: boolean;
  compartments?: string[];
  messageId?: string;
  systemOriginated?: boolean;
  answersSystem?: boolean;
  sentId?: string | null;
  // For an outbound message: the body fingerprint its interaction row carries.
  bodyFp?: string;
  sourceItemId?: string;
};

export async function insertMessage(
  w: Pick<SendCtx, "db" | "admin" | "account">,
  options: MessageOptions = {},
): Promise<Stored> {
  serial += 1;
  const { db, admin } = w;
  const account = options.account ?? w.account;
  const compartments = options.compartments ?? account.compartments;
  const at = options.at ?? new Date(Date.now() - 3_600_000).toISOString();
  const direction = options.direction ?? "inbound";
  const sourceItemId = options.sourceItemId ?? gmailItemId(`send-test-${serial}-${randomBytes(4).toString("hex")}`);
  const thread =
    options.thread === undefined ? `thread-send-${serial}-${randomBytes(3).toString("hex")}` : options.thread;
  const threadFp = thread === null ? null : fingerprint(db.keys, "thread", thread);
  const from = options.from ?? (direction === "outbound" ? account.address : `sender-${serial}@send-example.test`);
  const id = evidenceIdFor({
    vault: "personal",
    sourceAccount: account.id as never,
    sourceItemId,
    revision: 0,
  });
  const blob = testId("blb");
  const seal = (table: string, rowId: string, column: string, value: string) =>
    sealRow(db.keys, compartments[0] ?? "own", { table, id: rowId, column }, value);
  await admin("insert into vault.evidence_blobs (blob_ref, compartments, envelope) values ($1, $2, $3)", [
    blob,
    compartments,
    seal("vault.evidence_blobs", blob, "envelope", Buffer.from(`payload ${serial}`).toString("base64")),
  ]);
  await admin(
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, thread_fp, content_hash,
       media_type, observed_at, change_kind, participant_members, sender_member, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc, sent_id)
     values ($1, $2, 'email', $3, $4, 0, $5, $6, $7, 'message/rfc822', $8, 'live', '{m-owner}', $9, $10, $11, 'present', $12, '{m-owner}', $13, $14, $15)`,
    [
      id,
      account.id,
      fingerprint(db.keys, "source_id", sourceItemId),
      fingerprint(db.keys, "revision_tag", `h:${sourceItemId}`),
      evidenceIdFor({
        vault: "personal",
        sourceAccount: account.id as never,
        sourceItemId,
        revision: 1,
      }),
      threadFp,
      sha256Hex(`content ${serial}`),
      at,
      direction === "outbound" ? "m-owner" : null,
      options.systemOriginated ?? false,
      options.answersSystem ?? false,
      compartments,
      blob,
      seal("vault.evidence_items", id, "item_enc", JSON.stringify({ sourceItemId, markers: [] })),
      options.sentId ?? null,
    ],
  );
  const messageId = testId("msg");
  const domain = from.slice(from.indexOf("@") + 1);
  const facts = {
    chars: 10,
    unreadable: false,
    attachments: [],
    messageId: options.messageId ?? `mid-${serial}@send-example.test`,
  };
  await admin(
    `insert into knowledge.messages (id, evidence_id, sent_at, direction, bulk, category, held, thread_fp, sender_fp, sender_domain_fp, compartments,
       subject_enc, thread_id_enc, sender_enc, body_enc, facts_enc)
     values ($1, $2, $3, $4, false, 'primary', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      messageId,
      id,
      at,
      direction,
      options.held ?? false,
      threadFp,
      fingerprint(db.keys, "address", from),
      fingerprint(db.keys, "domain", domain),
      compartments,
      seal("knowledge.messages", messageId, "subject_enc", `Subject ${serial}`),
      thread === null ? null : seal("knowledge.messages", messageId, "thread_id_enc", thread),
      seal("knowledge.messages", messageId, "sender_enc", from),
      seal("knowledge.messages", messageId, "body_enc", `Body ${serial}`),
      seal("knowledge.messages", messageId, "facts_enc", JSON.stringify(facts)),
    ],
  );
  if (direction === "outbound") {
    for (const address of options.to ?? []) {
      await admin(
        "insert into vault.sent_recipients (evidence_id, address_fp, account_id, compartments) values ($1, $2, $3, $4)",
        [id, fingerprint(db.keys, "address", address), account.id, compartments],
      );
    }
    if (options.bodyFp !== undefined) {
      const entity = testId("ent");
      await admin("insert into knowledge.entities (id, kind) values ($1, 'person')", [entity]);
      await admin(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, body_hash, entity_role, compartments, readers)
         values ($1, $2, 'm-owner', $3, 'outbound', 'email', $4, $5, 'recipient', $6, '{m-owner}')`,
        [testId("itx"), id, entity, at, options.bodyFp, compartments],
      );
    }
  }
  return {
    id: messageId,
    evidence: id,
    sourceItemId,
    sourceItemFp: fingerprint(db.keys, "source_id", sourceItemId),
    threadFp,
    observedAt: at,
  };
}

// A person the store knows by an address: an entity and an account row.
export async function insertPerson(
  w: Pick<SendCtx, "db" | "admin">,
  address: string,
  compartments: string[] = OWN,
): Promise<string> {
  const entity = testId("ent");
  const id = testId("adr");
  const r = recipient(w.db, address);
  await w.admin("insert into knowledge.entities (id, kind) values ($1, 'person')", [entity]);
  await w.admin(
    "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
    [
      id,
      entity,
      r.fp,
      r.domainFp,
      sealRow(w.db.keys, compartments[0] ?? "own", { table: "knowledge.accounts", id, column: "value_enc" }, address),
      compartments,
    ],
  );
  return entity;
}

// An interaction row tying a person to a stored message.
export const insertInteraction = (
  w: Pick<SendCtx, "admin">,
  evidence: string,
  entity: string,
  direction: "inbound" | "outbound" = "inbound",
): Promise<unknown> =>
  w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
     values ($1, $2, 'm-owner', $3, $4, 'email', now(), 'sender', '{own}', '{m-owner}')`,
    [testId("itx"), evidence, entity, direction],
  );

// The owner has written to each address from the account, so none is a first contact.
export async function knownTo(
  w: Pick<SendCtx, "db" | "admin" | "account">,
  addresses: string[],
  account?: Account,
): Promise<Stored> {
  return insertMessage(w, {
    direction: "outbound",
    to: addresses,
    at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    ...(account === undefined ? {} : { account }),
  });
}

// The source deletes a message: its message row, its pipeline row and its evidence row.
export async function deleteMessage(w: Pick<SendCtx, "admin">, message: Stored): Promise<void> {
  await w.admin("delete from knowledge.messages where id = $1", [message.id]);
  await w.admin("delete from knowledge.interaction_log where evidence_id = $1", [message.evidence]);
  await w.admin("delete from vault.sent_recipients where evidence_id = $1", [message.evidence]);
  await w.admin("delete from vault.pipeline_items where evidence_id = $1", [message.evidence]);
  await w.admin("delete from vault.evidence_items where id = $1", [message.evidence]);
}

// What read_message logs for a message it served: its evidence id under `bound`.
export const logRead = (w: SendCtx, message: Stored, sessionId = w.client.session): Promise<unknown> =>
  readAs(w.db, w.client.token, (query) =>
    query("select policy.log_read($1, 'read_message', $2::text[], '{}', '{}')", [sessionId, [message.evidence]]),
  );

// ---------------------------------------------------------------------------------------------
// Drafts and the phase-draft gate, as pi_reader under the client's token
// ---------------------------------------------------------------------------------------------

export type DraftArgs = {
  id: string;
  requestId: string;
  session: string | null;
  opportunity: string | null;
  replyTo: string | null;
  accountLabel: string | null;
  to: string[];
  recipientFps: string[];
  domainFps: string[];
  payloadFp: string;
  bodyFp: string;
  body: unknown;
  refKinds: string[];
  refIds: string[];
};

export function draftArgs(
  w: SendCtx,
  options: Partial<Omit<DraftArgs, "recipientFps" | "domainFps">> & {
    to?: string[];
    refs?: readonly (readonly [string, string])[];
  } = {},
): DraftArgs {
  const id = options.id ?? testId("drf");
  const to = options.to ?? ["rowan@send-example.test"];
  const replyTo = options.replyTo ?? null;
  return {
    id,
    requestId: options.requestId ?? testId("req"),
    session: options.session === undefined ? w.client.session : options.session,
    opportunity: options.opportunity ?? null,
    replyTo,
    accountLabel:
      options.accountLabel === undefined ? (replyTo === null ? w.account.label : null) : options.accountLabel,
    to,
    recipientFps: to.map((address) => recipient(w.db, address).fp),
    domainFps: to.map((address) => recipient(w.db, address).domainFp),
    payloadFp: options.payloadFp ?? hex(),
    bodyFp: options.bodyFp ?? hex(),
    body:
      options.body ??
      sealUnder(
        w.db.keys,
        labelOf(w.client.compartments),
        { table: "ledger.drafts", id, column: "body_enc" },
        JSON.stringify({ v: 1, body: "a draft" }),
      ),
    refKinds: (options.refs ?? []).map(([kind]) => kind),
    refIds: (options.refs ?? []).map(([, ref]) => ref),
  };
}

const APPEND_DRAFT =
  "select ledger.append_draft($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text[], $8::text[], $9::text, $10::text, $11::jsonb, $12::text[], $13::text[]) as answer";
export const appendDraftWith = async (query: Query, a: DraftArgs): Promise<string | null> =>
  one(
    await query<{ answer: string | null }>(APPEND_DRAFT, [
      a.id,
      a.requestId,
      a.session,
      a.opportunity,
      a.replyTo,
      a.accountLabel,
      a.recipientFps,
      a.domainFps,
      a.payloadFp,
      a.bodyFp,
      JSON.stringify(a.body),
      a.refKinds,
      a.refIds,
    ]),
  ).answer;

// The call as the client, its answer: the draft's id or `rate_limited`.
export const appendDraft = (w: SendCtx, a: DraftArgs, client: { token: string } = w.client): Promise<string | null> =>
  readAs(w.db, client.token, (query) => appendDraftWith(query, a));

export const checksJson = (failed: readonly string[] = []): string =>
  JSON.stringify(GATE_KINDS.map((kind) => ({ kind, passed: !failed.includes(kind) })));

const APPEND_GATE =
  "select ledger.append_gate_decision($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::integer, $8::text)";
export const appendGateWith = (
  query: Query,
  decision: string,
  draft: string,
  phase: "draft" | "send",
  payloadFp: string,
  checks: string,
  facts: unknown,
): Promise<unknown> =>
  query(APPEND_GATE, [
    decision,
    draft,
    phase,
    payloadFp,
    checks,
    facts === null ? null : JSON.stringify(facts),
    1,
    HASH,
  ]);

// The phase-draft gate as pi mcp runs it: nine rows, those named false.
export async function gateDraft(
  w: SendCtx,
  draft: string,
  payloadFp: string,
  failed: readonly string[] = [],
  client: { token: string } = w.client,
): Promise<string> {
  const decision = testId("gdc");
  await readAs(w.db, client.token, (query) =>
    appendGateWith(query, decision, draft, "draft", payloadFp, checksJson(failed), null),
  );
  return decision;
}

// A draft made and gated: `made` unless a check is named false.
export async function madeDraft(
  w: SendCtx,
  options: Parameters<typeof draftArgs>[1] = {},
  failed: readonly string[] = [],
): Promise<DraftArgs & { decision: string }> {
  const a = draftArgs(w, options);
  const id = await appendDraft(w, a);
  if (id !== a.id) throw new Error(`the prepared draft was not stored: ${id}`);
  return { ...a, decision: await gateDraft(w, a.id, a.payloadFp, failed) };
}

export const factsAsReader = async (w: SendCtx, draft: string, phase: "draft" | "send" = "draft"): Promise<GateFacts> =>
  GateFacts.parse(
    one(
      await readAs(w.db, w.client.token, (query) =>
        query<{ facts: unknown }>("select ledger.gate_facts($1::text, $2::text) as facts", [draft, phase]),
      ),
    ).facts,
  );
// Drafts' facts as pi_reader, in one transaction: every one is read at the same now(), so a
// fact counted from the clock, such as syncAgeSeconds, is the same for each.
export const factsTextsAsReader = (w: SendCtx, drafts: string[]): Promise<string[]> =>
  readAs(w.db, w.client.token, async (query) => {
    const texts: string[] = [];
    for (const draft of drafts)
      texts.push(
        one(await query<{ facts: string }>("select ledger.gate_facts($1::text, 'draft')::text as facts", [draft]))
          .facts,
      );
    return texts;
  });
export const factsTextAsReader = async (w: SendCtx, draft: string): Promise<string> =>
  (await factsTextsAsReader(w, [draft]))[0] ?? "";
export const factsAsProxy = async (
  w: Pick<SendCtx, "db">,
  draft: string,
  phase: "draft" | "send" = "send",
): Promise<GateFacts> =>
  GateFacts.parse(
    one(
      await queryAs<{ facts: unknown }>(w.db.urls.proxy, "select ledger.gate_facts($1::text, $2::text) as facts", [
        draft,
        phase,
      ]),
    ).facts,
  );

// ---------------------------------------------------------------------------------------------
// The account's sending setup
// ---------------------------------------------------------------------------------------------

// A send secret, written by pi_proxy (the only role that may), beside a read secret.
export async function connectForSend(
  w: Pick<SendCtx, "db" | "admin">,
  account: Account,
  options: { read?: boolean } = {},
): Promise<void> {
  const name = `google-send/${account.label}`;
  await queryAs(
    w.db.urls.proxy,
    "insert into policy.secrets (name, value_enc) values ($1, $2) on conflict (name) do nothing",
    [
      name,
      sealRow(
        w.db.keys,
        "own",
        { table: "policy.secrets", id: name, column: "value_enc" },
        JSON.stringify({ clientId: "c", clientSecret: "s", refreshToken: "r" }),
      ),
    ],
  );
  if (options.read !== false) {
    const read = `google/${account.label}/refresh_token`;
    await w.admin("insert into policy.secrets (name, value_enc) values ($1, $2) on conflict (name) do nothing", [
      read,
      sealRow(w.db.keys, "own", { table: "policy.secrets", id: read, column: "value_enc" }, "a read refresh token"),
    ]);
  }
}

export const syncedAt = (
  w: Pick<SendCtx, "admin">,
  account: Account,
  secondsAgo: number,
  outcome: string | null = "ok",
): Promise<unknown> =>
  w.admin(
    "update vault.source_accounts set last_sync_at = now() - make_interval(secs => $2::double precision), last_outcome = $3 where id = $1",
    [account.id, secondsAgo, outcome],
  );

// A table's time column moved back, as the superuser would: one pi_owner transaction that gives
// itself an update policy for the statement and drops it again.
export async function age(
  db: TestDatabase,
  table: string,
  column: string,
  where: string,
  values: unknown[],
  seconds: number,
): Promise<void> {
  await session(db.urls.bootstrap, async (query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      await query(`create policy zz_test_age on ${table} for update to pi_owner using (true) with check (true)`);
      const n = values.length;
      await query(
        `update ${table} set ${column} = ${column} - make_interval(secs => $${n + 1}::double precision) where ${where}`,
        [...values, seconds],
      );
      await query(`drop policy zz_test_age on ${table}`);
      await query("commit");
    } catch (error) {
      await query("rollback");
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The send, as pi_proxy
// ---------------------------------------------------------------------------------------------

export const proxy = <Row = Record<string, unknown>>(
  db: TestDatabase,
  text: string,
  values?: unknown[],
): Promise<Row[]> => queryAs<Row>(db.urls.proxy, text, values);

// The phase-send gate as pi send runs it: the facts as they stand, nine rows, those named false.
export async function gateSend(
  w: Pick<SendCtx, "db">,
  draft: string,
  payloadFp: string,
  failed: readonly string[] = [],
  facts?: unknown,
): Promise<string> {
  const decision = testId("gdc");
  const stood =
    facts ??
    one(await proxy<{ facts: unknown }>(w.db, "select ledger.gate_facts($1::text, 'send') as facts", [draft])).facts;
  await session(w.db.urls.proxy, (query) =>
    appendGateWith(query, decision, draft, "send", payloadFp, checksJson(failed), stood),
  );
  return decision;
}

export type BeginArgs = {
  send: string;
  ruling: string;
  draft: string;
  decision: string;
  payloadFp: string;
  requestId: string;
  firstContact: boolean;
  newThread: boolean;
  released: string[];
  point: string;
};
export const beginArgs = (
  draft: { id: string; payloadFp: string },
  decision: string,
  more: Partial<BeginArgs> = {},
): BeginArgs => ({
  send: testId("snt"),
  ruling: testId("rul"),
  draft: draft.id,
  decision,
  payloadFp: draft.payloadFp,
  requestId: testId("req"),
  firstContact: false,
  newThread: false,
  released: [],
  point: "send_clear",
  ...more,
});
const BEGIN =
  "select ledger.begin_send($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::boolean, $8::boolean, $9::text[], $10::text, $11::integer, $12::text) as id";
export const beginWith = async (query: Query, a: BeginArgs): Promise<string | null> =>
  one(
    await query<{ id: string | null }>(BEGIN, [
      a.send,
      a.ruling,
      a.draft,
      a.decision,
      a.payloadFp,
      a.requestId,
      a.firstContact,
      a.newThread,
      a.released,
      a.point,
      1,
      HASH,
    ]),
  ).id;
export const begin = (w: Pick<SendCtx, "db">, a: BeginArgs): Promise<string | null> =>
  session(w.db.urls.proxy, (query) => beginWith(query, a));

export const finish = async (
  w: Pick<SendCtx, "db">,
  send: string,
  outcome: "sent" | "failed" | "unknown",
  more: {
    status?: number | null;
    sourceFp?: string | null;
    threadFp?: string | null;
  } = {},
): Promise<boolean> =>
  one(
    await proxy<{ done: boolean }>(
      w.db,
      "select ledger.finish_send($1::text, $2::text, $3::integer, $4::text, $5::text) as done",
      [
        send,
        outcome,
        more.status ?? (outcome === "failed" ? 400 : outcome === "sent" ? 200 : null),
        more.sourceFp === undefined ? (outcome === "sent" ? hex() : null) : more.sourceFp,
        more.threadFp === undefined ? null : more.threadFp,
      ],
    ),
  ).done;

export const settle = async (
  w: Pick<SendCtx, "db">,
  send: string,
  answer: "sent" | "not_sent",
  requestId = testId("req"),
  ruling = testId("rul"),
): Promise<string> =>
  one(
    await proxy<{ answer: string }>(
      w.db,
      "select ledger.settle_send($1::text, $2::text, $3::text, $4::text) as answer",
      [send, ruling, answer, requestId],
    ),
  ).answer;

// A reply that clears: an inbound message from the recipient on a thread of the account, the
// recipient written to before, the account connected for sending and synced just now.
export type Ready = DraftArgs & { decision: string; message: Stored };
export async function readyReply(
  w: SendCtx,
  options: {
    to?: string[];
    opportunity?: string | null;
    refs?: readonly (readonly [string, string])[];
    failed?: readonly string[];
    message?: Stored;
  } = {},
): Promise<Ready> {
  const to = options.to ?? ["rowan@send-example.test"];
  const message = options.message ?? (await insertMessage(w, { from: to[0] ?? "rowan@send-example.test" }));
  await knownTo(w, to);
  await connectForSend(w, w.account);
  await syncedAt(w, w.account, 5);
  const draft = await madeDraft(
    w,
    {
      to,
      replyTo: message.id,
      opportunity: options.opportunity ?? null,
      refs: options.refs ?? [],
    },
    options.failed ?? [],
  );
  return { ...draft, message };
}

// The gate at send and begin_send, with nothing failing: the send's id.
export async function sendNow(
  w: Pick<SendCtx, "db">,
  draft: { id: string; payloadFp: string },
  more: Partial<BeginArgs> = {},
): Promise<string> {
  const decision = await gateSend(w, draft.id, draft.payloadFp);
  const id = await begin(w, beginArgs(draft, decision, more));
  if (id === null) throw new Error("the prepared send was not begun");
  return id;
}

// ---------------------------------------------------------------------------------------------
// Reading what was written
// ---------------------------------------------------------------------------------------------

export const latest = async (w: Pick<SendCtx, "admin">, rowKind: string, rowId: string): Promise<string | null> =>
  (
    await w.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
      [rowKind, rowId],
    )
  )[0]?.event ?? null;
export const events = async (w: Pick<SendCtx, "admin">, rowKind: string, rowId: string): Promise<string[]> =>
  (
    await w.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id",
      [rowKind, rowId],
    )
  ).map((row) => row.event);
export const count = async (
  w: Pick<SendCtx, "admin">,
  table: string,
  where = "true",
  values: unknown[] = [],
): Promise<number> =>
  one(await w.admin<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values)).n;

// Every table a send function may write, as "<rows> <newest xmin>", read as pi_owner.
const WATCHED = [
  "ledger.drafts",
  "ledger.draft_beliefs",
  "ledger.gate_checks",
  "ledger.sent_messages",
  "ledger.record_events",
  "ledger.basis",
  "ledger.cards",
  "ledger.decision_point_calls",
  "knowledge.owner_decisions",
  "vault.evidence_items",
];
export const watched = (db: TestDatabase): Promise<Record<string, string>> =>
  session(db.urls.bootstrap, async (query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      const lines: Record<string, string> = {};
      for (const table of WATCHED) {
        lines[table] = one(
          await query<{ line: string }>(
            `select count(*)::text || ' ' || coalesce(max(xmin::text::bigint), 0)::text as line from ${table}`,
          ),
        ).line;
      }
      return lines;
    } finally {
      await query("rollback");
    }
  });

// ---------------------------------------------------------------------------------------------
// Cards, opportunities, vetoes and suppressions
// ---------------------------------------------------------------------------------------------

// A draft_waiting card, as the tick raises one, in the state given.
export async function waitingCard(
  w: Pick<SendCtx, "admin">,
  draft: string,
  author: string,
  state: "pending" | "deferred" = "pending",
  compartments: string[] = OWN,
): Promise<string> {
  const id = testId("crd");
  await w.admin(
    `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, case_key, compartments)
     values ($1, $2, now(), $3, 'draft_waiting', 'draft', $4, '{reject,acknowledge}', $5, $6)`,
    [id, testId("req"), author, draft, `draft:${draft}`, compartments],
  );
  await w.admin(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, $2, now(), 'system:test', $3)",
    [id, state, compartments],
  );
  return id;
}

// Another card of an author, deferred: what admit_deferred takes next.
export async function deferredCard(w: Pick<SendCtx, "admin">, author: string): Promise<string> {
  const id = testId("crd");
  await w.admin(
    `insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ($1, $2, now() - interval '1 hour', $3, 'notice', '{acknowledge}', '{own}')`,
    [id, testId("req"), author],
  );
  await w.admin(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'deferred', now(), 'system:test', '{own}')",
    [id],
  );
  return id;
}

const PROPOSE =
  "select ledger.propose_opportunity($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::jsonb, $10::text[], $11::text[]) as id";

// An opportunity the client proposes about a message of its own, with the owner's go, and its
// latest status the one given.
export async function opportunity(
  w: SendCtx,
  kind = "reply",
  status: string | null = "go",
  decision: "go" | "no_go" | null = "go",
): Promise<string> {
  const about = await insertMessage(w);
  const id = testId("opp");
  const body = JSON.stringify(
    sealUnder(
      w.db.keys,
      labelOf(w.client.compartments),
      { table: "ledger.opportunities", id, column: "body_enc" },
      "an opportunity",
    ),
  );
  const answer = await readAs(
    w.db,
    w.client.token,
    async (query) =>
      one(
        await query<{ id: string | null }>(PROPOSE, [
          id,
          testId("req"),
          w.client.session,
          kind,
          "message",
          about.id,
          null,
          null,
          body,
          ["message"],
          [about.id],
        ]),
      ).id,
  );
  if (answer !== id) throw new Error("the prepared opportunity was not proposed");
  const label = labelOf(w.client.compartments);
  if (decision !== null) {
    await queryAs(
      w.db.urls.work,
      `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason) values ($1, 'owner', $2, $3, $4, 'owner', 4, 'owner_answer')`,
      [testId("req"), label, id, decision],
    );
  }
  if (status !== null) await opportunityStatus(w, id, status);
  return id;
}
export const opportunityStatus = (w: Pick<SendCtx, "db" | "client">, id: string, status: string): Promise<unknown> =>
  queryAs(
    w.db.urls.work,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, $2, now(), 'owner', $3)",
    [id, status, labelOf(w.client.compartments)],
  );

// A veto of the owner's, as pi_admin writes one: on a person's address fingerprints, an
// organization's domain fingerprints, or a kind of work.
export async function veto(
  w: Pick<SendCtx, "admin">,
  subject: "person" | "organization" | "any",
  fps: string[],
  workKind: string | null = null,
): Promise<string> {
  const ruling = testId("rul");
  await w.admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
    [ruling, testId("req")],
  );
  await w.admin(
    "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, $2, $3, $4, now(), '{own}')",
    [ruling, subject, fps, workKind],
  );
  return ruling;
}

// A suppressed address, as an erasure of a person leaves one.
export async function suppress(w: Pick<SendCtx, "admin">, fp: string): Promise<void> {
  const ruling = testId("rul");
  const erasure = testId("ers");
  await w.admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')",
    [ruling, testId("req")],
  );
  const seq = one(
    await w.admin<{ n: number }>("select coalesce(max(journal_seq), 0)::int + 1 as n from knowledge.erasures"),
  ).n;
  await w.admin(
    `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', $3, now(), 0, 1, 0, '{own}')`,
    [erasure, ruling, seq],
  );
  await w.admin(
    "insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, now(), '{own}')",
    [testId("sup"), erasure, fp],
  );
}

export const killSwitch = (w: Pick<SendCtx, "admin">, state: "on" | "off"): Promise<unknown> =>
  w.admin(
    "insert into ledger.kill_switch (request_id, created_by, compartments, state) values ($1, 'owner', '{own}', $2)",
    [testId("req"), state],
  );

// A held pg client: one transaction open until `release`, for the tests on two connections.
export async function holding(
  url: string,
  statements: [string, unknown[]?][],
): Promise<{ client: pg.Client; release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("begin");
  for (const [sql, values] of statements) await client.query(sql, values);
  return {
    client,
    release: async () => {
      await client.query("commit");
      await client.end();
    },
  };
}

export { pending } from "./waits.ts";

export const author = (client: { id: string }): string => `client:${client.id}`;
