import { GateCheckKind } from "@intelligence/contracts";
import {
  ClaimRecord,
  type DraftId,
  type DraftMessageArgs,
  type DraftMessageResult,
  SendPayload,
  sendAddress,
  type UseOnlyCandidate,
} from "@intelligence/contracts/personal";
import { revealedClaims, revealedContacts, sendGate } from "@intelligence/personal-core/outbound";
import { draftValues } from "../agent-writes/draft-values.ts";
import { newId } from "../core/ids.ts";
import type { Sealed } from "../core/seal.ts";
import { openUnder } from "../core/seal.ts";
import { servedOrNone } from "../core/served.ts";
import {
  answered,
  type Done,
  isRefused,
  pinned,
  type Refused,
  refIds,
  refKinds,
  refused,
  sealSummary,
  type WorkCall,
} from "../core/work-refs.ts";
import { CONTACT_CANDIDATES, type ContactCandidateRow, openContactCandidate } from "../identity/contact-candidates.ts";
import { type Ctx, Unavailable } from "../read/read-ctx.ts";

// The send proxy's propose tool in the store, as pi_reader inside pi mcp, in the call's one
// transaction. Here the payload is built and sealed and its four values made, from the arguments
// and from stored rows opened with the client's keys alone; the database sets the author, the
// label, the account, the thread and the case, and holds the cap. What the gate decided changes
// nothing this answers or sends: every draft runs the same statements.

const SQL = {
  accounts: "select id, label from ledger.draft_accounts($1::text, $2::text)",
  message: `
    select m.id, m.compartments, m.sender_enc, m.subject_enc, m.thread_id_enc, m.facts_enc
    from knowledge.messages m where m.id = $1 and not m.held order by m.id`,
  appendDraft:
    "select ledger.append_draft($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text[], $8::text[], $9::text, $10::text, $11::jsonb, $12::text[], $13::text[]) as answer",
  candidates: "select claim_id, compartments, content_enc, cited_item from ledger.use_only_candidates($1::text)",
  facts: "select ledger.gate_facts($1::text, 'draft') as facts",
  gate: "select ledger.append_gate_decision($1::text, $2::text, 'draft', $3::text, $4::jsonb, null, $5::integer, $6::text)",
} as const;

// A header value a payload carries: printable ASCII with no white space.
const TOKEN = /^[\x21-\x7E]{1,250}$/;
const REFERENCES = 20;
const SUBJECT = 200;

type MessageRow = {
  id: string;
  compartments: string[];
  sender_enc: Sealed | null;
  subject_enc: Sealed | null;
  thread_id_enc: Sealed | null;
  facts_enc: Sealed | null;
};
type Reply = { to: string[]; subject: string; thread: NonNullable<SendPayload["thread"]> };

// The answered message's subject with "Re: " before it unless it starts so, cut to 200 code
// points; a message with no subject gives "Re:". A header folded with a tab or a line break,
// which a subject may not carry, reads as one space.
const replySubject = (stored: string | null): string => {
  const unfolded = stored?.replace(/[\t\r\n]+[\t ]*/g, " ") ?? null;
  if (unfolded === null || unfolded.trim() === "") return "Re:";
  const subject = /^re:/i.test(unfolded) ? unfolded : `Re: ${unfolded}`;
  return [...subject].slice(0, SUBJECT).join("");
};

// What a reply takes from the stored message: its sender, its subject and its thread, each opened
// with the client's keys. Null when the message cannot be answered.
function replyOf(ctx: Ctx, row: MessageRow, to: string[] | undefined): Reply | null {
  const open = (column: "facts_enc" | "thread_id_enc" | "sender_enc" | "subject_enc"): string | null =>
    servedOrNone(ctx, row, `knowledge.messages.${column}`)?.untrusted ?? null;
  let facts: { messageId?: unknown; references?: unknown };
  try {
    facts = JSON.parse(open("facts_enc") ?? "") as typeof facts;
  } catch {
    throw new Unavailable();
  }
  const threadId = open("thread_id_enc");
  const messageId = facts.messageId;
  if (typeof messageId !== "string" || !TOKEN.test(messageId) || threadId === null || !TOKEN.test(threadId))
    return null;
  const stored = Array.isArray(facts.references)
    ? facts.references.filter((one): one is string => typeof one === "string" && TOKEN.test(one))
    : [];
  const recipients = to ?? [open("sender_enc") ?? ""];
  const addresses = recipients.map((address) => sendAddress(address));
  if (addresses.some((address) => address === null)) return null;
  return {
    to: addresses as string[],
    subject: replySubject(open("subject_enc")),
    thread: { id: threadId, inReplyTo: messageId, references: [...stored, messageId].slice(-REFERENCES) },
  };
}

type CandidateRow = { claim_id: string; compartments: string[]; content_enc: unknown; cited_item: boolean };

// Rung 0's count: the claims the draft reveals, and each candidate that did not open or parse,
// which fails the check and never passes it.
function revealedCount(ctx: Ctx, rows: CandidateRow[], payload: SendPayload): number {
  let unreadable = 0;
  const candidates: UseOnlyCandidate[] = [];
  for (const row of rows) {
    try {
      const record = ClaimRecord.parse(
        JSON.parse(
          openUnder(
            ctx.keys,
            row.compartments,
            { table: "knowledge.claims", id: row.claim_id, column: "content_enc" },
            row.content_enc as never,
          ),
        ),
      );
      const fields = Object.entries(record.claim.content.fields as Record<string, unknown>);
      candidates.push({
        id: row.claim_id,
        thirdParty: record.disclosure.includes("third_party"),
        isPublic: row.compartments.length === 1 && row.compartments[0] === "public",
        // use_only_candidates returns only claims a recipient was not on the thread of.
        offThread: true,
        citedItem: row.cited_item,
        textValues: fields.flatMap(([field, value]) =>
          record.fieldKinds[field] === "text" && typeof value === "string" ? [value] : [],
        ),
      });
    } catch {
      unreadable += 1;
    }
  }
  return unreadable + revealedClaims({ subject: payload.subject, body: payload.body, candidates, released: [] }).length;
}

function revealedFields(ctx: Ctx, rows: ContactCandidateRow[], payload: SendPayload): number {
  let unreadable = 0;
  const candidates = rows.flatMap((row) => {
    try {
      return [openContactCandidate(ctx.keys, row)];
    } catch {
      unreadable += 1;
      return [];
    }
  });
  return (
    unreadable + revealedContacts({ subject: payload.subject, body: payload.body, candidates, released: [] }).length
  );
}

// Every visibility refusal of append_draft (42501) is not_found, none told apart. It raises no
// unknown_role; one would be refused as invalid.
const hidden = (code: Refused) =>
  refused<DraftMessageResult>(
    code === "not_permitted" ? "not_found" : code === "unknown_role" ? "invalid_request" : code,
  );

export async function draftMessage(
  { client, ctx, session, fn }: WorkCall,
  args: DraftMessageArgs,
): Promise<Done<DraftMessageResult>> {
  // 2. The account: the reply's, whatever is named; else the one named; else the one mail
  // account within the clearance.
  const accounts = await fn<{ id: string; label: string }>(
    SQL.accounts,
    args.replyTo === undefined ? [null, args.account ?? null] : [args.replyTo, null],
  );
  if (isRefused(accounts)) return hidden(accounts);
  const [account] = accounts;
  if (account === undefined || accounts.length > 1)
    return refused(args.replyTo === undefined ? "invalid_request" : "not_found");

  // 3. Recipients, subject and thread: a reply's from the stored message, never the client's.
  let to: string[];
  let subject: string;
  let thread: SendPayload["thread"] = null;
  if (args.replyTo !== undefined) {
    const [row] = await ctx.run<MessageRow>(SQL.message, [args.replyTo]);
    if (row === undefined) return refused("not_found");
    const reply = replyOf(ctx, row, args.to);
    if (reply === null) return refused("invalid_request");
    ({ to, subject, thread } = reply);
  } else {
    to = (args.to ?? []).map((address) => sendAddress(address) ?? "");
    subject = args.subject ?? "";
  }

  // 4. The payload, and its four values.
  const parsed = SendPayload.safeParse({
    v: 1,
    account: account.id,
    to,
    cc: (args.cc ?? []).map((address) => sendAddress(address) ?? ""),
    subject,
    body: args.body,
    thread,
  });
  if (!parsed.success) return refused("invalid_request");
  const payload = parsed.data;
  const values = await draftValues(ctx.keys, payload);

  // 5. The draft. The database sets its author, label, account, thread and case.
  const id = newId("drf") as DraftId;
  const body = sealSummary(
    ctx,
    client.compartments,
    { table: "ledger.drafts", id, column: "body_enc" },
    JSON.stringify(payload),
  );
  const basis = args.basis ?? [];
  const stored = await fn<{ answer: string | null }>(SQL.appendDraft, [
    id,
    args.requestId,
    await session(),
    args.opportunity ?? null,
    args.replyTo ?? null,
    account.label,
    values.recipientFps,
    values.recipientDomainFps,
    values.payloadFp,
    values.bodyFp,
    body,
    refKinds(basis),
    refIds(basis),
  ]);
  if (isRefused(stored)) return hidden(stored);
  const answer = stored[0]?.answer ?? null;
  if (answer === null) throw new Unavailable();
  if (answer === "rate_limited") return { outcome: { ok: false, code: "rate_limited" }, rows: 0 };
  // A repeated request id: the first draft, whose gate has already run.
  if (answer !== id) return answered({ draft: answer as DraftId });

  const revealed =
    revealedCount(ctx, await ctx.run<CandidateRow>(SQL.candidates, [id]), payload) +
    revealedFields(ctx, await ctx.run<ContactCandidateRow>(CONTACT_CANDIDATES, [id]), payload);

  // 7. The gate at phase draft. The facts are the database's, as pi_reader gives them.
  const [row] = await ctx.run<{ facts: unknown }>(SQL.facts, [id]);
  const outcome = sendGate({
    phase: "draft",
    facts: row?.facts,
    revealed,
    released: 0,
    computedFp: values.payloadFp,
    storedFp: values.payloadFp,
  } as never);
  const checks = GateCheckKind.options.map((kind) => ({ kind, passed: outcome.checks[kind] }));
  const point = pinned("draft_disclosure");
  await ctx.run(SQL.gate, [newId("gdc"), id, values.payloadFp, JSON.stringify(checks), point.version, point.hash]);

  // 8. The call log and the read log are the call path's; the answer says nothing more.
  return answered({ draft: id });
}
