import * as outcomes from "../work/dispatch-learning.ts";
import { testId } from "./clients.ts";
import { one } from "./connections.ts";
import { fingerprint } from "./database.ts";
import type { WorkClient } from "./work-clients.ts";
import type { Mail, WorkWorld } from "./work-fixtures.ts";

// Reserved domains only.

export const DAY = 86_400_000;
export const daysAfter = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY);

// An address on a reserved domain and its fingerprint, as a send's recipient_fps holds it.
export const addressFp = (world: WorkWorld, address: string): string => fingerprint(world.db.keys, "address", address);
export const threadFp = (world: WorkWorld, thread: string): string => fingerprint(world.db.keys, "thread", thread);

// The source account the world keeps for a label: the account of a stored message under it.
export async function accountOf(world: WorkWorld, compartments: string[] = ["own"]): Promise<string> {
  const mail = await world.mail({ compartments });
  return one(
    await world.admin<{ account: string }>(
      "select source_account_id as account from vault.evidence_items where id = $1",
      [mail.evidence],
    ),
  ).account;
}

export type SendOptions = {
  drafter: WorkClient;
  account: string;
  // The recipients' address fingerprints.
  recipients: string[];
  // The draft's thread; the send's own thread_fp is null until finish_send fills it.
  thread: string | null;
  sendThread?: string | null;
  begunAt: Date;
  // Its latest event: sending (no answer yet), sent (finish_send's or the owner's settle), failed.
  state: "sending" | "sent" | "failed" | "unknown";
  sentAt?: Date;
  // Whether finish_send filled sent_at; an owner-settled send never has it.
  settled?: boolean;
  opportunity?: string | null;
  compartments?: string[];
};

export type Sent = { id: string; draft: string; ruling: string };

// A draft and its send, as the send proxy leaves them. Every send is the owner's.
export async function send(world: WorkWorld, options: SendOptions): Promise<Sent> {
  const compartments = [...new Set(options.compartments ?? ["own"])].sort();
  const recipients = [...new Set(options.recipients)].sort();
  const domains = [fingerprint(world.db.keys, "domain", "send-example.test")];
  const draft = testId("drf");
  const id = testId("snt");
  const ruling = testId("rul");
  const payload = fingerprint(world.db.keys, "fact", `payload ${id}`);
  const body = fingerprint(world.db.keys, "fact", `body ${id}`);
  await world.owner(
    `insert into ledger.drafts (id, request_id, created_at, created_by, compartments, opportunity_id, source_account_id, thread_fp, recipient_fps, recipient_domain_fps, payload_fp, body_fp)
     values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      draft,
      new Date(options.begunAt.getTime() - 60_000),
      `client:${options.drafter.id}`,
      compartments,
      options.opportunity ?? null,
      options.account,
      options.thread === null ? null : threadFp(world, options.thread),
      recipients,
      domains,
      payload,
      body,
    ],
  );
  await world.admin(
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'send', 'send', $3, 'send', 0, '{}', '{"firstContact":false,"newThread":false,"released":[]}', $4, $5)`,
    [ruling, testId("req"), id, options.begunAt, compartments],
  );
  const sendThread = options.sendThread === undefined ? null : options.sendThread;
  const sentAt = options.sentAt ?? new Date(options.begunAt.getTime() + 60_000);
  await world.owner(
    `insert into ledger.sent_messages (id, request_id, created_at, created_by, compartments, draft_id, ruling_id, decision_id, source_account_id, recipient_fps, payload_fp, body_fp, begun_at, thread_fp, sent_at)
     values ($1, $1, $2, 'owner', $3, $4, $5, $6, $7, $8, $9, $10, $2, $11, $12)`,
    [
      id,
      options.begunAt,
      compartments,
      draft,
      ruling,
      testId("gdc"),
      options.account,
      recipients,
      payload,
      body,
      sendThread === null ? null : threadFp(world, sendThread),
      options.state === "sent" && options.settled !== true ? sentAt : null,
    ],
  );
  await world.status("send", id, "sending", { at: options.begunAt, compartments });
  if (options.state !== "sending") await world.status("send", id, options.state, { at: sentAt, compartments });
  return { id, draft, ruling };
}

export type ReplyOptions = {
  thread: string | null;
  // The sender's address fingerprint.
  from: string;
  // The message's own time, and when the box first stored it (its evidence's observed_at).
  at: Date;
  observedAt?: Date;
  direction?: "inbound" | "outbound";
  bulk?: boolean;
  answersSystem?: boolean;
  systemOriginated?: boolean;
  compartments?: string[];
};

export async function reply(world: WorkWorld, account: string, options: ReplyOptions): Promise<Mail> {
  const mail = await world.mail({
    direction: options.direction ?? "inbound",
    bulk: options.bulk ?? false,
    ...(options.compartments === undefined ? {} : { compartments: options.compartments }),
  });
  const thread = options.thread === null ? null : threadFp(world, options.thread);
  await world.admin("update knowledge.messages set thread_fp = $2, sender_fp = $3, sent_at = $4 where id = $1", [
    mail.id,
    thread,
    options.from,
    options.at,
  ]);
  await world.admin(
    "update vault.evidence_items set source_account_id = $2, thread_fp = $3, observed_at = $4, answers_system = $5, system_originated = $6 where id = $1",
    [
      mail.evidence,
      account,
      thread,
      options.observedAt ?? options.at,
      options.answersSystem ?? true,
      options.systemOriginated ?? false,
    ],
  );
  return mail;
}

// A meeting with one participant, first stored at `observedAt`, the owner's response given.
export async function meeting(
  world: WorkWorld,
  options: {
    participant: string;
    startsAt: Date;
    observedAt: Date;
    response?: "accepted" | "needsAction";
    compartments?: string[];
  },
): Promise<{ id: string; evidence: string }> {
  const id = await world.event({
    startsAt: options.startsAt,
    response: options.response ?? "accepted",
    participant: options.participant,
    ...(options.compartments === undefined ? {} : { compartments: options.compartments }),
  });
  const { evidence } = one(
    await world.admin<{ evidence: string }>("select evidence_id as evidence from knowledge.events where id = $1", [id]),
  );
  await world.admin("update vault.evidence_items set observed_at = $2 where id = $1", [evidence, options.observedAt]);
  return { id, evidence };
}

// The two outcome functions, through the store's calls the tick makes, as pi_work.
export const matchOutcomes = (world: WorkWorld, now: Date): Promise<number> => outcomes.matchOutcomes(world.work, now);
export const assessOutcomes = (world: WorkWorld, now: Date): Promise<number> =>
  outcomes.assessOutcomes(world.work, now);

export type LinkRow = {
  id: string;
  send_id: string;
  result_kind: string;
  ref_kind: string;
  ref_id: string;
  evidence_id: string | null;
  observed_at: Date;
  compartments: string[];
  tainted_at: Date | null;
  created_by: string;
};
export const links = (world: WorkWorld): Promise<LinkRow[]> =>
  world.admin<LinkRow>(
    "select id, send_id, result_kind, ref_kind, ref_id, evidence_id, observed_at, compartments, tainted_at, created_by from ledger.move_result_links order by ref_id, send_id",
  );

export type AssessmentRow = {
  id: string;
  subject_kind: string;
  subject_id: string;
  check: string;
  horizon_days: number | null;
  result: string;
  decided_by: string;
  link_ids: string[];
  status_event_id: string | null;
  compartments: string[];
  tainted_at: Date | null;
  created_by: string;
};
export const assessments = (world: WorkWorld): Promise<AssessmentRow[]> =>
  world.admin<AssessmentRow>(
    `select id, subject_kind, subject_id, "check", horizon_days, result, decided_by, link_ids, status_event_id::text as status_event_id, compartments, tainted_at, created_by
     from ledger.outcome_assessments order by subject_kind, subject_id`,
  );
export const assessmentOf = async (world: WorkWorld, subject: string): Promise<AssessmentRow | undefined> =>
  (await assessments(world)).find((row) => row.subject_id === subject);
