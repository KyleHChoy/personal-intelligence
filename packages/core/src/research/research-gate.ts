import { PublicIdentifier } from "@intelligence/contracts";
import {
  CodedError,
  EntityId,
  type OwnerDecisionKind,
  RESEARCH_TEMPLATES,
  ResearchArgs,
  ResearchDecisionDetails,
  type ResearchGateCause,
  type ResearchRefusal,
  type ResearchSettings,
  type ResearchState,
} from "@intelligence/contracts/personal";
import { utcDayOf } from "../days.ts";
import { canonicalUrl, idShaped, isPrivateUrl } from "./research-url.ts";

// The research gate as one pure function, with the query a search sends and the map from causes at
// filing to a client's answer. No clock, file or network: every fact is handed in by the caller, as
// plain data. Every check runs on every call and every cause is returned, as the outbound gate
// does.

type TemplateId = keyof typeof RESEARCH_TEMPLATES;
const isTemplate = (id: string): id is TemplateId => Object.hasOwn(RESEARCH_TEMPLATES, id);

// A request's closed fields as the store opens them (the store's `ResearchBody` with the row's
// template version). Every value is checked here again: a body written by an older build, or
// opened wrong, must fail the gate, not pass it. A `url` body's `privateUrl` is the owner's
// `--private-url`, which the owner's decision's details must say too.
export type ResearchBody =
  | { kind: "search"; template: string; templateVersion: number; identifiers: readonly unknown[]; about: string }
  | { kind: "link"; message: string; url: string }
  | { kind: "url"; url: string; about?: string | null; names?: readonly string[]; privateUrl?: boolean };

// The request and its label, which the database computed from the token.
export type ResearchGateRequest = { compartments: readonly string[]; body: ResearchBody };

// A request's events, oldest first, each with the owner decision it rests on, if any.
type ResearchEventName = "filed" | Exclude<ResearchState, "pending">;
export type ResearchEvent = {
  event: ResearchEventName;
  decision: { kind: OwnerDecisionKind | string; answer: string; details: unknown } | null;
};

// What the caller gathers for one request (`ledger.research_facts` at run, the filing function at
// filing). `vetoed` is the owner's veto on the `about` entity or the link message's sender;
// `erased` is a removed-evidence row for the canonical URL's source item, or an `about` entity that
// is gone; `sealed` is a seal on one of `sealCandidates(body)` (always false from
// `ledger.research_facts`, since seals are not built); `today` holds the day's egress counts and
// the UTC day they are of.
export type ResearchFacts = {
  stage: "filing" | "run";
  events: readonly ResearchEvent[];
  vetoed: boolean;
  erased: boolean;
  sealed: boolean;
  today?: { day: string; searches: number; fetches: number };
  settings: ResearchSettings;
};

export type ResearchGateOutcome = { cleared: boolean; causes: ResearchGateCause[] };

// An allow-list, so a compartment nobody thought of fails closed.
const CHANNEL_MAXIMUM: readonly string[] = ["own", "public"];

// A URL is given in its canonical form, as PageUrl makes it: anything else is no page URL.
const pageUrlOk = (url: string): boolean => canonicalUrl(url) === url;

// A search and a link take the form a client's `ResearchArgs` takes (the template known and its
// identifiers one of its combinations, each a public identifier), under a request id that is no
// part of the body. A search also names its template's current version and no id-shaped value. A
// url is the owner's: a page URL, and an entity or none.
const FORM_CHECK = "gate-form-check";
function formOk(body: ResearchBody): boolean {
  switch (body.kind) {
    case "search": {
      const parsed = ResearchArgs.safeParse({
        kind: "search",
        requestId: FORM_CHECK,
        template: body.template,
        identifiers: body.identifiers,
        about: body.about,
      });
      return (
        parsed.success &&
        parsed.data.kind === "search" &&
        body.templateVersion === RESEARCH_TEMPLATES[parsed.data.template as TemplateId].version &&
        !parsed.data.identifiers.some(idShaped)
      );
    }
    case "link":
      return (
        ResearchArgs.safeParse({ kind: "link", requestId: FORM_CHECK, message: body.message, url: body.url }).success &&
        pageUrlOk(body.url)
      );
    case "url":
      return (
        (body.about === undefined || body.about === null || EntityId.safeParse(body.about).success) &&
        pageUrlOk(body.url)
      );
  }
}

// The approval the request rests on: its latest `approved` event that rests on an owner decision of
// kind `research` answering `approve` or `typed`, when no later event ended it. A standing grant is
// not built, so nothing else is authority.
const LIVE: readonly ResearchEventName[] = ["approved", "running", "waiting"];
function approval(events: readonly ResearchEvent[]): ResearchEvent["decision"] {
  const latest = events.at(-1);
  if (latest === undefined || !LIVE.includes(latest.event)) return null;
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const one = events[at] as ResearchEvent;
    if (!LIVE.includes(one.event)) return null;
    const decision = one.decision;
    if (
      one.event === "approved" &&
      decision !== null &&
      decision.kind === "research" &&
      (decision.answer === "approve" || decision.answer === "typed")
    )
      return decision;
  }
  return null;
}

// The owner's --private-url, read from the decision that typed the request.
function privateUrlAllowed(events: readonly ResearchEvent[]): boolean {
  const decision = events.find(
    (one) => one.event === "approved" && one.decision?.kind === "research" && one.decision.answer === "typed",
  )?.decision;
  if (decision === undefined || decision === null) return false;
  const details = ResearchDecisionDetails.safeParse(decision.details);
  return details.success && details.data.privateUrl === true;
}

function privacyFails(body: ResearchBody, events: readonly ResearchEvent[]): boolean {
  if (body.kind === "link") return isPrivateUrl(body.url);
  if (body.kind === "url") return isPrivateUrl(body.url) && !(body.privateUrl === true && privateUrlAllowed(events));
  return false;
}

// A domain and each of its parent domains of two labels or more.
function withParents(host: string): string[] {
  const labels = host.split(".");
  const names: string[] = [];
  for (let at = 0; at + 2 <= labels.length; at += 1) names.push(labels.slice(at).join("."));
  return names;
}

// The names a seal on which stops this request: the URL's host, or each domain identifier, with
// every parent domain, so a seal on a domain covers its subdomains. The caller answers which of
// them the owner sealed; nothing here reads a seal.
export function sealCandidates(body: ResearchBody): string[] {
  if (body.kind === "search") {
    const domains = body.identifiers.flatMap((one) => {
      const parsed = PublicIdentifier.safeParse(one);
      return parsed.success && parsed.data.kind === "domain" ? withParents(parsed.data.value) : [];
    });
    return [...new Set(domains)];
  }
  const url = URL.parse(body.url);
  return url === null ? [] : withParents(url.hostname.toLowerCase());
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// A search request waits too when no fetch is left today, so it is not searched again tomorrow for
// pages it could not read. Counts the gate cannot trust, of another day or of no day, are a cap.
function budgetReached(body: ResearchBody, facts: ResearchFacts, now: Date): boolean {
  const today = facts.today;
  if (today === undefined || today.day !== utcDayOf(now) || !isCount(today.searches) || !isCount(today.fetches))
    return true;
  const fetchesLeft = today.fetches < facts.settings.maxFetchesPerDay;
  return body.kind === "search" ? !fetchesLeft || today.searches >= facts.settings.maxSearchesPerDay : !fetchesLeft;
}

export function researchGate(request: ResearchGateRequest, facts: ResearchFacts, now: Date): ResearchGateOutcome {
  const { body } = request;
  const atRun = facts.stage === "run";
  const failed: [ResearchGateCause, boolean][] = [
    ["no_authority", atRun && approval(facts.events) === null],
    ["bad_form", !formOk(body)],
    ["private_url", privacyFails(body, facts.events)],
    ["origin", request.compartments.length === 0 || request.compartments.some((one) => !CHANNEL_MAXIMUM.includes(one))],
    ["vetoed", facts.vetoed !== false],
    ["erased", facts.erased !== false],
    ["sealed", facts.sealed !== false],
    ["budget", atRun && budgetReached(body, facts, now)],
  ];
  const causes = failed.filter(([, fails]) => fails).map(([cause]) => cause);
  return { cleared: causes.length === 0, causes };
}

// `vetoed`, `erased` and `sealed` rest on the owner's decisions, which a client does not see, so
// they never change its answer (invariant 6): null, the answer of no cause. A bad request is the
// contract's `invalid_request`.
const ANSWERS: readonly [ResearchGateCause, ResearchRefusal][] = [
  ["bad_form", "invalid_request"],
  ["private_url", "not_permitted"],
  ["origin", "not_permitted"],
];

export const filingAnswer = (causes: readonly ResearchGateCause[]): ResearchRefusal | null =>
  ANSWERS.find(([cause]) => causes.includes(cause))?.[1] ?? null;

// Nothing about who asked or why, so the same request gives the same query whoever filed it.
export function resolveQuery(
  template: string,
  identifiers: readonly PublicIdentifier[],
): { words: string; values: string[] } {
  if (!isTemplate(template)) throw new CodedError("unknown_template");
  return { words: RESEARCH_TEMPLATES[template].words, values: identifiers.map((one) => one.value) };
}
