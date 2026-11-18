import {
  type ClientView,
  type EntityId,
  type MessageId,
  RESEARCH_TEMPLATES,
  type ReadOutcome,
  type ResearchAnswer,
  type ResearchArgs,
  type ResearchRequestId,
  type ResearchSettings,
} from "@intelligence/contracts/personal";
import { filingAnswer, researchGate } from "@intelligence/personal-core/research";
import { byText } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { queryText, REQUEST_BODY, type ResearchBody, urlInText } from "../core/research.ts";
import type { SealedRow } from "../core/seal.ts";
import { sealUnder } from "../core/seal.ts";
import { served } from "../core/served.ts";

// request_research, as pi_reader in the call's one read committed transaction after the shared
// taint lock: the form and privacy checks of the gate, in code; for a link, the switch and then the
// message opened as read_message opens it; then ledger.file_research, which computes the label from
// the token and writes the request, its event and its card, or nothing. A client is told the new
// request's id and nothing else.

const FILE = `select outcome, research_id from ledger.file_research($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`;

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

type Refused = "not_permitted" | "not_found" | "rate_limited" | "invalid_request";
const REFUSALS: ReadonlySet<string> = new Set<Refused>([
  "not_permitted",
  "not_found",
  "rate_limited",
  "invalid_request",
]);

export async function fileResearch(
  ctx: Ctx,
  client: ClientView,
  args: ResearchArgs,
): Promise<ReadOutcome<ResearchAnswer>> {
  if (args.kind === "link") {
    const [settings] = await ctx.run<{ client_link_requests: boolean }>(
      "select client_link_requests from policy.research_settings",
      [],
    );
    if (settings?.client_link_requests !== true) return { ok: false, code: "not_permitted" };
  }
  // i6: the agent API has resolved any handle to its row's id before the store is called.
  const body: ResearchBody =
    args.kind === "search"
      ? { kind: "search", template: args.template, identifiers: args.identifiers, about: args.about as EntityId }
      : { kind: "link", message: args.message as MessageId, url: args.url };
  const label = [...new Set(client.compartments.filter((one) => !one.startsWith("agent:")))].sort(byText);
  const version =
    body.kind === "search" ? RESEARCH_TEMPLATES[body.template as keyof typeof RESEARCH_TEMPLATES].version : null;
  const gateBody = body.kind === "search" ? { ...body, templateVersion: version ?? 0 } : body;
  const { causes } = researchGate(
    { compartments: label, body: gateBody },
    { stage: "filing", events: [], vetoed: false, erased: false, sealed: false, settings: AT_FILING },
    new Date(0),
  );
  const refused = filingAnswer(causes);
  if (refused !== null) return { ok: false, code: refused };

  let inText = false;
  if (body.kind === "link") {
    const [row] = await ctx.run<SealedRow<"knowledge.messages.body_enc">>(
      "select id, compartments, body_enc from knowledge.messages where id = $1",
      [body.message],
    );
    inText =
      row !== undefined &&
      row.body_enc !== null &&
      urlInText(served(ctx, row, "knowledge.messages.body_enc").untrusted, body.url);
  }

  const id = newId("rsq") as ResearchRequestId;
  const session = await ctx.session();
  const fp = (kind: "name" | "domain", value: string) => fingerprint(ctx.keys, kind, value);
  const identifiers = body.kind === "search" ? body.identifiers : [];
  const [answer] = await ctx.run<{ outcome: string; research_id: ResearchRequestId | null }>(FILE, [
    session,
    id,
    args.requestId,
    newId("crd"),
    body.kind,
    body.kind === "search" ? body.template : null,
    version,
    body.kind === "search" ? body.about : null,
    identifiers.map((one) => one.kind),
    identifiers.map((one) => fp(one.kind === "domain" ? "domain" : "name", one.value)),
    body.kind === "link" ? body.message : null,
    inText,
    fingerprint(ctx.keys, "research_query", queryText(body)),
    body.kind === "link" ? fingerprint(ctx.keys, "source_id", body.url) : null,
    label,
    sealUnder(ctx.keys, label, REQUEST_BODY(id), JSON.stringify(body)),
  ]);
  if ((answer?.outcome === "ok" || answer?.outcome === "replayed") && answer.research_id !== null)
    return { ok: true, value: { request: answer.research_id, state: "pending" } };
  if (answer === undefined || !REFUSALS.has(answer.outcome)) throw new Unavailable();
  return { ok: false, code: answer.outcome as Refused };
}
