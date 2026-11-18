import { type CardLine, INTERNAL_STAGES, type OpportunityKind, STAGE_PLAN } from "@intelligence/contracts/personal";
import type { CardRead, StoredCard } from "../../cards/card-kind-row.ts";
import { agentLine, codeLine, headingLine, part, saidLine, unreadableLine, writerOf } from "../../cards/card-line.ts";
import { ownerAudience } from "../../core/audience.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { openedReport } from "../../core/work-refs.ts";
import { ownerWho, ownerWithheld } from "../admin-owner.ts";
import { namedMessages } from "../search/admin-sources.ts";
import { opportunityDetailLines } from "./card-kinds-goals.ts";

// An outcome card presents its context and its action. Its lines,
// each part under a heading of code's: the work (`opportunity: <kind>`, and `task` for a task),
// who asked for it (`asked by: you | the planner | agent <name>`), what was asked (`asked:` over
// the work's own words), the agent that reported (`client: <name>`), what was found (`found:` over
// the report's summary), the report's parts
// (`deliverable:`, `draft:`, `next:`, `uncertain:`, `reason:`, each over the agent's words), its
// marks, and its sources (`source: <kind> <id>` over the words that name it). A source is named
// through the owner's own reads: a held message, one outside the owner's audience,
// a withheld person or a flagged record is not named, and says so (`source_unnamed`).

// A finding's words on a card: its first line, at most this many characters.
const FINDING_CHARS = 240;

type WorkRow = {
  id: string;
  kind: string;
  tier: string;
  created_by: string;
  compartments: string[];
  body_enc: Sealed;
};

// Who asked for the work: you, the planner, the system, an agent, or an agent by its name.
async function askedBy(read: CardRead, createdBy: string): Promise<CardLine> {
  const by = (who: string): CardLine => codeLine("asked_by", [part.code(who)]);
  if (createdBy === "owner") return by("you");
  if (createdBy.startsWith("run:") || createdBy === "reasoner") return by("the planner");
  if (!createdBy.startsWith("client:")) return by("the system");
  const [client] = await read.query<{ name: string }>("select name from policy.clients where id = $1", [
    createdBy.slice("client:".length),
  ]);
  return client === undefined ? by("an agent") : codeLine("asked_by", [part.code("agent"), part.text(client.name)]);
}

const first = (text: string): string => {
  const line =
    text
      .split("\n")
      .find((one) => one.trim() !== "")
      ?.trim() ?? "";
  return line.length <= FINDING_CHARS ? line : `${line.slice(0, FINDING_CHARS - 1)}…`;
};

// Each source the report cites, by its words where the owner's reads name it: one statement per kind
// asked about, none when it cites nothing.
async function sourceLines(read: CardRead, sources: readonly unknown[]): Promise<CardLine[]> {
  if (sources.length === 0) return [];
  const refs = sources.flatMap((one) =>
    typeof one === "object" &&
    one !== null &&
    "kind" in one &&
    "id" in one &&
    typeof one.kind === "string" &&
    typeof one.id === "string"
      ? [{ kind: one.kind, id: one.id }]
      : [],
  );
  const ids = (kind: string): string[] => [...new Set(refs.filter((ref) => ref.kind === kind).map((ref) => ref.id))];
  const messages = new Map((await namedMessages(read, ids("message"))).map((one) => [one.id, one]));
  const withheld = ids("entity").length === 0 ? new Set<string>() : await ownerWithheld(read.query);
  const people = await ownerWho(
    read,
    ids("entity").filter((id) => !withheld.has(id)),
  );
  const records = new Map<string, string>();
  if (ids("agent_record").length > 0) {
    const rows = await read.query<{ id: string; compartments: string[]; body_enc: Sealed }>(
      "select id, compartments, body_enc from ledger.agent_writes where id = any ($1::text[]) and body_enc is not null and tainted_at is null and flagged_at is null",
      [ids("agent_record")],
    );
    for (const row of rows) {
      const text = open(read.keys, row, "ledger.agent_writes.body_enc", "withheld");
      if (text !== null && text.trim() !== "") records.set(row.id, first(text));
    }
  }
  const events = new Map<string, string>();
  if (ids("event").length > 0) {
    const rows = await read.query<{ id: string; compartments: string[]; title_enc: Sealed }>(
      "select event_id as id, compartments, title_enc from knowledge.event_details where event_id = any ($1::text[]) and title_enc is not null and compartments <@ $2::text[]",
      [ids("event"), await ownerAudience(read.query)],
    );
    for (const row of rows) {
      const text = open(read.keys, row, "knowledge.event_details.title_enc", "withheld");
      if (text !== null) events.set(row.id, text);
    }
  }
  const lines: CardLine[] = [];
  for (const one of sources) {
    if (typeof one === "string") {
      lines.push(codeLine("source", [part.code("page")]), agentLine(one));
      continue;
    }
    const ref =
      typeof one === "object" && one !== null && "kind" in one && "id" in one
        ? (one as { kind: string; id: string })
        : null;
    if (ref === null) continue;
    lines.push(codeLine("source", [part.id(ref.kind, ref.id)], [ref]));
    let named: CardLine | null = null;
    if (ref.kind === "message") {
      const message = messages.get(ref.id);
      if (message?.subject != null) {
        const sender = message.from?.name?.untrusted ?? message.from?.address?.untrusted;
        named = saidLine("source", "cited_message", [
          part.text(message.subject.untrusted),
          ...(sender === undefined ? [] : [part.text(sender)]),
        ]);
      }
    } else if (ref.kind === "entity") {
      const who = people.get(ref.id);
      const name = who?.name?.untrusted ?? who?.address?.untrusted;
      if (name !== undefined) named = { text: name, from: "source" };
    } else if (ref.kind === "agent_record" && records.has(ref.id)) named = agentLine(records.get(ref.id) ?? "");
    else if (ref.kind === "event" && events.has(ref.id)) named = { text: events.get(ref.id) ?? "", from: "source" };
    lines.push(named ?? codeLine("source_unnamed"));
  }
  return lines;
}

export function outcomeLines(read: CardRead, card: StoredCard): Promise<CardLine[]> {
  return workLines(
    read,
    card.target?.kind === "move" ? { move: card.target.id } : { opportunity: card.target?.id ?? null },
  );
}

// A finished task's result in the owner's Results feed, presented as its outcome card is: the same lines,
// its sources named through the owner's reads the same way.
export const resultLines = (read: CardRead, move: string): Promise<CardLine[]> => workLines(read, { move });

async function workLines(read: CardRead, of: { move: string } | { opportunity: string | null }): Promise<CardLine[]> {
  const move = "move" in of ? of.move : null;
  const [work] = await read.query<WorkRow>(
    move === null
      ? "select id, kind, tier, created_by, compartments, body_enc from ledger.opportunities where id = $1"
      : "select o.id, o.kind, o.tier, o.created_by, o.compartments, o.body_enc from ledger.opportunities o join ledger.moves m on m.opportunity_id = o.id where m.id = $1",
    [move ?? ("opportunity" in of ? of.opportunity : null)],
  );
  if (work === undefined) return [];
  const lines: CardLine[] = [
    codeLine("work", [part.code("opportunity"), part.code(work.kind)]),
    ...(work.tier === "task" ? [codeLine("task")] : []),
    await askedBy(read, work.created_by),
  ];
  if (work.body_enc !== null) {
    const asked = open(read.keys, work, "ledger.opportunities.body_enc", "withheld");
    lines.push(
      headingLine("asked"),
      asked === null ? unreadableLine("summary") : { text: asked, from: writerOf(work.created_by) },
    );
  }
  lines.push(...(await opportunityDetailLines(read.query, read.keys, work.id)));
  // Work handed to the owner whose kind leaves the system: the line the terminal has always shown.
  if (move === null && STAGE_PLAN[work.kind as OpportunityKind]?.some((stage) => !INTERNAL_STAGES.includes(stage)))
    lines.push(codeLine("handed"));
  // The latest report, of the move or of the opportunity's moves. A report's body is bound to
  // `<move id>/reported`, as `report_move` seals it.
  const [report] = await read.query<{
    id: string;
    stage: string;
    writer: string | null;
    compartments: string[];
    body_enc: Sealed;
  }>(
    `select r.row_id as id, m.stage, (select c.name from policy.clients c where 'client:' || c.id = m.created_by) as writer, r.compartments, r.body_enc from ledger.record_events r join ledger.moves m on m.id = r.row_id
     where r.row_kind = 'move' and r.event = 'reported' and r.code is distinct from 'progress' and r.body_enc is not null and r.tainted_at is null and (m.id = $1 or ($1::text is null and m.opportunity_id = $2))
     order by r.id desc limit 1`,
    [move, work.id],
  );
  if (report === undefined) return lines;
  lines.push(codeLine("move", [part.code(report.stage)]));
  // The agent that reported it: the page says the report's words are this agent's.
  if (report.writer !== null) lines.push(codeLine("client", [part.text(report.writer)]));
  const text = open(read.keys, { ...report, id: `${report.id}/reported` }, "ledger.record_events.body_enc", "withheld");
  if (text === null) return [...lines, unreadableLine("report")];
  const body = openedReport(text);
  if (body.summary !== undefined) lines.push(headingLine("found"), agentLine(body.summary));
  for (const name of ["deliverable", "draft", "next", "uncertain", "reason"] as const) {
    const value = body.report?.[name];
    if (value !== undefined) lines.push(headingLine(name), agentLine(value));
  }
  lines.push(...body.marks.map((mark) => codeLine("mark", [part.code(mark)])));
  lines.push(...(await sourceLines(read, body.report?.sources ?? [])));
  return lines;
}
