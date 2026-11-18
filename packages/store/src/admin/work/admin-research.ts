import {
  type FetchOutcome,
  ownLabel,
  RESEARCH_TEMPLATES,
  type ResearchGateCause,
  type ResearchRequestId,
  type ResearchSettings,
  ResearchSettingsPatch,
  type ResearchState,
  type RulingId,
} from "@intelligence/contracts/personal";
import { researchGate } from "@intelligence/personal-core/research";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { authorWord } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import {
  type OwnerResearchArgs,
  queryText,
  REQUEST_BODY,
  RESEARCH_SETTINGS,
  type ResearchBody,
  type ResearchRow,
  type ResearchStatusView,
  type SettingsRow,
  settingsOf,
  urlInText,
} from "../../core/research.ts";
import { open, type Sealed, sealUnder } from "../../core/seal.ts";
import { LATEST_CARD_EVENT, latestEvent, latestRow } from "../../core/statements.ts";
import { repeatedDecision } from "../admin-base.ts";
import { RESEARCH_WITHDRAWN, recordEvent } from "../record-event.ts";

// The owner's research commands and the card a client's request raises, as pi_admin. Ids, kinds,
// states, times, causes and counts are printed; a body is opened only by `show` and the card, for
// the owner's terminal.

// An owner request is labelled `own` and filed approved: the owner's command is their decision.
const OWN = ownLabel();
const OWNER = "owner";

// A request's state: its latest event, `filed` read as pending, and a pending one whose card has
// expired read as expired.
export const RESEARCH_STATE = `(${latestEvent("research_request", "q.id", "e")})`;
const CARD_EXPIRED = `exists (
  select 1 from ledger.cards c
  join lateral (${latestRow("r.at", "card", "c.id", { and: "r.event = 'pending'" })}) p on true
  where c.id = q.card_id and p.at + make_interval(days => c.expires_after_days) <= $1::timestamptz)`;
const ROW = `select q.id, q.kind, q.created_at, q.causes, q.compartments, q.body_enc, q.card_id, ${RESEARCH_STATE} as event, ${CARD_EXPIRED} as expired from ledger.research_requests q`;

type StoredRow = {
  id: ResearchRequestId;
  kind: ResearchBody["kind"];
  created_at: Date;
  causes: ResearchGateCause[];
  compartments: string[];
  body_enc: Sealed;
  card_id: string | null;
  event: string;
  expired: boolean;
};

const stateOf = (row: StoredRow): ResearchState =>
  row.event === "filed" ? (row.expired ? "expired" : "pending") : (row.event as ResearchState);
const rowOf = (row: StoredRow): ResearchRow => ({
  id: row.id,
  kind: row.kind,
  state: stateOf(row),
  createdAt: stamp(row.created_at),
  causes: row.causes,
});
export const bodyOf = (
  keys: Keys,
  row: { id: string; compartments: string[]; body_enc: Sealed },
): ResearchBody | null => {
  const text = open(keys, row, "ledger.research_requests.body_enc", "withheld");
  return text === null ? null : (JSON.parse(text) as ResearchBody);
};

// The owner's body, checked as the gate checks a body with the owner's own decision behind it: a bad form
// is `invalid_argument`, a private URL without --private-url is `private_url`.
function checked(args: OwnerResearchArgs): ResearchBody {
  const body: ResearchBody =
    args.kind === "search"
      ? { kind: "search", template: args.template, identifiers: args.identifiers, about: args.about }
      : args.kind === "link"
        ? { kind: "link", message: args.message, url: args.url }
        : { kind: "url", url: args.url, about: args.about, names: args.names, privateUrl: args.privateUrl };
  if (
    body.kind === "url" &&
    (!body.names.every((name) => typeof name === "string" && name.trim() !== "") ||
      (body.names.length > 0 && body.about === null))
  ) {
    throw new AdminError("invalid_argument");
  }
  const details = body.kind === "url" && body.privateUrl ? { privateUrl: true } : {};
  const gateBody =
    body.kind === "search"
      ? { ...body, templateVersion: RESEARCH_TEMPLATES[body.template as keyof typeof RESEARCH_TEMPLATES].version }
      : body;
  const { causes } = researchGate(
    { compartments: OWN, body: gateBody },
    {
      stage: "filing",
      events: [{ event: "approved", decision: { kind: "research", answer: "typed", details } }],
      vetoed: false,
      erased: false,
      sealed: false,
      settings: AT_FILING,
    },
    new Date(0),
  );
  if (causes.includes("bad_form")) throw new AdminError("invalid_argument");
  if (causes.includes("private_url")) throw new AdminError("private_url");
  return body;
}

// The caps are a run's check: the gate reads none at filing.
const AT_FILING: ResearchSettings = {
  clientLinkRequests: false,
  maxRequestsPerClientPerDay: 0,
  maxSearchesPerDay: 0,
  maxFetchesPerDay: 0,
  maxPagesPerRequest: 0,
  refetchAfterDays: 0,
  cardExpiryDays: 1,
};

async function linkChecked(query: Query, keys: Keys, body: Extract<ResearchBody, { kind: "link" }>): Promise<void> {
  const [message] = await query<{ id: string; compartments: string[]; body_enc: Sealed }>(
    "select id, compartments, body_enc from knowledge.messages where id = $1",
    [body.message],
  );
  if (message === undefined) throw new AdminError("not_found");
  if (message.compartments.join(",") !== "own") throw new AdminError("not_permitted");
  const text = open(keys, message, "knowledge.messages.body_enc", "withheld");
  if (text === null || !urlInText(text, body.url)) throw new AdminError("not_found");
}

// A repeated request id answers the first request.
export async function fileOwnerResearch(admin: AdminContext, args: OwnerResearchArgs): Promise<ResearchRequestId> {
  const body = checked(args);
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [authorWord(OWNER)]);
    const [repeat] = await query<{ id: ResearchRequestId }>(
      "select id from ledger.research_requests where author = 'owner' and request_id = $1",
      [args.requestId],
    );
    if (repeat !== undefined) return repeat.id;
    const about = body.kind === "link" ? null : body.about;
    if (
      about !== null &&
      (await query("select 1 from knowledge.entities where id = $1 and kind in ('person', 'organization')", [about]))
        .length === 0
    )
      throw new AdminError("not_found");
    if (body.kind === "link") await linkChecked(query, admin.keys, body);

    const id = newId("rsq") as ResearchRequestId;
    const at = stamp(now);
    await query(
      `insert into ledger.research_requests (id, request_id, created_at, author, kind, template_id, template_version, about_entity_id, message_id,
         query_fp, source_item_fp, body_enc, compartments)
       values ($1, $2, $3, 'owner', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        args.requestId,
        at,
        body.kind,
        body.kind === "search" ? body.template : null,
        body.kind === "search" ? RESEARCH_TEMPLATES[body.template as keyof typeof RESEARCH_TEMPLATES].version : null,
        about,
        body.kind === "link" ? body.message : null,
        fingerprint(admin.keys, "research_query", queryText(body)),
        body.kind === "search" ? null : fingerprint(admin.keys, "source_id", body.url),
        sealUnder(admin.keys, OWN, REQUEST_BODY(id), JSON.stringify(body)),
        OWN,
      ],
    );
    await ownerDecision(
      query,
      {
        requestId: `research_${id.slice(4)}`,
        kind: "research",
        target: { kind: "research_request", id },
        answer: "typed",
        details: body.kind === "url" && body.privateUrl ? { privateUrl: true } : {},
        compartments: OWN,
      },
      now,
    );
    await query(
      `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
       values ('research_request', $1, 'filed', $2, 'owner', $3), ('research_request', $1, 'approved', $2, 'owner', $3)`,
      [id, at, OWN],
    );
    return id;
  });
}

export async function listResearch(admin: AdminContext, state?: ResearchState): Promise<ResearchRow[]> {
  const rows = await admin.transaction((query) =>
    query<StoredRow>(`${ROW} order by q.created_at, q.id`, [stamp(admin.now())]),
  );
  return rows.map(rowOf).filter((row) => state === undefined || row.state === state);
}

export function showResearch(
  admin: AdminContext,
  id: ResearchRequestId,
): Promise<(ResearchRow & { body: ResearchBody }) | null> {
  return admin.transaction(async (query) => {
    const [row] = await query<StoredRow>(`${ROW} where q.id = $2`, [stamp(admin.now()), id]);
    if (row === undefined) return null;
    const body = bodyOf(admin.keys, row);
    return body === null ? null : { ...rowOf(row), body };
  });
}

// The owner's withdrawal of a request not yet run: its event, and its card's if it is pending.
export function withdrawResearch(admin: AdminContext, id: ResearchRequestId): Promise<boolean> {
  const at = stamp(admin.now());
  return admin.transaction(async (query) => {
    await lockRows(query, [id]);
    const [row] = await query<StoredRow>(`${ROW} where q.id = $2`, [at, id]);
    if (row === undefined || !["pending", "approved", "waiting"].includes(stateOf(row))) return false;
    await recordEvent(query, RESEARCH_WITHDRAWN, id, at, row.compartments);
    if (row.card_id !== null) {
      await query(
        `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
         select 'card', c.id, 'withdrawn', $2, 'owner', c.compartments from ledger.cards c
         where c.id = $1 and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')`,
        [row.card_id, at],
      );
    }
    return true;
  });
}

// Counts only: requests by state, today's egress against the caps, outcomes, pages stored.
export function researchStatus(admin: AdminContext): Promise<ResearchStatusView> {
  return admin.transaction(async (query) => {
    const requests: Partial<Record<ResearchState, number>> = {};
    for (const row of await query<StoredRow>(ROW, [stamp(admin.now())])) {
      const state = stateOf(row);
      requests[state] = (requests[state] ?? 0) + 1;
    }
    const [today] = await query<{ searches: number; fetches: number }>(
      `select (count(*) filter (where kind = 'search'))::int as searches, (count(*) filter (where kind <> 'search'))::int as fetches
       from ledger.research_fetches where started_at >= date_trunc('day', $1::timestamptz, 'UTC')`,
      [stamp(admin.now())],
    );
    const outcomes = Object.fromEntries(
      (
        await query<{ outcome: FetchOutcome; n: number }>(
          "select outcome, count(*)::int as n from ledger.research_fetches where outcome is not null group by outcome order by outcome",
        )
      ).map((row) => [row.outcome, row.n]),
    ) as Partial<Record<FetchOutcome, number>>;
    const [pages] = await query<{ n: number }>("select count(*)::int as n from knowledge.pages");
    return {
      requests,
      searchesToday: today?.searches ?? 0,
      fetchesToday: today?.fetches ?? 0,
      outcomes,
      pages: pages?.n ?? 0,
    };
  });
}

export async function researchSettings(admin: AdminContext): Promise<ResearchSettings> {
  return settingsOf((await admin.transaction((query) => query<SettingsRow>(RESEARCH_SETTINGS)))[0]);
}

const COLUMNS: Readonly<Record<keyof ResearchSettings, string>> = {
  clientLinkRequests: "client_link_requests",
  maxRequestsPerClientPerDay: "max_requests_per_client_per_day",
  maxSearchesPerDay: "max_searches_per_day",
  maxFetchesPerDay: "max_fetches_per_day",
  maxPagesPerRequest: "max_pages_per_request",
  refetchAfterDays: "refetch_after_days",
  cardExpiryDays: "card_expiry_days",
};

// Each change is an owner decision of kind research_settings, its details the change.
export async function setResearchSettings(
  admin: AdminContext,
  patch: ResearchSettingsPatch,
  options: { requestId: string },
): Promise<RulingId> {
  const parsed = ResearchSettingsPatch.safeParse(patch);
  if (!parsed.success) throw new AdminError("invalid_argument");
  const changes = Object.entries(parsed.data).filter(([, value]) => value !== undefined) as [
    keyof ResearchSettings,
    number | boolean,
  ][];
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const repeat = await repeatedDecision(query, options.requestId);
    if (repeat !== undefined) return repeat;
    for (const [key, value] of changes)
      await query(`update policy.research_settings set ${COLUMNS[key]} = $1`, [value]);
    return ownerDecision(
      query,
      { requestId: options.requestId, kind: "research_settings", details: parsed.data, compartments: OWN },
      now,
    );
  });
}
