// The claim and proposal card kinds: agent_claim, about_you and client_preference. Each finds the
// card's claim or agent record and opens it under the admin's keys; an about_you confirm releases
// the agent's record to the owner's own label.

import {
  CARD_CLAIM_TYPES,
  CARD_OPTIONS,
  type CardLine,
  ClaimRecord,
  channelled,
  isStatement,
  KEY_FIELDS,
  type MeetingCaptureFacts,
  type OwnerSideKind,
  PERSON_PROPOSAL_TYPES,
  type ProposalBody,
  parseProposalBody,
  releasableLabel,
} from "@intelligence/contracts/personal";
import { factLine } from "@intelligence/personal-core/checks";
import { proposalLine } from "@intelligence/personal-core/views";
import { byText, stamp } from "../core/db.ts";
import { claimKey } from "../core/fingerprint.ts";
import { TITLE_LINK_TYPE, titleLinkKeyOf } from "../core/link-types.ts";
import { insertRelease, vetoedRecord } from "../core/release.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { CardKindRow, CardRead, StoredCard } from "./card-kind-row.ts";
import { personProposalLines } from "./card-kinds-people.ts";
import { codeLine, codeLines, headLines, part, saidLine, shownValue, unreadableLine } from "./card-line.ts";

// A claim gone or sealed, as code's line.
const missing = (why: "claim_removed" | "claim_unreadable"): CardLine =>
  why === "claim_removed" ? codeLine("removed", [part.code("claim")]) : unreadableLine("claim");

type ClaimRow = {
  id: string;
  evidence_id: string;
  type: string;
  fact_key_fp: string;
  compartments: string[];
  content_enc: Sealed;
};

// The claim of an agent_claim or about_you card: the target's row or, when a generation raise
// replaced it, the latest claim of the card's compartments whose claim key is the card's request
// id; else the code line that says why there is none.
export async function claimOf(
  card: Pick<StoredCard, "target" | "compartments" | "requestId">,
  read: CardRead,
): Promise<{ id: string; record: ClaimRecord; evidenceId: string } | "claim_removed" | "claim_unreadable"> {
  const target = card.target?.kind === "claim" ? card.target.id : null;
  let [row] =
    target === null
      ? []
      : await read.query<ClaimRow>(
          "select id, evidence_id, type, fact_key_fp, compartments, content_enc from knowledge.claims where id = $1",
          [target],
        );
  if (row === undefined) {
    const candidates = await read.query<ClaimRow>(
      `select id, evidence_id, type, fact_key_fp, compartments, content_enc from knowledge.claims
       where compartments = $1 and type = any ($2::text[]) order by valid_from desc, id collate "C" desc`,
      [card.compartments, CARD_CLAIM_TYPES],
    );
    // A title link's key is over `capture` and its fact key alone.
    row = candidates.find(
      (one) =>
        claimKey(read.keys, one.evidence_id, one.fact_key_fp) === card.requestId ||
        (one.type === TITLE_LINK_TYPE && titleLinkKeyOf(read.keys, one.fact_key_fp) === card.requestId),
    );
  }
  if (row === undefined) return "claim_removed";
  if (row.compartments.some((compartment) => !read.keys.compartments.has(compartment))) return "claim_unreadable";
  const record = ClaimRecord.parse(JSON.parse(open(read.keys, row, "knowledge.claims.content_enc", "throw")));
  return { id: row.id, record, evidenceId: row.evidence_id };
}

// Who an agent_claim card's claim is about, so the owner can judge it: a code line with the
// subject's kind and id and, for anyone but the owner, the first name on file as a `source` line,
// or `subject_unreadable` when the key file cannot open it.
async function subjectLines(read: CardRead, subject: string): Promise<CardLine[]> {
  const [row] = await read.query<{ kind: string; id: string | null; compartments: string[] | null; value_enc: Sealed }>(
    `select e.kind, a.id, a.compartments, a.value_enc from knowledge.entities e
     left join lateral (select id, compartments, value_enc from knowledge.aliases where entity_id = e.id order by id limit 1) a on true
     where e.id = $1`,
    [subject],
  );
  const lines = [
    codeLine(
      "subject",
      [part.code(row?.kind ?? "entity"), part.id("entity", subject)],
      [{ kind: "entity", id: subject }],
    ),
  ];
  if (row === undefined || row.kind === "owner" || row.id === null || row.compartments === null) return lines;
  const { id, compartments } = row;
  if (compartments.some((compartment) => !read.keys.compartments.has(compartment)))
    return [...lines, unreadableLine("subject")];
  try {
    return [
      ...lines,
      {
        text: open(read.keys, { id, compartments, value_enc: row.value_enc }, "knowledge.aliases.value_enc", "throw"),
        from: "source",
      },
    ];
  } catch {
    return [...lines, unreadableLine("subject")];
  }
}

// An agent_claim card's lines for a capture.project claim (a title
// link): the meeting's title and start as `source` lines, opened under the admin's keys from the
// claim's item's knowledge.captures row, and the project's name as a `code` line. claimOf finds
// such a claim, when its target is gone, by titleLinkKeyOf over its fact_key_fp.
async function titleLinkLines(read: CardRead, found: { record: ClaimRecord; evidenceId: string }): Promise<CardLine[]> {
  const project = found.record.claim.content.subject;
  const lines: CardLine[] = [
    codeLine("type", [part.code(TITLE_LINK_TYPE)]),
    codeLine("subject", [part.code("project"), part.id("project", project)]),
  ];
  const readable = (compartments: string[]): boolean =>
    compartments.every((compartment) => read.keys.compartments.has(compartment));
  const [capture] = await read.query<{ id: string; started_at: Date; facts_enc: Sealed; compartments: string[] }>(
    "select id, started_at, facts_enc, compartments from knowledge.captures where evidence_id = $1",
    [found.evidenceId],
  );
  if (capture === undefined) lines.push(codeLine("removed", [part.code("capture")]));
  else if (!readable(capture.compartments)) lines.push(unreadableLine("capture"));
  else {
    const facts = JSON.parse(open(read.keys, capture, "knowledge.captures.facts_enc", "throw")) as
      | MeetingCaptureFacts
      | { kind: string };
    const meeting = facts.kind === "meeting" ? (facts as MeetingCaptureFacts) : null;
    if (meeting?.title !== null && meeting?.title !== undefined)
      lines.push(saidLine("source", "meeting_title", [part.text(meeting.title)]));
    if (meeting?.calendar?.title !== null && meeting?.calendar?.title !== undefined)
      lines.push(saidLine("source", "calendar_title", [part.text(meeting.calendar.title)]));
    lines.push(saidLine("source", "start", [part.time(stamp(capture.started_at))]));
  }
  const [row] = await read.query<{ id: string; name_enc: Sealed; compartments: string[] }>(
    "select id, name_enc, compartments from knowledge.projects where id = $1",
    [project],
  );
  if (row === undefined) lines.push(codeLine("removed", [part.code("project")]));
  else if (!readable(row.compartments)) lines.push(unreadableLine("project"));
  else lines.push(codeLine("project", [part.text(open(read.keys, row, "knowledge.projects.name_enc", "throw"))]));
  return lines;
}

// The agent_claim card: the owner confirms or rejects what an agent reported. Its claim is the
// target's row or, when a generation raise replaced it, the latest claim of the card's compartments
// whose claim key is the card's request id. Each field value is a slice of an agent record's body,
// or read from it by a model: an `agent` line, never `code` and never `source`. `effect` does
// nothing: the confirmation is the answer row decide writes, which policy.confirmed_claims reads.
export const agentClaim: CardKindRow = {
  options: CARD_OPTIONS.agent_claim,
  async render(card, _open, read) {
    const lines = codeLines(card);
    const found = await claimOf(card, read);
    if (typeof found === "string") return [...lines, missing(found)];
    const { record } = found;
    // A title link's card shows the meeting and the project, not an agent's fields.
    if (record.claim.content.type === TITLE_LINK_TYPE) return [...lines, ...(await titleLinkLines(read, found))];
    const fields = Object.entries(record.claim.content.fields).sort(([a], [b]) => byText(a, b));
    return [
      ...lines,
      codeLine("type", [part.code(record.claim.content.type)]),
      ...(await subjectLines(read, record.claim.content.subject)),
      ...fields.map(([name, value]) => fieldLine("agent", name, value)),
    ];
  },
  effect: async () => {},
};

// An agent's words on a card are `agent` lines, never `code`
// or `source`. A proposal's body as the store keeps it: the arguments less requestId.
const agentLine = (text: string): CardLine => ({ text, from: "agent" });
// A field of a claim or a proposal: its name, which code gives it, over its value as written.
const fieldLine = (from: "agent" | "source", name: string, value: unknown): CardLine =>
  saidLine(from, "field", [name === "" ? part.text(name) : part.code(name), part.text(shownValue(value))]);
const fieldLines = (fields: unknown): CardLine[] =>
  typeof fields === "object" && fields !== null
    ? Object.entries(fields)
        .sort(([a], [b]) => byText(a, b))
        .map(([name, value]) => fieldLine("agent", name, value))
    : [];
const quoteLines = (body: ProposalBody | null): CardLine[] =>
  typeof body?.quote === "string"
    ? [saidLine("agent", "says_you_said", [part.text(body.quote)])]
    : interpreted(body) === null
      ? []
      : [codeLine("interpretation_note")];
// An interpretation's statement and quotes, or null; or a statement proposal's statement, its one
// quote shown as any proposal's is.
const interpreted = (body: ProposalBody | null): { statement: string; quotes: string[] } | null => {
  if (body === null || !("statement" in body) || typeof body.statement !== "string") return null;
  if (isStatement(body)) return { statement: body.statement, quotes: [] };
  return "quotes" in body && Array.isArray(body.quotes) ? { statement: body.statement, quotes: body.quotes } : null;
};

// What an about_you card leads with. The line the fact will be stored and served as, rendered by
// the line template (core's proposalLine) from the claim's typed fields: the agent's slice of the
// owner's words, so an `agent` line. Then the quote, with the client that wrote the record read by
// code. Then, in code, what confirming does: a confirmed proposal is released to the owner's own
// label, which every agent cleared for `own` reads; a record whose label is not releasable is
// confirmed as before, and its card says nothing of it. A role's or an affiliation's line is the
// one the claim intake checked stands alone (core's factLine); an owner-side kind's is that line
// with its domain after the kind's word.
const toldLine = (client: string, quote: string): CardLine =>
  saidLine("agent", "you_told", [part.text(client), part.text(quote)]);
function leadLines(record: ClaimRecord, opened: { body: string; client: string } | null): CardLine[] {
  const { type, fields } = record.claim.content;
  const line = Object.hasOwn(KEY_FIELDS, type)
    ? [agentLine(proposalLine(type as OwnerSideKind, fields))]
    : type === "role" || type === "affiliation"
      ? [agentLine(factLine(type, fields))]
      : [];
  const body = opened === null ? null : parseProposalBody(opened.body);
  const quote = body?.quote;
  // An interpretation's statement, in the agent's words, then each quote of
  // the owner's it rests on, all the agent's lines; code's heading says which is which.
  const interpretation = interpreted(body);
  return [
    ...line,
    ...(typeof quote === "string" && opened !== null ? [toldLine(opened.client, quote)] : []),
    ...(interpretation !== null && opened !== null
      ? [
          codeLine("interpretation", [part.text(opened.client)]),
          agentLine(interpretation.statement),
          ...interpretation.quotes.map((one) => toldLine(opened.client, one)),
        ]
      : []),
    ...(releasableLabel(record.claim.label.compartments) ? [codeLine("release_note")] : []),
  ];
}

type RecordRow = { id: string; client_name: string; compartments: string[]; body_enc: Sealed };
// The agent record's body opened under the admin's keys, with the client that wrote it: null when
// it has none, `unreadable` when the key file lacks a compartment of it.
async function recordBody(
  read: CardRead,
  where: "id" | "evidence_id",
  value: string,
): Promise<{ body: string; client: string } | null | "unreadable"> {
  const [row] = await read.query<RecordRow>(
    `select id, client_name, compartments, body_enc from ledger.agent_writes where ${where} = $1 and body_enc is not null`,
    [value],
  );
  if (row === undefined) return null;
  if (row.compartments.some((compartment) => !read.keys.compartments.has(compartment))) return "unreadable";
  return {
    body: open(read.keys, row, "ledger.agent_writes.body_enc", "throw"),
    client: row.client_name,
  };
}

// The card about the owner: the owner confirms or rejects what an agent
// proposed about the owner. Its kind, author and time are code's; the proposed type, each field and the
// quote are the agent's. Its claim is found as agent_claim's is. `effect` does nothing: the
// confirmation is the answer row decide writes, which policy.confirmed_claims reads. The same card
// asks the owner whether a question they wrote is a lasting need. Its claim is from the owner's mail: a code
// line says so, and the type and each field are `source` lines.
export const aboutYou: CardKindRow = {
  options: CARD_OPTIONS.about_you,
  async render(card, _open, read) {
    const lines = headLines(card);
    const found = await claimOf(card, read);
    if (typeof found === "string") return [...lines, missing(found)];
    const { record, evidenceId } = found;
    if (record.origin !== "agent_record") {
      const fields = Object.entries(record.claim.content.fields).sort(([a], [b]) => byText(a, b));
      return [
        ...lines,
        codeLine("own_question"),
        saidLine("source", "type", [part.code(record.claim.content.type)]),
        ...fields.map(([name, value]) => fieldLine("source", name, value)),
      ];
    }
    const written = await recordBody(read, "evidence_id", evidenceId);
    const opened = written === null || written === "unreadable" ? null : written;
    const quoted = quoteLines(opened === null ? null : parseProposalBody(opened.body));
    // A quoted proposal's claim is the owner's own
    // words once the owner confirms it (claimTierOf's `owner`), so the card says so. Code's line: the
    // channel is the client that wrote the record, read by code, never the agent's word.
    const effect =
      opened !== null && quoted.length > 0 && channelled(record.claim)
        ? [
            codeLine("confirm_records", [
              part.code(interpreted(parseProposalBody(opened.body)) === null ? "quote" : "fact"),
              part.text(opened.client),
            ]),
          ]
        : [];
    // A propose_person claim's own lines, after the release note.
    const people = PERSON_PROPOSAL_TYPES.includes(record.claim.content.type)
      ? await personProposalLines(
          read,
          record,
          await vetoedRecord(read.query, evidenceId),
          opened?.body ?? null,
          (id) => subjectLines(read, id),
        )
      : [];
    return [
      ...leadLines(record, opened),
      ...people,
      ...lines,
      saidLine("agent", "type", [part.code(record.claim.content.type)]),
      ...fieldLines(record.claim.content.fields),
      ...effect,
    ];
  },
  // The owner's confirm of an agent's proposal is the owner's release of it. One release row of the card's
  // record, under this decision, when its label is releasable; the pipeline makes the released
  // claim at its next run. A question of the owner's own is from the owner's mail and already theirs; a reject
  // releases nothing. Nor does a confirm of a record whose fact the owner vetoed or retired (invariant
  // 11).
  async effect({ query, card, answer, ruling, now, keys }) {
    if (answer !== "confirm") return;
    const found = await claimOf(card, { query, keys });
    if (
      typeof found === "string" ||
      found.record.origin !== "agent_record" ||
      !releasableLabel(found.record.claim.label.compartments)
    )
      return;
    if (await vetoedRecord(query, found.evidenceId)) return;
    await insertRelease(query, { ruling, evidenceId: found.evidenceId, via: "card", now });
  },
};

// The client-scoped preference: its lines are rendered from the agent record at
// render time; a record with no body renders `record_removed`, and a confirm on it serves nothing,
// since policy.confirmed_preferences reads only records with a body. `effect` does nothing.
export const clientPreference: CardKindRow = {
  options: CARD_OPTIONS.client_preference,
  async render(card, _open, read) {
    const lines = headLines(card);
    const target = card.target?.kind === "agent_record" ? card.target.id : null;
    const written = target === null ? null : await recordBody(read, "id", target);
    if (written === null) return [...lines, codeLine("removed", [part.code("record")])];
    if (written === "unreadable") return [...lines, unreadableLine("record")];
    const parsed = parseProposalBody(written.body);
    // A statement proposal's statement, its kind only the agent's hint.
    if (parsed !== null && isStatement(parsed))
      return [...lines, saidLine("agent", "statement", [part.text(parsed.statement)]), ...quoteLines(parsed)];
    return [
      ...lines,
      ...(parsed?.kind === undefined ? [] : [saidLine("agent", "type", [part.text(shownValue(parsed.kind))])]),
      ...fieldLines(parsed?.fields),
      ...quoteLines(parsed),
    ];
  },
  effect: async () => {},
};
