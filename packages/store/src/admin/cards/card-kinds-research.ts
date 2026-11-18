import type { PublicIdentifier } from "@intelligence/contracts";
import {
  CARD_OPTIONS,
  type CardLine,
  EntityId,
  MessageId,
  type PersonalLabel,
  RESEARCH_TEMPLATES,
  type ResearchGateCause,
} from "@intelligence/contracts/personal";
import type { CardKindRow, StoredCard } from "../../cards/card-kind-row.ts";
import { codeLine, part } from "../../cards/card-line.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import type { Keys } from "../../core/keys.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { vetoed } from "../../core/queue.ts";
import type { ResearchBody } from "../../core/research.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { bodyOf, RESEARCH_STATE } from "../work/admin-research.ts";

// The card a client's request raises: kind `research_request`,
// raised by ledger.file_research with no body, so every line is read here from the request and
// rendered by code. Its effect writes the owner's `research` decision and the request's event.

type CardRequest = {
  id: string;
  kind: ResearchBody["kind"];
  about_entity_id: EntityId | null;
  message_id: MessageId | null;
  source_item_fp: string | null;
  compartments: PersonalLabel;
  body_enc: Sealed;
};

// The compartments under which the store holds a value for the entity: a name among its aliases,
// a domain among its domains and its accounts' domains.
async function heldUnder(query: Query, keys: Keys, about: string, one: PublicIdentifier): Promise<string[]> {
  const rows =
    one.kind === "domain"
      ? await query<{ compartments: string[] }>(
          `select compartments from knowledge.domains where entity_id = $1 and domain_fp = $2
           union select compartments from knowledge.accounts where entity_id = $1 and domain_fp = $2`,
          [about, fingerprint(keys, "domain", one.value)],
        )
      : await query<{ compartments: string[] }>(
          "select compartments from knowledge.aliases where entity_id = $1 and value_fp = $2",
          [about, fingerprint(keys, "name", one.value)],
        );
  return [...new Set(rows.flatMap((row) => row.compartments))].sort();
}

// The entity's name as the owner's view shows it: its first alias, opened under the owner's keys.
async function nameOf(query: Query, keys: Keys, entity: string): Promise<string | null> {
  const [alias] = await query<{ id: string; compartments: string[]; value_enc: Sealed }>(
    "select id, compartments, value_enc from knowledge.aliases where entity_id = $1 order by id limit 1",
    [entity],
  );
  return alias === undefined ? null : open(keys, alias, "knowledge.aliases.value_enc", "withheld");
}

// A sealed domain is not checked here.
async function causesNow(query: Query, row: CardRequest): Promise<ResearchGateCause[]> {
  const refs = [
    ...(row.about_entity_id === null ? [] : [{ kind: "entity" as const, id: EntityId.parse(row.about_entity_id) }]),
    ...(row.message_id === null ? [] : [{ kind: "message" as const, id: MessageId.parse(row.message_id) }]),
  ];
  const [erased] = await query<{ erased: boolean }>(
    `select ($1::text is not null and exists (select 1 from knowledge.removed_evidence r join vault.source_accounts a on a.id = r.source_account_id
                                              where a.connector = 'web' and r.source_item_fp = $1))
         or ($2::text is not null and not exists (select 1 from knowledge.entities e where e.id = $2)) as erased`,
    [row.source_item_fp, row.about_entity_id],
  );
  return [
    ...((await vetoed(query, { refs, kind: "research" })) ? ["vetoed" as const] : []),
    ...(erased?.erased === true ? ["erased" as const] : []),
  ];
}

async function renderRequest(card: StoredCard, query: Query, keys: Keys): Promise<CardLine[]> {
  const lines = [
    codeLine("kind", [part.code(card.kind)]),
    codeLine("requester", [part.code(card.author)]),
    codeLine("at", [part.time(card.createdAt)]),
  ];
  if (card.target?.kind !== "research_request") return lines;
  const [row] = await query<CardRequest>(
    "select id, kind, about_entity_id, message_id, source_item_fp, compartments, body_enc from ledger.research_requests where id = $1",
    [card.target.id],
  );
  if (row === undefined) return lines;
  lines.push(codeLine("request", [part.id("research_request", row.id)]));
  const body = bodyOf(keys, row);
  if (body === null) return [...lines, codeLine("body_none")];
  const label = body.kind === "link" ? "own" : "public";
  if (body.kind === "search") {
    lines.push(
      codeLine("template", [
        part.code(body.template),
        part.text(RESEARCH_TEMPLATES[body.template as keyof typeof RESEARCH_TEMPLATES].words),
      ]),
    );
    for (const one of body.identifiers) {
      const held = await heldUnder(query, keys, body.about, one);
      lines.push(
        codeLine("identifier", [part.code(one.kind), part.text(one.value), ...held.map((at) => part.code(at))]),
      );
      if (held.join(",") === "own") lines.push(codeLine("private_identifier", [part.text(one.value)]));
    }
    if (body.identifiers.length >= 2) lines.push(codeLine("private_together"));
  } else {
    lines.push(codeLine("url", [part.text(body.url)]), codeLine("host", [part.text(new URL(body.url).hostname)]));
  }
  if (body.kind === "link") {
    const [message] = await query<{ id: string; sent_at: Date; compartments: string[]; sender_enc: Sealed }>(
      "select id, sent_at, compartments, sender_enc from knowledge.messages where id = $1",
      [body.message],
    );
    const sender =
      message === undefined || message.sender_enc === null
        ? null
        : open(keys, message, "knowledge.messages.sender_enc", "withheld");
    lines.push(
      codeLine("link_message", [
        part.id("message", body.message),
        message === undefined ? part.code("unknown") : part.time(stamp(message.sent_at)),
        sender === null ? part.code("unknown") : part.text(sender),
      ]),
    );
    lines.push(codeLine("link_opened"));
  }
  lines.push(codeLine("stored_under", [part.code(label)]));
  if (body.kind !== "link") lines.push(codeLine("makes_public"));
  const about = body.kind === "link" ? null : body.about;
  if (about !== null) {
    const name = await nameOf(query, keys, about);
    if (name !== null)
      lines.push(
        codeLine("subject", [part.text(name)]),
        codeLine("binds", [part.id("entity", about), part.text(name)], [{ kind: "entity", id: about }]),
      );
    else lines.push(codeLine("subject", [part.id("entity", about)], [{ kind: "entity", id: about }]));
  }
  const causes = await causesNow(query, row);
  lines.push(
    codeLine(
      "gate",
      (causes.length === 0 ? ["clear"] : causes).map((cause) => part.code(cause)),
    ),
  );
  return lines;
}

export const researchRequest: CardKindRow = {
  options: CARD_OPTIONS.research_request,
  render: (card, _open, read) => renderRequest(card, read.query, read.keys),
  // A request no longer pending is left as it is.
  effect: async ({ query, card, answer, ruling, now }) => {
    if (card.target?.kind !== "research_request") return;
    const [row] = await query<{ compartments: string[]; event: string }>(
      `select q.compartments, ${RESEARCH_STATE} as event from ledger.research_requests q where q.id = $1 and q.tainted_at is null`,
      [card.target.id],
    );
    if (row?.event !== "filed") return;
    await ownerDecision(
      query,
      {
        requestId: `research_${ruling.slice(4)}`,
        kind: "research",
        target: { kind: "research_request", id: card.target.id },
        answer,
        card: card.id,
        compartments: row.compartments,
      },
      now,
    );
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('research_request', $1, $2, $3, 'owner', $4)",
      [card.target.id, answer === "approve" ? "approved" : "declined", stamp(now), row.compartments],
    );
  },
};
